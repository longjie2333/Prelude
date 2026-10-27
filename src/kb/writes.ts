/**
 * What a run wrote to the knowledge base, as the audit recorded it (plan M2-8). The retro section
 * of the report is checked against this, not against the model's own account.
 */
import { readAudit } from "../audit.ts";

export interface KbWriteRecord {
	kind: "category" | "lesson_add" | "lesson_revise" | "tool";
	category: string;
	/** Category name, lesson id, or tool name: what the retro must mention. */
	subject: string;
	/** For lesson revisions: counterexample, guidance, evidence, retire. */
	revision?: string;
}

export function isKbWriteRecord(x: unknown): x is KbWriteRecord {
	const r = x as Partial<KbWriteRecord> | undefined;
	return typeof r?.kind === "string" && typeof r.category === "string" && typeof r.subject === "string";
}

/** kb_write events of one run, in order. */
export function kbWritesOf(auditFile: string, runId: string): KbWriteRecord[] {
	return readAudit(auditFile)
		.filter((e) => e.event === "kb_write" && e.run === runId)
		.map((e) => e.detail?.write)
		.filter(isKbWriteRecord);
}
