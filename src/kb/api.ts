/**
 * Knowledge-base write tools (plan M2-5, M2-6, design §5): kb_category_add, kb_lesson_add,
 * kb_lesson_revise, kb_tool_add. The model never writes the knowledge base itself (P6); evidence
 * must cite findings of this run that verification confirmed, and the project id comes from
 * `.prelude/project.json`, never from the model (D-5).
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Prelude } from "../context.ts";
import { canonicalPath, isInside } from "../guard/paths.ts";
import { readProject } from "../init.ts";
import type { Run } from "../run.ts";
import { nowIso, textResult } from "../util.ts";
import {
	addCategory,
	addLesson,
	categoryDir,
	DIMENSIONS,
	type Evidence,
	type Lesson,
	REVISION_KINDS,
	requireCategory,
	reviseLesson,
} from "./lessons.ts";
import { runSelfcheck, TOOL_NAME, toolProblems } from "./tools.ts";
import type { KbWriteRecord } from "./writes.ts";

interface Source {
	run: Run;
	project: string;
	report: string;
}

/** Project and report every knowledge write is attributed to. */
function source(prelude: Prelude, reportPath: string): Source {
	const run = prelude.run();
	const project = readProject(run.project)?.id;
	if (!project) throw new Error("project.json is missing; run /prelude-init");
	const abs = isAbsolute(reportPath) ? reportPath : resolve(run.project.root, reportPath);
	const c = (p: string) => canonicalPath(p, run.project.root);
	if (!existsSync(abs) || !isInside(c(abs), c(run.project.reportsDir)))
		throw new Error("report must be this test's report file under .prelude/reports/; write it first");
	return { run, project, report: relative(run.project.root, abs).replace(/\\/g, "/") };
}

/** Evidence entries for findings of this run; each must have been confirmed by verify_findings. */
function evidenceFor(s: Source, findings: string[]): Evidence[] {
	if (findings.length === 0) throw new Error("cite at least one finding of this test as evidence");
	return findings.map((id) => {
		const f = s.run.finding(id);
		if (f.verification?.verdict !== "confirmed")
			throw new Error(`${id} is ${f.verification?.verdict ?? "unverified"}; only confirmed findings are evidence`);
		return { project: s.project, report: s.report, finding: id, at: nowIso().slice(0, 10) };
	});
}

/**
 * The tool directory: absolute, relative to the project root, or (as a real run passed it) a bare
 * name under `.prelude/work/`.
 */
export function toolSource(run: Run, source: string): string {
	if (isAbsolute(source)) return source;
	const fromRoot = resolve(run.project.root, source);
	const fromWork = resolve(run.project.workDir, source);
	return !existsSync(fromRoot) && existsSync(fromWork) ? fromWork : fromRoot;
}

function message(action: string, s: Source, summary: string): string {
	return `kb: ${action}\n\nProject: ${s.project}\nReport: ${s.report}\nRun: ${s.run.id}\n\n${summary}`;
}

/** One knowledge write; `change` returns what it wrote, which the audit records for the retro check. */
async function kbWrite(prelude: Prelude, s: Source, action: string, summary: string, change: () => KbWriteRecord) {
	const kb = prelude.requireKb();
	let write: KbWriteRecord | undefined;
	await kb.write(message(action, s, summary), () => {
		write = change();
	});
	s.run.updateState((st) => {
		st.kbWrites = (st.kbWrites ?? 0) + 1;
	});
	prelude.audit({ event: "kb_write", detail: { action, write } });
}

function lessonText(l: Lesson): string {
	return `${l.id} (${l.status}, evidence from ${new Set(l.evidence.map((e) => e.project)).size} project(s))`;
}

const report = Type.String({ description: "This test's report, e.g. .prelude/reports/2026-10-27-orders.md" });

export function createKbTools(prelude: Prelude) {
	const categoryAdd = defineTool({
		name: "kb_category_add",
		label: "Add KB category",
		description:
			"Create a knowledge-base category: one dimension (platform, interface, domain, stack) and a description of the systems it covers. Categories combine; only add one when no existing category fits.",
		promptGuidelines: ["Use kb_category_add only after checking the listed knowledge-base categories."],
		parameters: Type.Object({
			name: Type.String({ description: "lowercase-with-hyphens, e.g. rest-api, ecommerce" }),
			dimension: StringEnum(DIMENSIONS),
			description: Type.String({ minLength: 1, maxLength: 400, description: "Which systems it covers" }),
			report,
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, p) {
			const s = source(prelude, p.report);
			await kbWrite(prelude, s, `add category ${p.name}`, p.description, () => {
				addCategory(prelude.requireKb().dir, { name: p.name, dimension: p.dimension, description: p.description });
				return { kind: "category", category: p.name, subject: p.name };
			});
			return textResult(`Category ${p.name} created.`, { name: p.name });
		},
	});

	const lessonAdd = defineTool({
		name: "kb_lesson_add",
		label: "Add KB lesson",
		description:
			"Add a lesson to a knowledge-base category: when it applies, what to do, and the confirmed findings of this test that support it. It starts as a candidate; it is confirmed automatically once evidence from a second project arrives.",
		promptGuidelines: [
			"Use kb_lesson_add for knowledge that holds for a class of systems, not for facts about this system (those go to .prelude/notes/).",
			"Before kb_lesson_add, read the category's SKILL.md: if a lesson already covers it, use kb_lesson_revise instead.",
		],
		parameters: Type.Object({
			category: Type.String(),
			title: Type.String({ minLength: 1 }),
			applies_when: Type.String({ minLength: 1, description: "The condition under which the lesson applies" }),
			not_applies_when: Type.Optional(Type.Array(Type.String())),
			guidance: Type.String({ minLength: 1, description: "What to do, concretely enough to act on" }),
			findings: Type.Array(Type.String(), { description: "Confirmed finding ids of this test, e.g. f-001" }),
			report,
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, p) {
			const s = source(prelude, p.report);
			const evidence = evidenceFor(s, p.findings);
			const dir = prelude.requireKb().dir;
			requireCategory(dir, p.category);
			let lesson: Lesson | undefined;
			await kbWrite(prelude, s, `add lesson to ${p.category}`, p.title, () => {
				const added = addLesson(dir, p.category, p, evidence);
				lesson = added;
				return { kind: "lesson_add", category: p.category, subject: added.id };
			});
			return textResult(`Added ${lesson ? lessonText(lesson) : "lesson"} to ${p.category}.`, { id: lesson?.id });
		},
	});

	const lessonRevise = defineTool({
		name: "kb_lesson_revise",
		label: "Revise KB lesson",
		description:
			"Revise a knowledge-base lesson. counterexample: it did not hold here, add when it does not apply. guidance: improve what to do (needs a confirmed finding). evidence: it held again here (needs a confirmed finding); evidence from a second project confirms it. retire: it is wrong everywhere. The replaced text is kept.",
		promptGuidelines: [
			"When a lesson misled you, call kb_lesson_revise with kind counterexample: the lesson was used in the wrong place, so narrow it instead of retiring it.",
			"When a lesson held again in this test, call kb_lesson_revise with kind evidence.",
		],
		parameters: Type.Object({
			category: Type.String(),
			id: Type.String({ description: "Lesson id, e.g. les-7f3a" }),
			kind: StringEnum(REVISION_KINDS),
			reason: Type.String({ minLength: 1 }),
			not_applies_when: Type.Optional(Type.String({ description: "For counterexample" })),
			guidance: Type.Optional(Type.String({ description: "For guidance" })),
			finding: Type.Optional(
				Type.String({ description: "Confirmed finding of this test; required for guidance and evidence" }),
			),
			report,
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, p) {
			const s = source(prelude, p.report);
			const dir = prelude.requireKb().dir;
			const ev = p.finding ? evidenceFor(s, [p.finding])[0] : undefined;
			let change: Parameters<typeof reviseLesson>[4];
			if (p.kind === "counterexample") {
				if (!p.not_applies_when) throw new Error("counterexample needs not_applies_when");
				change = { kind: "counterexample", reason: p.reason, not_applies_when: p.not_applies_when };
			} else if (p.kind === "guidance") {
				if (!p.guidance || !ev) throw new Error("guidance needs the new guidance and a confirmed finding");
				change = { kind: "guidance", reason: p.reason, guidance: p.guidance };
			} else if (p.kind === "evidence") {
				if (!ev) throw new Error("evidence needs a confirmed finding of this test");
				change = { kind: "evidence", reason: p.reason, evidence: ev };
			} else change = { kind: "retire", reason: p.reason };
			let lesson: Lesson | undefined;
			await kbWrite(prelude, s, `revise ${p.id} (${p.kind})`, p.reason, () => {
				lesson = reviseLesson(dir, p.category, p.id, s.project, change);
				// A guidance change backed by new evidence also counts as evidence.
				if (
					p.kind === "guidance" &&
					ev &&
					!lesson.evidence.some((e) => e.project === ev.project && e.finding === ev.finding)
				)
					lesson = reviseLesson(dir, p.category, p.id, s.project, {
						kind: "evidence",
						reason: p.reason,
						evidence: ev,
					});
				return { kind: "lesson_revise", category: p.category, subject: p.id, revision: p.kind };
			});
			return textResult(`Revised ${lesson ? lessonText(lesson) : p.id}.`, { id: p.id, status: lesson?.status });
		},
	});

	const toolAdd = defineTool({
		name: "kb_tool_add",
		label: "Add KB tool",
		description:
			"Add a tool you wrote and used in .prelude/work/<dir>/ to a knowledge-base category. The directory needs README.md (usage and known failures) and selfcheck.<ext> (exit 0 = works); the selfcheck runs in a fresh copy (120 s) before anything is copied. Re-adding a name replaces that tool.",
		promptGuidelines: [
			"Use kb_tool_add only for a tool that worked in this test and will help on other systems of the category.",
		],
		parameters: Type.Object({
			category: Type.String(),
			name: Type.String({ description: "lowercase-with-hyphens" }),
			source: Type.String({ description: "Directory under .prelude/work/" }),
			report,
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, p, signal) {
			const s = source(prelude, p.report);
			const kbDir = prelude.requireKb().dir;
			requireCategory(kbDir, p.category);
			if (!TOOL_NAME.test(p.name)) throw new Error("tool name: lowercase letters, digits and single hyphens");
			const src = toolSource(s.run, p.source);
			const c = (x: string) => canonicalPath(x, s.run.project.root);
			if (!isInside(c(src), c(s.run.project.workDir)))
				throw new Error("the tool must be a directory under .prelude/work/");
			const problems = toolProblems(src);
			if (problems.length) throw new Error(`tool not accepted:\n- ${problems.join("\n- ")}`);
			const check = await runSelfcheck(src, 120_000, signal);
			if (!check.ok) throw new Error(`selfcheck failed:\n${check.output}`);
			const dest = join(categoryDir(kbDir, p.category), "scripts", p.name);
			await kbWrite(prelude, s, `add tool ${p.category}/${p.name}`, check.output.split("\n")[0], () => {
				rmSync(dest, { recursive: true, force: true });
				cpSync(src, dest, { recursive: true });
				return { kind: "tool", category: p.category, subject: p.name };
			});
			return textResult(`Tool ${p.name} added to ${p.category} (selfcheck passed).`, { path: dest });
		},
	});

	return [categoryAdd, lessonAdd, lessonRevise, toolAdd];
}
