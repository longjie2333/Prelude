import { createHash, randomBytes } from "node:crypto";

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

/** `<prefix>-YYYYMMDD-<6 hex>`, sortable by day and unique enough for one project. */
export function newId(prefix: string): string {
	const d = new Date();
	const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	return `${prefix}-${day}-${randomBytes(3).toString("hex")}`;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function textResult<T>(text: string, details: T, extra?: { terminate?: boolean; isError?: boolean }) {
	return { content: [{ type: "text" as const, text }], details, ...extra };
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}
