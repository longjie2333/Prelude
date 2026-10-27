/**
 * `report_finalize` (plan M1-8): checks the report skeleton and that its verified-defect list
 * matches findings.jsonl, registers the report, and runs the end checks (system notes reminder;
 * knowledge-base sync joins in M2-3).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Prelude } from "./context.ts";
import { canonicalPath, isInside } from "./guard/paths.ts";
import { lessonExists } from "./kb/lessons.ts";
import { type KbWriteRecord, kbWritesOf } from "./kb/writes.ts";
import { updateDisplay } from "./progress.ts";
import type { Finding, Run } from "./run.ts";
import { nowIso, textResult } from "./util.ts";

/** Required sections and the headings accepted for each (design §4 step 7, plan M1-8). */
export const SECTIONS = {
	conclusion: ["结论", "Conclusion", "Summary"],
	defects: ["已复验缺陷", "Verified defects", "Confirmed defects"],
	suggestions: ["建议", "Suggestions"],
	unreproduced: ["未复现项", "Not reproduced", "Unreproduced"],
	tested: ["测了什么", "What was tested", "Tested"],
	untested: ["没测什么", "What was not tested", "Not tested"],
	isolation: ["隔离级别", "Isolation"],
	retro: ["复盘", "Retrospective", "Retro"],
} as const;
/** Sections every report needs; 复盘 is only required once a knowledge base exists (M2-8). */
const BASE_SECTIONS: SectionKey[] = [
	"conclusion",
	"defects",
	"suggestions",
	"unreproduced",
	"tested",
	"untested",
	"isolation",
];
export type SectionKey = keyof typeof SECTIONS;

const FINDING_ID = /\bf-\d{3}\b/g;

function normalize(heading: string): string {
	return heading
		.replace(/^[\s\d.、:：\-)）(（]+/, "")
		.trim()
		.toLowerCase();
}

/** Body of each heading (any level), up to the next heading of the same or a higher level. */
export function parseSections(markdown: string): Map<SectionKey, string> {
	const lines = markdown.split(/\r?\n/);
	const heads: Array<{ line: number; level: number; text: string }> = [];
	let fence = false;
	lines.forEach((l, i) => {
		if (/^\s*(```|~~~)/.test(l)) fence = !fence;
		const m = !fence && l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (m) heads.push({ line: i, level: m[1].length, text: m[2] });
	});
	const out = new Map<SectionKey, string>();
	heads.forEach((h, i) => {
		const n = normalize(h.text);
		const key = (Object.keys(SECTIONS) as SectionKey[]).find((k) =>
			SECTIONS[k].some((name) => n.startsWith(name.toLowerCase())),
		);
		if (!key || out.has(key)) return;
		const next = heads.slice(i + 1).find((x) => x.level <= h.level);
		out.set(key, lines.slice(h.line + 1, next ? next.line : lines.length).join("\n"));
	});
	return out;
}

const ids = (text: string | undefined) => new Set(text?.match(FINDING_ID) ?? []);

export interface ReportCheck {
	problems: string[];
	defects: string[];
	suggestions: string[];
	unreproduced: string[];
}

export interface RetroCheck {
	/** Knowledge-base writes of this run, from the audit (not from the model). */
	writes: KbWriteRecord[];
	lessonExists(id: string): boolean;
}

const LESSON_ID = /\bles-[0-9a-f]{4}\b/g;

/** Whether `text` names `subject` as a whole token (so `race-probe` is not found in `race-probe-v2`). */
function mentions(text: string, subject: string): boolean {
	const esc = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(text);
}

/**
 * The 复盘 section against the audited writes (M2-8): every write is named by its id or name, every
 * lesson id named exists, and "nothing to keep" is only claimed when nothing was written.
 */
export function retroProblems(text: string, retro: RetroCheck): string[] {
	const problems: string[] = [];
	const nothing = /无可沉淀|nothing to (record|keep)/i.test(text);
	if (retro.writes.length === 0) {
		if (!nothing)
			problems.push(
				"no knowledge-base write in this test: record lessons or tools with kb_* first, or write 无可沉淀 and why under 复盘",
			);
	} else if (nothing) {
		problems.push(`复盘 says 无可沉淀, but this test wrote ${retro.writes.length} knowledge-base change(s)`);
	}
	const label: Record<KbWriteRecord["kind"], string> = {
		category: "category",
		lesson_add: "new lesson",
		lesson_revise: "revised lesson",
		tool: "tool",
	};
	const missing = new Set<string>();
	for (const w of retro.writes) {
		if (!mentions(text, w.subject)) missing.add(`${label[w.kind]} ${w.subject} (${w.category})`);
	}
	for (const m of missing) problems.push(`复盘 does not mention ${m}, which this test wrote`);
	const written = new Set(retro.writes.map((w) => w.subject));
	for (const id of new Set(text.match(LESSON_ID) ?? [])) {
		if (!written.has(id) && !retro.lessonExists(id))
			problems.push(`复盘 names lesson ${id}, which does not exist in the knowledge base`);
	}
	return problems;
}

/** Everything wrong with the report, so the model can fix it in one pass. */
export function checkReport(
	markdown: string,
	findings: Finding[],
	platform = process.platform,
	retro?: RetroCheck,
): ReportCheck {
	const sections = parseSections(markdown);
	const problems: string[] = [];
	for (const key of retro ? [...BASE_SECTIONS, "retro" as const] : BASE_SECTIONS) {
		if (!sections.has(key)) problems.push(`missing section: ${SECTIONS[key][0]}`);
	}
	if (retro && sections.has("retro")) problems.push(...retroProblems(sections.get("retro") ?? "", retro));
	const unverified = findings.filter((f) => !f.verification);
	if (unverified.length)
		problems.push(`not verified yet: ${unverified.map((f) => f.id).join(", ")}; call verify_findings`);

	const confirmed = (kind: Finding["kind"]) =>
		findings.filter((f) => f.kind === kind && f.verification?.verdict === "confirmed").map((f) => f.id);
	const defects = confirmed("defect");
	const suggestions = confirmed("suggestion");
	const unreproduced = findings
		.filter((f) => f.verification && f.verification.verdict !== "confirmed")
		.map((f) => f.id);

	const inDefects = ids(sections.get("defects"));
	for (const id of defects)
		if (!inDefects.has(id)) problems.push(`${id} is a verified defect but not under 已复验缺陷`);
	for (const id of inDefects)
		if (!defects.includes(id)) problems.push(`${id} is under 已复验缺陷 but is not a confirmed defect`);
	const inSuggestions = ids(sections.get("suggestions"));
	for (const id of suggestions)
		if (!inSuggestions.has(id)) problems.push(`${id} is a confirmed suggestion but not under 建议`);
	const inUnreproduced = ids(sections.get("unreproduced"));
	for (const id of unreproduced)
		if (!inUnreproduced.has(id)) problems.push(`${id} was rejected or not reproduced but is not under 未复现项`);

	const isolation = sections.get("isolation") ?? "";
	if (sections.has("isolation") && platform === "win32" && !/仅工具层|tool[- ]layer only/i.test(isolation))
		problems.push(
			"on Windows the isolation section must say 仅工具层策略 (tool-layer policy only, not a security boundary)",
		);
	return { problems, defects, suggestions, unreproduced };
}

function newestMtime(dir: string): number {
	if (!existsSync(dir)) return 0;
	let newest = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
	}
	return newest;
}

function reportFile(run: Run, path: string): string {
	const abs = isAbsolute(path) ? path : resolve(run.project.root, path);
	const c = (p: string) => canonicalPath(p, run.project.root);
	if (!isInside(c(abs), c(run.project.reportsDir))) throw new Error("the report must be under .prelude/reports/");
	if (extname(abs).toLowerCase() !== ".md") throw new Error("the report must be a Markdown file");
	if (!existsSync(abs)) throw new Error(`report not found: ${path}`);
	return abs;
}

export function createReportFinalizeTool(prelude: Prelude) {
	return defineTool({
		name: "report_finalize",
		label: "Finalize report",
		description: `Check and register the report of the running Prelude test. The report (Markdown under .prelude/reports/) needs these sections: ${BASE_SECTIONS.map((k) => SECTIONS[k][0]).join("、")}, and 复盘 when a knowledge base exists: it must name every kb_* write of this test by its id or name (category, les-xxxx, tool), as checked against the audit, or say 无可沉淀 with the reason when there were none. Finding ids (f-001) must appear in the section matching their verdict. On problems the call fails with the full list; fix the report and call again.`,
		promptSnippet: "Check and register the test report",
		promptGuidelines: [
			"Call report_finalize last: after verify_findings, after writing the report file, and after the retro (kb_* writes).",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Report path, e.g. .prelude/reports/2026-10-27-order.md" }),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			const run = prelude.run();
			const abs = reportFile(run, params.path);
			const kb = prelude.kb();
			const retro = kb
				? {
						writes: kbWritesOf(run.project.auditFile, run.id),
						lessonExists: (id: string) => lessonExists(kb.dir, id),
					}
				: undefined;
			const check = checkReport(readFileSync(abs, "utf8"), run.findings(), process.platform, retro);
			if (check.problems.length) throw new Error(`report not accepted:\n- ${check.problems.join("\n- ")}`);

			const relPath = relative(run.project.root, abs).replace(/\\/g, "/");
			const state = run.updateState((s) => {
				s.report = { path: relPath, at: nowIso() };
				s.phase = "report";
			});
			prelude.audit({ event: "report", detail: { path: relPath, defects: check.defects } });
			updateDisplay(prelude);

			const notes: string[] = [];
			if (!state.notesReminded && newestMtime(run.project.notesDir) < Date.parse(state.startedAt)) {
				run.updateState((s) => {
					s.notesReminded = true;
				});
				notes.push(
					"System notes were not updated during this test: record what you learned about this system in .prelude/notes/ (see AGENTS.md).",
				);
			}
			const summary = [
				`Report registered: ${relPath}`,
				`Verified defects: ${check.defects.join(", ") || "none"}; suggestions: ${check.suggestions.join(", ") || "none"}; not reproduced: ${check.unreproduced.join(", ") || "none"}.`,
				...notes,
			];
			return textResult(summary.join("\n"), { path: relPath, ...check });
		},
	});
}
