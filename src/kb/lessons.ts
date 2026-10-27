/**
 * Categories and lessons on disk (plan M2-4, design §5.1–5.3, D-4, D-5). One JSON file per lesson
 * under `skills/<category>/lessons/`; status follows from the evidence (>= 2 distinct projects =
 * confirmed), never from the caller; revisions append and keep the text they replace (P5).
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { nowIso, randomHex, readJson, writeJson } from "../util.ts";

export const DIMENSIONS = ["platform", "interface", "domain", "stack"] as const;
export const STATUSES = ["candidate", "confirmed", "retired"] as const;
export const REVISION_KINDS = ["counterexample", "guidance", "evidence", "retire"] as const;

/** Skill names: lowercase letters, digits, single hyphens, at most 64 characters (pi skills.md). */
export const CATEGORY_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EvidenceSchema = Type.Object({
	project: Type.String(),
	report: Type.String(),
	finding: Type.String(),
	at: Type.String(),
});
export type Evidence = Static<typeof EvidenceSchema>;

const RevisionSchema = Type.Object({
	at: Type.String(),
	project: Type.String(),
	kind: StringEnum(REVISION_KINDS),
	reason: Type.String(),
	before: Type.Object({
		guidance: Type.String(),
		not_applies_when: Type.Array(Type.String()),
		status: StringEnum(STATUSES),
	}),
});
export type Revision = Static<typeof RevisionSchema>;

export const LessonSchema = Type.Object({
	id: Type.String(),
	title: Type.String({ minLength: 1 }),
	applies_when: Type.String({ minLength: 1 }),
	not_applies_when: Type.Array(Type.String()),
	guidance: Type.String({ minLength: 1 }),
	status: StringEnum(STATUSES),
	evidence: Type.Array(EvidenceSchema),
	revisions: Type.Array(RevisionSchema),
	retired_reason: Type.Optional(Type.String()),
});
export type Lesson = Static<typeof LessonSchema>;

export const CategorySchema = Type.Object({
	name: Type.String(),
	dimension: StringEnum(DIMENSIONS),
	description: Type.String({ minLength: 1, maxLength: 400 }),
});
export type Category = Static<typeof CategorySchema>;

export function skillsDir(kbDir: string): string {
	return join(kbDir, "skills");
}

export function categoryDir(kbDir: string, name: string): string {
	return join(skillsDir(kbDir), name);
}

function lessonsDir(kbDir: string, category: string): string {
	return join(categoryDir(kbDir, category), "lessons");
}

function check<T>(schema: TSchema, value: unknown, what: string): T {
	if (!Value.Check(schema, value)) {
		const e = [...Value.Errors(schema, value)][0];
		throw new Error(`${what} invalid at ${e?.instancePath || "/"}: ${e?.message ?? "schema mismatch"}`);
	}
	return value as T;
}

export function readCategory(kbDir: string, name: string): Category | undefined {
	const raw = readJson<unknown>(join(categoryDir(kbDir, name), "category.json"));
	return raw === undefined ? undefined : check<Category>(CategorySchema, raw, `category ${name}`);
}

export function listCategories(kbDir: string): Category[] {
	const dir = skillsDir(kbDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readCategory(kbDir, d.name))
		.filter((c): c is Category => c !== undefined);
}

export function requireCategory(kbDir: string, name: string): Category {
	const c = readCategory(kbDir, name);
	if (!c) {
		const known = listCategories(kbDir).map((x) => x.name);
		throw new Error(`no category ${name}; known: ${known.join(", ") || "none"}. Create it with kb_category_add`);
	}
	return c;
}

export function addCategory(kbDir: string, category: Category): Category {
	if (!CATEGORY_NAME.test(category.name) || category.name.length > 64)
		throw new Error("category name: lowercase letters, digits and single hyphens, at most 64 characters");
	if (category.name === "test-pilot") throw new Error("test-pilot is the methodology, not a category");
	if (readCategory(kbDir, category.name)) throw new Error(`category ${category.name} already exists`);
	check<Category>(CategorySchema, category, "category");
	writeJson(join(categoryDir(kbDir, category.name), "category.json"), category);
	mkdirSync(lessonsDir(kbDir, category.name), { recursive: true });
	return category;
}

export function readLesson(kbDir: string, category: string, id: string): Lesson {
	const raw = readJson<unknown>(join(lessonsDir(kbDir, category), `${id}.json`));
	if (raw === undefined) throw new Error(`no lesson ${id} in ${category}`);
	return check<Lesson>(LessonSchema, raw, `lesson ${id}`);
}

export function listLessons(kbDir: string, category: string): Lesson[] {
	const dir = lessonsDir(kbDir, category);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => readLesson(kbDir, category, f.slice(0, -5)));
}

function writeLesson(kbDir: string, category: string, lesson: Lesson): void {
	check<Lesson>(LessonSchema, lesson, `lesson ${lesson.id}`);
	writeJson(join(lessonsDir(kbDir, category), `${lesson.id}.json`), lesson);
}

/** D-5: confirmed once >= 2 distinct projects back it; retired stays retired. */
export function statusFor(lesson: Pick<Lesson, "status" | "evidence">): Lesson["status"] {
	if (lesson.status === "retired") return "retired";
	return new Set(lesson.evidence.map((e) => e.project)).size >= 2 ? "confirmed" : "candidate";
}

export function newLessonId(kbDir: string, category: string): string {
	for (;;) {
		const id = `les-${randomHex(2)}`;
		if (!existsSync(join(lessonsDir(kbDir, category), `${id}.json`))) return id;
	}
}

export interface LessonInput {
	title: string;
	applies_when: string;
	not_applies_when?: string[];
	guidance: string;
}

export function addLesson(kbDir: string, category: string, input: LessonInput, evidence: Evidence[]): Lesson {
	requireCategory(kbDir, category);
	if (evidence.length === 0) throw new Error("a lesson needs evidence from a verified finding of this run");
	const lesson: Lesson = {
		id: newLessonId(kbDir, category),
		title: input.title,
		applies_when: input.applies_when,
		not_applies_when: input.not_applies_when ?? [],
		guidance: input.guidance,
		status: "candidate",
		evidence,
		revisions: [],
	};
	// A new lesson starts as a candidate even with evidence from one project (design §5.3).
	lesson.status = statusFor(lesson);
	writeLesson(kbDir, category, lesson);
	return lesson;
}

export type RevisionInput =
	| { kind: "counterexample"; reason: string; not_applies_when: string }
	| { kind: "guidance"; reason: string; guidance: string }
	| { kind: "evidence"; reason: string; evidence: Evidence }
	| { kind: "retire"; reason: string };

export function reviseLesson(
	kbDir: string,
	category: string,
	id: string,
	project: string,
	change: RevisionInput,
): Lesson {
	const lesson = readLesson(kbDir, category, id);
	if (lesson.status === "retired") throw new Error(`${id} is retired`);
	lesson.revisions.push({
		at: nowIso(),
		project,
		kind: change.kind,
		reason: change.reason,
		before: { guidance: lesson.guidance, not_applies_when: [...lesson.not_applies_when], status: lesson.status },
	});
	if (change.kind === "counterexample") lesson.not_applies_when.push(change.not_applies_when);
	if (change.kind === "guidance") lesson.guidance = change.guidance;
	if (change.kind === "evidence") {
		const e = change.evidence;
		if (lesson.evidence.some((x) => x.project === e.project && x.finding === e.finding && x.report === e.report))
			throw new Error(`${e.finding} is already evidence for ${id}`);
		lesson.evidence.push(e);
	}
	if (change.kind === "retire") {
		lesson.status = "retired";
		lesson.retired_reason = change.reason;
	}
	lesson.status = statusFor(lesson);
	writeLesson(kbDir, category, lesson);
	return lesson;
}
