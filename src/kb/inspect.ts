/**
 * `/prelude-kb` (plan M3-6): every category's lessons with status, plus the two things that need
 * tidying: lessons nothing has backed for a long time, and lessons that look like duplicates.
 * Read-only; tidying goes through kb_lesson_revise.
 */
import { type Lesson, listCategories, listLessons } from "./lessons.ts";
import { listTools } from "./render.ts";

export const STALE_DAYS = 90;
export const DUPLICATE_SIMILARITY = 0.6;

/** Date of the latest evidence or revision. */
export function lastActivity(l: Lesson): string {
	const dates = [...l.evidence.map((e) => e.at), ...l.revisions.map((r) => r.at)].map((d) => d.slice(0, 10));
	return dates.sort().at(-1) ?? "";
}

function bigrams(text: string): Set<string> {
	const s = text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
	const out = new Set<string>();
	for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
	return out;
}

/** Jaccard similarity of character bigrams; works for Chinese and English titles alike. */
export function similarity(a: string, b: string): number {
	const x = bigrams(a);
	const y = bigrams(b);
	if (x.size === 0 || y.size === 0) return 0;
	let both = 0;
	for (const g of x) if (y.has(g)) both++;
	return both / (x.size + y.size - both);
}

export interface KbOverview {
	text: string;
	stale: string[];
	duplicates: Array<[string, string]>;
}

export function overview(kbDir: string, now = new Date()): KbOverview {
	const cutoff = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
	const lines: string[] = [];
	const stale: string[] = [];
	const duplicates: Array<[string, string]> = [];
	const categories = listCategories(kbDir);
	if (categories.length === 0) return { text: "Knowledge base has no categories yet.", stale, duplicates };
	for (const c of categories) {
		const lessons = listLessons(kbDir, c.name);
		const live = lessons.filter((l) => l.status !== "retired");
		const tools = listTools(kbDir, c.name);
		lines.push(`${c.name} (${c.dimension}) — ${live.length} lesson(s), ${tools.length} tool(s)`);
		for (const l of lessons) {
			const projects = new Set(l.evidence.map((e) => e.project)).size;
			const last = lastActivity(l);
			const isStale = l.status !== "retired" && last < cutoff;
			if (isStale) stale.push(`${c.name}/${l.id}`);
			lines.push(
				`  ${l.id} [${l.status}] ${l.title} — ${projects} project(s), last ${last || "never"}${isStale ? " (stale)" : ""}`,
			);
		}
		for (let i = 0; i < live.length; i++)
			for (let j = i + 1; j < live.length; j++) {
				const a = live[i];
				const b = live[j];
				if (similarity(`${a.title} ${a.applies_when}`, `${b.title} ${b.applies_when}`) >= DUPLICATE_SIMILARITY)
					duplicates.push([`${c.name}/${a.id}`, `${c.name}/${b.id}`]);
			}
	}
	if (stale.length) lines.push("", `Not backed for ${STALE_DAYS}+ days: ${stale.join(", ")}`);
	if (duplicates.length)
		lines.push("", `Possible duplicates: ${duplicates.map(([a, b]) => `${a} ≈ ${b}`).join("; ")}`);
	if (stale.length || duplicates.length)
		lines.push("Tidy them during a test with kb_lesson_revise (counterexample to narrow, retire with a reason).");
	return { text: lines.join("\n"), stale, duplicates };
}
