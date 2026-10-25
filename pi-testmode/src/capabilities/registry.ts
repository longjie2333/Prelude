/**
 * Capability registry (agent-core §9.2, §9.4; plan M2-6): providers are identified by content
 * hash, and the hash is recomputed before every use. A mismatch blocks the use, quarantines the
 * provider, and is audited (M2 acceptance 4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getProvider, listProviders, type ProviderRow, setProviderTrust } from "../knowledge/store.ts";
import type { Store } from "../store/db.ts";
import { audit } from "../store/repos.ts";
import type { Actor } from "../types.ts";
import { sha256 } from "../util.ts";

export interface CapabilityBinding {
	capId: string;
	sha256: string;
	kind: ProviderRow["kind"];
	name: string;
	version: string;
	path?: string;
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...listFiles(p));
		else if (st.isFile()) out.push(p);
	}
	return out;
}

/** Content hash of a directory: sorted relative paths with the hash of each file. */
export function hashDirectory(dir: string): string {
	const parts = listFiles(dir).map((f) => `${relative(dir, f).replaceAll("\\", "/")}\0${sha256(readFileSync(f))}`);
	return sha256(parts.join("\n"));
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };

export function verifyBinding(b: CapabilityBinding): BindingCheck {
	if (b.kind !== "skill" || !b.path) return { ok: true };
	try {
		const now = hashDirectory(b.path);
		return now === b.sha256 ? { ok: true } : { ok: false, reason: `content hash changed (${b.sha256.slice(0, 8)} → ${now.slice(0, 8)})` };
	} catch (err) {
		return { ok: false, reason: `provider files unreadable: ${(err as Error).message}` };
	}
}

/** Blocks a provider whose content changed: quarantine and audit. */
export function quarantineProvider(s: Store, sha: string, actor: Actor, reason: string): void {
	s.tx(() => {
		setProviderTrust(s, sha, "quarantined");
		audit(s, { actor, event: "provider_hash_mismatch", decision: "block", reason: `${sha.slice(0, 12)}: ${reason}` });
	});
}

export interface Resolution {
	bindings: CapabilityBinding[];
	missing: string[];
	mismatched: Array<{ capId: string; sha256: string; reason: string }>;
}

/** Picks the best verified/pinned provider per capability, rechecking its hash first. */
export function resolveCapabilities(s: Store, capIds: readonly string[], actor: Actor): Resolution {
	const r: Resolution = { bindings: [], missing: [], mismatched: [] };
	for (const capId of [...new Set(capIds)]) {
		const candidates = listProviders(s, { capId, trust: ["pinned", "verified"] }).sort(
			(a, b) => (b.trust === "pinned" ? 1 : 0) - (a.trust === "pinned" ? 1 : 0) || (b.conformanceScore ?? 0) - (a.conformanceScore ?? 0),
		);
		let bound: CapabilityBinding | undefined;
		for (const p of candidates) {
			const binding: CapabilityBinding = { capId, sha256: p.sha256, kind: p.kind, name: p.name, version: p.version, path: p.location.path };
			const check = verifyBinding(binding);
			if (check.ok) {
				bound = binding;
				break;
			}
			quarantineProvider(s, p.sha256, actor, check.reason);
			r.mismatched.push({ capId, sha256: p.sha256, reason: check.reason });
		}
		if (bound) r.bindings.push(bound);
		else if (!r.mismatched.some((m) => m.capId === capId)) r.missing.push(capId);
	}
	return r;
}

export function bindingOf(s: Store, sha: string, capId: string): CapabilityBinding | undefined {
	const p = getProvider(s, sha);
	return p ? { capId, sha256: p.sha256, kind: p.kind, name: p.name, version: p.version, path: p.location.path } : undefined;
}
