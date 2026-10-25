/**
 * Content-addressed evidence (plan M1-14 §8): write to a temp file, rename to `<sha256>`, then
 * register in SQLite. A crash between rename and register leaves an orphan file that
 * `sweepOrphanEvidence` removes on the next startup.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/db.ts";
import { evidenceShas, insertEvidence } from "../store/repos.ts";
import { sha256 } from "../util.ts";

const TMP_PREFIX = ".tmp-";

export interface EvidenceRef {
	sha256: string;
	path: string;
	bytes: number;
}

export function putEvidence(
	store: Store,
	evidenceDir: string,
	data: string | Uint8Array,
	meta: { missionId: string | null; kind: string },
): EvidenceRef {
	mkdirSync(evidenceDir, { recursive: true });
	const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	const hash = sha256(buf);
	const finalPath = join(evidenceDir, hash);
	if (!existsSync(finalPath)) {
		const tmp = join(evidenceDir, `${TMP_PREFIX}${process.pid}-${hash.slice(0, 12)}-${Date.now()}`);
		writeFileSync(tmp, buf);
		renameSync(tmp, finalPath);
	}
	insertEvidence(store, { sha256: hash, missionId: meta.missionId, kind: meta.kind, path: finalPath, bytes: buf.length });
	return { sha256: hash, path: finalPath, bytes: buf.length };
}

export function readEvidence(evidenceDir: string, hash: string): Buffer | undefined {
	if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
	const p = join(evidenceDir, hash);
	return existsSync(p) ? readFileSync(p) : undefined;
}

export function evidenceUri(hash: string): string {
	return `ev://${hash}`;
}

/** Removes temp files and content files with no registry row. Returns the number removed. */
export function sweepOrphanEvidence(store: Store, evidenceDir: string, minAgeMs = 60_000): number {
	if (!existsSync(evidenceDir)) return 0;
	const known = evidenceShas(store);
	const now = Date.now();
	let removed = 0;
	for (const name of readdirSync(evidenceDir)) {
		const p = join(evidenceDir, name);
		const isTmp = name.startsWith(TMP_PREFIX);
		const isContent = /^[0-9a-f]{64}$/.test(name);
		if (!isTmp && !(isContent && !known.has(name))) continue;
		try {
			if (now - statSync(p).mtimeMs < minAgeMs) continue;
			rmSync(p, { force: true });
			removed++;
		} catch {
			// best effort
		}
	}
	return removed;
}
