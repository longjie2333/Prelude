/**
 * Hash-chained audit log (plan M1-9, D-8). Each line carries the sha256 of the previous line, so
 * an edit or deletion anywhere breaks the chain from that point on. Inputs are recorded as
 * digests only.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso, sha256 } from "./util.ts";

export const GENESIS = "0".repeat(64);

export interface AuditEvent {
	event: string;
	tool?: string;
	decision?: string;
	reason?: string;
	inputDigest?: string;
	run?: string;
	finding?: string;
	detail?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEvent {
	at: string;
	prev: string;
}

/** Last line of the file, read from the tail so long logs stay cheap to append to. */
function lastLine(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		let chunk = 4096;
		for (;;) {
			const start = Math.max(0, size - chunk);
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			const lines = buf.toString("utf8").split("\n").filter(Boolean);
			if (lines.length > 1 || start === 0) return lines.at(-1);
			chunk *= 4;
		}
	} finally {
		closeSync(fd);
	}
}

export function appendAudit(path: string, event: AuditEvent): AuditRecord {
	mkdirSync(dirname(path), { recursive: true });
	const last = lastLine(path);
	const record: AuditRecord = { at: nowIso(), prev: last ? sha256(last) : GENESIS, ...event };
	appendFileSync(path, `${JSON.stringify(record)}\n`);
	return record;
}

export interface AuditCheck {
	ok: boolean;
	lines: number;
	/** 1-based line where the chain first breaks. */
	brokenAt?: number;
}

export function verifyAudit(path: string): AuditCheck {
	if (!existsSync(path)) return { ok: true, lines: 0 };
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	let prev = GENESIS;
	for (let i = 0; i < lines.length; i++) {
		let rec: AuditRecord;
		try {
			rec = JSON.parse(lines[i]) as AuditRecord;
		} catch {
			return { ok: false, lines: lines.length, brokenAt: i + 1 };
		}
		if (rec.prev !== prev) return { ok: false, lines: lines.length, brokenAt: i + 1 };
		prev = sha256(lines[i]);
	}
	return { ok: true, lines: lines.length };
}

export function readAudit(path: string): AuditRecord[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as AuditRecord);
}
