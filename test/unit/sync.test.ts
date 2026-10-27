import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/audit.ts";
import { readConfig } from "../../src/kb/config.ts";
import { Git } from "../../src/kb/git.ts";
import { addCategory, addLesson, listLessons, reviseLesson } from "../../src/kb/lessons.ts";
import { KEEP_BOTH, Kb, setupKb } from "../../src/kb/sync.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
let remote: string;
const audits: AuditEvent[] = [];
const audit = (e: AuditEvent) => audits.push(e);
const ev = (project: string) => ({ project, report: "reports/r.md", finding: "f-001", at: "2026-10-27" });
const lesson = { title: "守恒", applies_when: "并发扣减", guidance: "检查守恒" };

beforeEach(async () => {
	p = tempProject();
	audits.length = 0;
	remote = join(p.base, "kb-remote.git");
	await new Git(p.base).exec(["init", "--quiet", "--bare", "-b", "main", remote]);
});
afterEach(() => p.cleanup());

const home = (name: string) => {
	const h = join(p.base, name);
	mkdirSync(h, { recursive: true });
	return h;
};

describe("knowledge-base sync (M2-1, M2-3)", () => {
	it("sets up from an empty remote, pushes the seed, and a second machine gets it", async () => {
		const a = await setupKb({ home: home("a"), remote }, audit);
		expect(a.state).toBe("synced");
		expect(readConfig(home("a"))?.kb.branch).toMatch(/^kb\/[a-z0-9-]+-[0-9a-f]{4}$/);
		const main = await new Git(p.base).exec(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]);
		expect(main.stdout).toContain("skills/test-pilot/SKILL.md");
		expect(main.stdout).toContain("README.md");

		const b = await setupKb({ home: home("b"), remote }, audit);
		expect(b.config.branch).not.toBe(a.config.branch);
		expect(existsSync(join(b.dir, "skills", "test-pilot", "SKILL.md"))).toBe(true);
	});

	it("two machines each add a lesson and both see both after syncing", async () => {
		const a = await setupKb({ home: home("a"), remote }, audit);
		const b = await setupKb({ home: home("b"), remote }, audit);
		await a.write("add category", () =>
			addCategory(a.dir, { name: "rest-api", dimension: "interface", description: "接口" }),
		);
		await a.write("lesson a", () => addLesson(a.dir, "rest-api", lesson, [ev("p-a")]));
		expect(await a.finish()).toBe("synced");
		await b.enter(undefined);
		await b.write("lesson b", () => addLesson(b.dir, "rest-api", { ...lesson, title: "B" }, [ev("p-b")]));
		expect(await b.finish()).toBe("synced");
		await a.enter(undefined);
		expect(
			listLessons(a.dir, "rest-api")
				.map((l) => l.title)
				.sort(),
		).toEqual(["B", "守恒"]);
		expect(readFileSync(join(a.dir, "skills", "rest-api", "SKILL.md"), "utf8")).toContain("### B");
	});

	it("asks per conflicting file on entry; keep both saves the remote lesson under a new id", async () => {
		const a = await setupKb({ home: home("a"), remote }, audit);
		const b = await setupKb({ home: home("b"), remote }, audit);
		let id = "";
		await a.write("cat", () => addCategory(a.dir, { name: "rest-api", dimension: "interface", description: "接口" }));
		await a.write("lesson", () => {
			id = addLesson(a.dir, "rest-api", lesson, [ev("p-a")]).id;
		});
		await a.finish();
		await b.enter(undefined);
		await a.write("a revises", () =>
			reviseLesson(a.dir, "rest-api", id, "p-a", { kind: "guidance", reason: "a", guidance: "A 的做法" }),
		);
		await a.finish();
		await b.write("b revises", () =>
			reviseLesson(b.dir, "rest-api", id, "p-b", { kind: "guidance", reason: "b", guidance: "B 的做法" }),
		);

		// No UI: the merge is aborted and left pending; local work stays on the own branch.
		expect(await b.enter(undefined)).toBe("conflict");
		expect(b.pending()?.reason).toMatch(/lessons/);
		expect(await b.git.mergeInProgress()).toBe(false);

		const asked: string[] = [];
		const state = await b.enter({
			select: async (title, options) => {
				asked.push(`${title} [${options.join("|")}]`);
				return KEEP_BOTH;
			},
		});
		expect(state).toBe("pending");
		expect(asked).toEqual([
			`Knowledge-base conflict in skills/rest-api/lessons/${id}.json [Keep local|Take remote|Keep both|Abort merge]`,
		]);
		const guidance = listLessons(b.dir, "rest-api")
			.map((l) => l.guidance)
			.sort();
		expect(guidance).toEqual(["A 的做法", "B 的做法"]);
		expect(b.pending()).toBeUndefined();
		expect(await b.finish()).toBe("synced");
	});

	it("does not block the end step on a conflict: the own branch is pushed, main is left alone", async () => {
		const a = await setupKb({ home: home("a"), remote }, audit);
		const b = await setupKb({ home: home("b"), remote }, audit);
		let id = "";
		await a.write("cat", () => addCategory(a.dir, { name: "web", dimension: "platform", description: "网站" }));
		await a.write("l", () => {
			id = addLesson(a.dir, "web", lesson, [ev("p-a")]).id;
		});
		await a.finish();
		await b.enter(undefined);
		await a.write("a", () => reviseLesson(a.dir, "web", id, "p-a", { kind: "guidance", reason: "a", guidance: "A" }));
		await a.finish();
		await b.write("b", () => reviseLesson(b.dir, "web", id, "p-b", { kind: "guidance", reason: "b", guidance: "B" }));
		expect(await b.finish()).toBe("conflict");
		const refs = await new Git(p.base).exec(["--git-dir", remote, "branch", "--list"]);
		expect(refs.stdout).toContain(b.config.branch);
		const onMain = await new Git(p.base).exec(["--git-dir", remote, "show", `main:skills/web/lessons/${id}.json`]);
		expect(onMain.stdout).toContain('"guidance": "A"');
	});

	it("restores changes no tool made and audits them (M2-2)", async () => {
		const kb = await setupKb({ home: home("a") }, audit);
		expect(kb.state).toBe("local");
		writeFileSync(join(kb.dir, "README.md"), "hacked");
		writeFileSync(join(kb.dir, "skills", "evil.txt"), "x");
		expect((await kb.checkWorkspace()).sort()).toEqual(["README.md", "skills/evil.txt"]);
		expect(readFileSync(join(kb.dir, "README.md"), "utf8")).toContain("Prelude 知识库");
		expect(audits.find((e) => e.event === "kb_restore")?.detail).toMatchObject({
			paths: expect.arrayContaining(["README.md"]),
		});
		expect(await kb.finish()).toBe("local");
	});

	it("serializes writes and reports offline when the remote is gone", async () => {
		const kb = await setupKb({ home: home("a"), remote }, audit);
		await kb.write("cat", () => addCategory(kb.dir, { name: "cli", dimension: "platform", description: "命令行" }));
		await Promise.all(
			[1, 2, 3].map((i) =>
				kb.write(`l${i}`, () => addLesson(kb.dir, "cli", { ...lesson, title: `t${i}` }, [ev("p")])),
			),
		);
		expect(listLessons(kb.dir, "cli")).toHaveLength(3);
		await kb.git.exec(["remote", "set-url", "origin", join(p.base, "gone.git")]);
		expect(await new Kb(kb.config, audit, home("a")).finish()).toBe("offline");
	});
});
