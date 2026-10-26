/**
 * Authorization scope (design §9, plan M1-5), adapted from pi-testmode src/kernel/scope.ts
 * (commit f5d01c7). `scope.json` is human-maintained: the model can never write it; code adds a
 * target only after the user approved it in a dialog (D-11).
 */
import { existsSync, readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { writeJson } from "../util.ts";

export const TEST_KINDS = ["functional", "load", "security-check", "destructive"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const ScopeSchema = Type.Object({
	project: Type.Optional(Type.String()),
	targets: Type.Array(
		Type.Object({
			/** `host` or `host:port`; a leading `*.` matches subdomains. */
			host: Type.String({ minLength: 1 }),
			envs: Type.Optional(Type.Array(Type.String())),
			allowed: Type.Array(StringEnum(TEST_KINDS)),
		}),
	),
	limits: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	data: Type.Optional(Type.Object({ policy: Type.String() })),
	egress_allowlist: Type.Optional(Type.Array(Type.String())),
});
export type Scope = Static<typeof ScopeSchema>;

export interface ScopeLoad {
	scope?: Scope;
	/** Set when the file exists but is invalid; an invalid scope is treated as missing. */
	error?: string;
}

export function parseScope(raw: unknown): ScopeLoad {
	if (!Value.Check(ScopeSchema, raw)) {
		const first = [...Value.Errors(ScopeSchema, raw)][0];
		return { error: `scope.json invalid at ${first?.instancePath || "/"}: ${first?.message ?? "schema mismatch"}` };
	}
	return { scope: raw };
}

export function loadScope(path: string): ScopeLoad {
	if (!existsSync(path)) return {};
	try {
		return parseScope(JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		return { error: `scope.json unreadable: ${(err as Error).message}` };
	}
}

/** Adds a user-approved target (D-11). Refuses to overwrite a file that does not parse. */
export function addScopeTarget(path: string, host: string, allowed: TestKind[] = ["functional"]): Scope {
	const loaded = loadScope(path);
	if (loaded.error) throw new Error(`${loaded.error}; fix it by hand before adding targets`);
	const scope: Scope = loaded.scope ?? { targets: [] };
	if (!scope.targets.some((t) => t.host === host)) scope.targets.push({ host, allowed });
	writeJson(path, scope);
	return scope;
}

/** Extracts `host` and optional port from a URL, `host:port`, or bare host. */
export function parseHost(target: string): { host: string; port?: string } | undefined {
	const t = target.trim();
	if (!t) return undefined;
	try {
		const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
		if (!u.hostname) return undefined;
		return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: u.port || undefined };
	} catch {
		return undefined;
	}
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function sameHost(a: string, b: string): boolean {
	return a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));
}

function hostPatternMatches(pattern: string, target: { host: string; port?: string }): boolean {
	const wildcard = pattern.startsWith("*.");
	const p = parseHost(wildcard ? pattern.slice(2) : pattern);
	if (!p) return false;
	const hostOk = wildcard
		? target.host === p.host || target.host.endsWith(`.${p.host}`)
		: sameHost(target.host, p.host);
	return hostOk && (!p.port || p.port === target.port);
}

export function findScopeTarget(scope: Scope | undefined, target: string): Scope["targets"][number] | undefined {
	const t = parseHost(target);
	if (!scope || !t) return undefined;
	return scope.targets.find((st) => hostPatternMatches(st.host, t));
}

/** Hosts the model may reach: scope targets plus the egress allowlist. */
export function isHostAllowed(scope: Scope | undefined, target: string): boolean {
	const t = parseHost(target);
	if (!scope || !t) return false;
	return (
		scope.targets.some((st) => hostPatternMatches(st.host, t)) ||
		(scope.egress_allowlist ?? []).some((h) => hostPatternMatches(h, t))
	);
}
