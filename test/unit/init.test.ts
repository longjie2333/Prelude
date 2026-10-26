import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_BEGIN, gitignoreContent, initProject, readProject, upsertAgentsSection } from "../../src/init.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
});
afterEach(() => p.cleanup());

describe("/prelude-init project part (M1-2)", () => {
	it("creates .prelude/ with a stable project id", () => {
		const a = initProject(p.paths, { notes: true, reports: false });
		expect(a.id).toMatch(/^p-[0-9a-f]{8}$/);
		for (const d of [p.paths.notesDir, p.paths.reportsDir, p.paths.workDir]) expect(existsSync(d)).toBe(true);
		const b = initProject(p.paths, { notes: false, reports: false });
		expect(b.id).toBe(a.id);
		expect(readProject(p.paths)?.track).toEqual({ notes: false, reports: false });
	});

	it("always ignores runtime data and ignores notes/reports by choice", () => {
		const both = gitignoreContent({ notes: true, reports: true });
		for (const x of ["work/", "evidence/", "runs/", "audit.jsonl"]) expect(both).toContain(x);
		expect(both).not.toContain("notes/");
		expect(gitignoreContent({ notes: false, reports: true })).toContain("notes/");
		initProject(p.paths, { notes: true, reports: false });
		expect(readFileSync(p.paths.gitignore, "utf8")).toContain("reports/");
	});

	it("adds the AGENTS.md section once and replaces it on re-run", () => {
		writeFileSync(p.paths.agentsFile, "# My project\n\nOwn text.\n");
		initProject(p.paths, { notes: true, reports: true });
		initProject(p.paths, { notes: true, reports: true });
		const text = readFileSync(p.paths.agentsFile, "utf8");
		expect(text.startsWith("# My project\n\nOwn text.\n")).toBe(true);
		expect(text.split(AGENTS_BEGIN).length).toBe(2);
		expect(upsertAgentsSection(undefined)).toContain(".prelude/notes/");
		const edited = text.replace("本项目由 Prelude 测试", "OLD");
		expect(upsertAgentsSection(edited)).toBe(text);
	});
});
