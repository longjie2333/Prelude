/** Small shared helpers: hashing, ids, atomic JSON files, tool results. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Stable digest of any JSON-compatible value (keys sorted), used wherever raw input must not be stored. */
export function digest(value: unknown): string {
	return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

/** `run-YYYYMMDD-HHMM-<4 hex>`: sortable by start time, unique enough for one project. */
export function newRunId(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomHex(2)}`;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function textResult<T>(text: string, details: T) {
	return { content: [{ type: "text" as const, text }], details };
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write via a temp file and rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomHex(3)}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as T);
}

export function writeJsonl(path: string, rows: unknown[]): void {
	writeFileAtomic(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}
