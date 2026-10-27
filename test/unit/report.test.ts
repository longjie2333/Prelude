import { describe, expect, it } from "vitest";
import { checkReport, parseSections, retroProblems } from "../../src/report.ts";
import type { Finding, Verdict } from "../../src/run.ts";

const finding = (id: string, kind: Finding["kind"], verdict?: Verdict): Finding => ({
	id,
	title: id,
	severity: "high",
	kind,
	description: "d",
	at: "2026-10-27T00:00:00Z",
	evidence: [],
	verification: verdict ? { verdict, at: "2026-10-27T00:00:00Z" } : undefined,
});

const report = (over: Partial<Record<string, string>> = {}) => {
	const body = {
		结论: "两个缺陷。",
		已复验缺陷: "### f-001 超卖（high）\n- 复现 3/3",
		建议: "- f-003 错误提示不清楚",
		未复现项: "- f-002 被审查拒绝：断言抄了实际值",
		测了什么: "下单、分页",
		没测什么: "安全测试：未授权",
		隔离级别: "仅工具层策略，不是安全边界。",
		...over,
	};
	return `# 报告\n\n${Object.entries(body)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `## ${k}\n\n${v}`)
		.join("\n\n")}\n`;
};

const lessonAdd = { kind: "lesson_add" as const, category: "rest-api", subject: "les-1a2b" };

const findings = [
	finding("f-001", "defect", "confirmed"),
	finding("f-002", "defect", "rejected"),
	finding("f-003", "suggestion", "confirmed"),
];

describe("report check (M1-8)", () => {
	it("accepts a complete, consistent report", () => {
		expect(checkReport(report(), findings, "win32")).toEqual({
			problems: [],
			defects: ["f-001"],
			suggestions: ["f-003"],
			unreproduced: ["f-002"],
		});
	});

	it("lists every missing section", () => {
		const r = checkReport(report({ 建议: undefined, 隔离级别: undefined }), findings, "linux");
		expect(r.problems).toEqual(expect.arrayContaining(["missing section: 建议", "missing section: 隔离级别"]));
	});

	it("rejects defects that are not confirmed and confirmed ones that are missing", () => {
		const r = checkReport(report({ 已复验缺陷: "- f-002", 未复现项: "无" }), findings, "linux");
		expect(r.problems).toEqual(
			expect.arrayContaining([
				"f-001 is a verified defect but not under 已复验缺陷",
				"f-002 is under 已复验缺陷 but is not a confirmed defect",
				"f-002 was rejected or not reproduced but is not under 未复现项",
			]),
		);
	});

	it("requires verification and the Windows isolation note", () => {
		const r = checkReport(report({ 隔离级别: "沙箱" }), [...findings, finding("f-004", "defect")], "win32");
		expect(r.problems).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^not verified yet: f-004/),
				expect.stringMatching(/仅工具层策略/),
			]),
		);
		expect(checkReport(report({ 隔离级别: "沙箱" }), findings, "linux").problems).toEqual([]);
	});

	it("requires a retro once a knowledge base exists (M2-8)", () => {
		const withRetro = (text: string) => `${report()}
## 复盘

${text}
`;
		const none = { writes: [], lessonExists: () => false };
		const one = { writes: [lessonAdd], lessonExists: () => false };
		expect(checkReport(report(), findings, "win32", one).problems).toEqual(["missing section: 复盘"]);
		expect(checkReport(withRetro("新增经验 les-1a2b（rest-api）"), findings, "win32", one).problems).toEqual([]);
		expect(checkReport(withRetro("本次很顺利"), findings, "win32", none).problems).toEqual([
			expect.stringMatching(/no knowledge-base write/),
		]);
		expect(checkReport(withRetro("无可沉淀：只是配置问题"), findings, "win32", none).problems).toEqual([]);
		expect(checkReport(report(), findings, "win32").problems).toEqual([]);
	});

	it("checks the 复盘 section against the audited writes (M2-8)", () => {
		const writes = [
			{ kind: "category" as const, category: "rest-api", subject: "rest-api" },
			lessonAdd,
			{ kind: "lesson_revise" as const, category: "rest-api", subject: "les-9f00", revision: "evidence" },
			{ kind: "tool" as const, category: "rest-api", subject: "race-probe" },
		];
		const known = new Set(["les-9f00", "les-0007"]);
		const retro = { writes, lessonExists: (id: string) => known.has(id) };
		const ok =
			"新建类别 rest-api；新增 les-1a2b；les-9f00 追加证据；入库工具 race-probe。les-0007 本次不适用，未修订。";
		expect(retroProblems(ok, retro)).toEqual([]);
		// A write that the retro leaves out, and a lesson the retro invents.
		expect(retroProblems("新建类别 rest-api；新增 les-1a2b 和 les-dead；入库工具 race-probe-v2。", retro)).toEqual([
			"复盘 does not mention revised lesson les-9f00 (rest-api), which this test wrote",
			"复盘 does not mention tool race-probe (rest-api), which this test wrote",
			"复盘 names lesson les-dead, which does not exist in the knowledge base",
		]);
		// Claiming nothing when something was written.
		expect(retroProblems(`无可沉淀。${ok}`, retro)).toEqual([
			"复盘 says 无可沉淀, but this test wrote 4 knowledge-base change(s)",
		]);
	});

	it("accepts English and numbered headings and keeps subsections inside their section", () => {
		const md = "## 1. Conclusion\nok\n## Verified defects\n### f-001 x\n#### detail f-009\n## 2) Suggestions\nf-003";
		const s = parseSections(md);
		expect(s.get("defects")).toContain("f-009");
		expect(s.get("suggestions")).toBe("f-003");
		expect(s.has("conclusion")).toBe(true);
	});
});
