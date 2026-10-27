import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCategory, addLesson, listLessons, readLesson, reviseLesson, statusFor } from "../../src/kb/lessons.ts";
import { overview, similarity } from "../../src/kb/inspect.ts";
import { renderCategory } from "../../src/kb/render.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
let kb: string;
const ev = (project: string, finding = "f-001") => ({ project, report: "reports/r.md", finding, at: "2026-10-27" });
const input = {
	title: "并发写要查守恒",
	applies_when: "共享计数被并发扣减",
	guidance: "并发 N 次后检查 成功数 ≤ 初始量",
};

beforeEach(() => {
	p = tempProject();
	kb = join(p.home, ".prelude", "kb");
	addCategory(kb, { name: "rest-api", dimension: "interface", description: "HTTP/JSON 接口" });
});
afterEach(() => p.cleanup());

describe("lessons (M2-4)", () => {
	it("adds lessons as candidates and needs evidence", () => {
		const l = addLesson(kb, "rest-api", input, [ev("p-1")]);
		expect(l).toMatchObject({ status: "candidate", not_applies_when: [], revisions: [] });
		expect(l.id).toMatch(/^les-[0-9a-f]{4}$/);
		expect(() => addLesson(kb, "rest-api", input, [])).toThrow(/evidence/);
		expect(() => addLesson(kb, "nope", input, [ev("p-1")])).toThrow(/no category nope/);
	});

	it("promotes only with evidence from two distinct projects (D-5)", () => {
		const l = addLesson(kb, "rest-api", input, [ev("p-1")]);
		const same = reviseLesson(kb, "rest-api", l.id, "p-1", {
			kind: "evidence",
			reason: "again",
			evidence: ev("p-1", "f-002"),
		});
		expect(same.status).toBe("candidate");
		const other = reviseLesson(kb, "rest-api", l.id, "p-2", {
			kind: "evidence",
			reason: "seen",
			evidence: ev("p-2"),
		});
		expect(other.status).toBe("confirmed");
		expect(statusFor({ status: "candidate", evidence: [ev("a"), ev("a")] })).toBe("candidate");
		expect(() =>
			reviseLesson(kb, "rest-api", l.id, "p-2", { kind: "evidence", reason: "dup", evidence: ev("p-2") }),
		).toThrow(/already evidence/);
	});

	it("keeps the replaced text in revisions and never deletes (P5)", () => {
		const l = addLesson(kb, "rest-api", input, [ev("p-1")]);
		reviseLesson(kb, "rest-api", l.id, "p-2", {
			kind: "counterexample",
			reason: "同步事务",
			not_applies_when: "扣减在同一事务内",
		});
		const r = reviseLesson(kb, "rest-api", l.id, "p-2", { kind: "guidance", reason: "更准确", guidance: "新做法" });
		expect(r.not_applies_when).toEqual(["扣减在同一事务内"]);
		expect(r.guidance).toBe("新做法");
		expect(r.revisions.map((x) => [x.kind, x.before.guidance, x.before.not_applies_when.length])).toEqual([
			["counterexample", input.guidance, 0],
			["guidance", input.guidance, 1],
		]);
		const retired = reviseLesson(kb, "rest-api", l.id, "p-3", { kind: "retire", reason: "接口已下线" });
		expect(retired).toMatchObject({ status: "retired", retired_reason: "接口已下线" });
		expect(() => reviseLesson(kb, "rest-api", l.id, "p-3", { kind: "guidance", reason: "x", guidance: "y" })).toThrow(
			/retired/,
		);
		expect(readLesson(kb, "rest-api", l.id).revisions).toHaveLength(3);
	});

	it("validates category names", () => {
		expect(() => addCategory(kb, { name: "Bad Name", dimension: "platform", description: "x" })).toThrow(/lowercase/);
		expect(() => addCategory(kb, { name: "rest-api", dimension: "platform", description: "x" })).toThrow(/exists/);
		expect(() => addCategory(kb, { name: "test-pilot", dimension: "platform", description: "x" })).toThrow();
	});
});

describe("render (M2-4)", () => {
	it("puts confirmed lessons in the body, candidates apart, omits retired, lists live tools", () => {
		const a = addLesson(kb, "rest-api", { ...input, title: "A 已确认" }, [ev("p-1"), ev("p-2")]);
		addLesson(kb, "rest-api", { ...input, title: "B 待验证" }, [ev("p-1")]);
		const c = addLesson(kb, "rest-api", { ...input, title: "C 已退役" }, [ev("p-1")]);
		reviseLesson(kb, "rest-api", c.id, "p-1", { kind: "retire", reason: "x" });
		const tool = join(kb, "skills", "rest-api", "scripts", "burst");
		mkdirSync(tool, { recursive: true });
		writeFileSync(join(tool, "README.md"), "# burst\n\n并发发请求并统计状态码。\n");
		const old = join(kb, "skills", "rest-api", "scripts", "old");
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, "README.md"), "Deprecated: 不再维护\n");

		const md = readFileSync(
			renderCategory(kb, { name: "rest-api", dimension: "interface", description: "HTTP/JSON 接口" }),
			"utf8",
		);
		expect(md).toMatch(/^---\nname: rest-api\ndescription: "Prelude interface 类别经验：HTTP\/JSON 接口"\n---/);
		const [body, pending] = md.split("## 待验证");
		expect(body).toContain("A 已确认");
		expect(pending).toContain("B 待验证");
		expect(md).not.toContain("C 已退役");
		expect(md).toContain("`scripts/burst/`：并发发请求并统计状态码。");
		expect(md).not.toContain("scripts/old/");
		expect(a.status).toBe("confirmed");
		expect(listLessons(kb, "rest-api")).toHaveLength(3);
		expect(existsSync(join(kb, "skills", "rest-api", "SKILL.md"))).toBe(true);
	});
});

describe("/prelude-kb overview (M3-6)", () => {
	it("lists lessons and flags stale ones and likely duplicates", () => {
		const old = { project: "p-1", report: "r.md", finding: "f-001", at: "2026-01-02" };
		const a = addLesson(kb, "rest-api", { ...input, title: "并发扣减要检查守恒" }, [ev("p-1")]);
		const b = addLesson(kb, "rest-api", { ...input, title: "并发扣减要检查守恒关系" }, [ev("p-2")]);
		const c = addLesson(
			kb,
			"rest-api",
			{ title: "分页要遍历所有页", applies_when: "列表接口分页", guidance: "比对并集与 total" },
			[old],
		);
		const o = overview(kb, new Date("2026-10-27T00:00:00Z"));
		expect(o.stale).toEqual([`rest-api/${c.id}`]);
		expect(o.duplicates).toEqual([[`rest-api/${[a.id, b.id].sort()[0]}`, `rest-api/${[a.id, b.id].sort()[1]}`]]);
		expect(o.text).toContain("rest-api (interface) — 3 lesson(s), 0 tool(s)");
		expect(o.text).toContain(`${c.id} [candidate] 分页要遍历所有页 — 1 project(s), last 2026-01-02 (stale)`);
		expect(similarity("abc", "xyz")).toBe(0);
	});
});
