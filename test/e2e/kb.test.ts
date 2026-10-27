/**
 * Knowledge base across two "machines" (plan M2-9, M2 acceptance 1–3): each has its own home,
 * project and branch, sharing one bare remote. Machine A learns a lesson from a confirmed
 * finding; machine B (another project) sees it, confirms it again, and it is promoted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAudit } from "../../src/audit.ts";
import type { Prelude } from "../../src/context.ts";
import { createPrelude } from "../../src/index.ts";
import { Git } from "../../src/kb/git.ts";
import { listLessons } from "../../src/kb/lessons.ts";
import { setupKb } from "../../src/kb/sync.ts";
import { projectPaths } from "../../src/paths.ts";
import { startCanary, type TempProject, tempProject } from "../helpers.ts";
import { call, createRouter, type Router, say, type Step } from "./faux.ts";

const OVERSELL = (url: string) => `const base = ${JSON.stringify(url)};
const j = (m, p, b) => fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) });
try {
	await j("POST", "/reset");
	const before = (await (await j("GET", "/products/p1")).json()).stock;
	const rs = await Promise.all(Array.from({ length: 30 }, () => j("POST", "/orders", { productId: "p1", qty: 1 })));
	const accepted = rs.filter((r) => r.status === 201).length;
	console.log(JSON.stringify({ before, accepted }));
	process.exit(accepted > before ? 1 : 0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
`;

const REPORT = `# 报告

## 结论
超卖。
## 已复验缺陷
- f-001 超卖
## 建议
无
## 未复现项
无
## 测了什么
并发下单
## 没测什么
其他
## 隔离级别
仅工具层策略
## 复盘
见知识库写入。
`;

const R = ".prelude/reports/r.md";

let t: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let remote: string;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	t = tempProject();
	canary = await startCanary({ bugs: new Set(["B1"]) });
	remote = join(t.base, "kb.git");
	await new Git(t.base).exec(["init", "--quiet", "--bare", "-b", "main", remote]);
});

afterEach(async () => {
	for (const s of sessions.splice(0)) {
		await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		s.dispose();
	}
	await canary.close();
	t.cleanup();
});

interface Machine {
	home: string;
	root: string;
	agentDir: string;
	prelude?: Prelude;
}

async function machine(name: string): Promise<Machine> {
	const home = join(t.base, name, "home");
	const root = join(t.base, name, "project");
	const agentDir = join(home, ".pi", "agent");
	for (const d of [home, root, agentDir]) mkdirSync(d, { recursive: true });
	mkdirSync(join(root, ".prelude"), { recursive: true });
	writeFileSync(
		join(root, ".prelude", "scope.json"),
		JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, allowed: ["functional"] }] }),
	);
	await setupKb({ home, remote }, () => undefined);
	return { home, root, agentDir };
}

async function session(m: Machine, router: Router): Promise<AgentSession> {
	const loader = new DefaultResourceLoader({
		cwd: m.root,
		agentDir: m.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			createPrelude(
				{ home: m.home, agentDir: m.agentDir, modelRuntime: router.runtime, rerun: { runs: 3, timeoutMs: 20_000 } },
				(x) => {
					m.prelude = x;
				},
			),
		],
	});
	await loader.reload();
	const { session: s } = await createAgentSession({
		cwd: m.root,
		agentDir: m.agentDir,
		model: router.model(),
		modelRuntime: await router.runtime(),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(m.root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	});
	await s.bindExtensions({});
	sessions.push(s);
	return s;
}

/** Records the oversell, verifies it, writes the report: the part both machines share. */
const testSteps = (url: string): Step[] => [
	call("write", { path: ".prelude/work/oversell.mjs", content: OVERSELL(url) }),
	call("finding_record", {
		title: "超卖",
		severity: "critical",
		kind: "defect",
		description: "并发下单接受数超过库存；预期库存守恒（openapi）",
		repro: ".prelude/work/oversell.mjs",
	}),
	call("verify_findings", {}),
	call("write", { path: R, content: REPORT }),
];
const confirm: Step = call("review_verdict", { verdict: "confirmed", reason: "守恒断言有契约依据" });

describe("knowledge base across machines (M2)", () => {
	it("learns on machine A, is seen and promoted on machine B, and blocks direct writes", async () => {
		const results: string[] = [];
		const keep: Step = (ctx) => {
			results.push(ctx.lastToolResult().text);
			return say("ok")(ctx);
		};
		const remember =
			(next: Step): Step =>
			(ctx) => {
				results.push(ctx.lastToolResult().text);
				return next(ctx);
			};

		// ---------------------------------------------------------------- machine A
		const a = await machine("a");
		const kbA = join(a.home, ".prelude", "kb");
		const routerA = createRouter(t.base, {
			main: [
				...testSteps(canary.url),
				// Direct writes to the knowledge base are blocked (M2 acceptance 3).
				call("write", { path: join(kbA, "skills", "x", "SKILL.md"), content: "hack" }),
				remember(
					call("kb_lesson_add", {
						category: "rest-api",
						title: "并发扣减要查守恒",
						applies_when: "接口对共享计数做扣减",
						guidance: "并发 N 次后检查 成功数 ≤ 初始量",
						findings: ["f-001"],
						report: R,
					}),
				),
				remember(
					call("kb_category_add", {
						name: "rest-api",
						dimension: "interface",
						description: "HTTP/JSON 接口",
						report: R,
					}),
				),
				call("kb_lesson_add", {
					category: "rest-api",
					title: "并发扣减要查守恒",
					applies_when: "接口对共享计数做扣减",
					guidance: "并发 N 次后检查 成功数 ≤ 初始量",
					findings: ["f-001"],
					report: R,
				}),
				call("report_finalize", { path: R }),
				keep,
			],
			reviewer: [confirm],
		});
		await (await session(a, routerA)).prompt(`/test 测 ${canary.url}`);

		expect(results[0]).toMatch(/knowledge base is written through Prelude kb_\* tools only/);
		expect(results[1]).toMatch(/no category rest-api/);
		expect(results[2]).toMatch(/Report registered/);
		const lessonsA = listLessons(kbA, "rest-api");
		expect(lessonsA).toHaveLength(1);
		expect(lessonsA[0].status).toBe("candidate");
		const id = lessonsA[0].id;
		// Pushed on settle: the remote main has the lesson (M2 acceptance 1).
		const onMain = await new Git(t.base).exec(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]);
		expect(onMain.stdout).toContain(`skills/rest-api/lessons/${id}.json`);
		const branches = await new Git(t.base).exec(["--git-dir", remote, "branch", "--list"]);
		expect(branches.stdout).toContain(a.prelude?.kb()?.config.branch ?? "missing");
		const log = await new Git(kbA).exec(["log", "--format=%B", "-1", "--", `skills/rest-api/lessons/${id}.json`]);
		expect(log.stdout).toMatch(/Project: p-[0-9a-f]{8}\nReport: \.prelude\/reports\/r\.md/);

		// ---------------------------------------------------------------- machine B, another project
		const b = await machine("b");
		results.length = 0;
		let promptB = "";
		const routerB = createRouter(t.base, {
			main: [
				(ctx) => {
					promptB = ctx.sections.prelude ?? "";
					return testSteps(canary.url)[0](ctx);
				},
				...testSteps(canary.url).slice(1),
				call("kb_lesson_revise", {
					category: "rest-api",
					id,
					kind: "evidence",
					reason: "再次证实",
					finding: "f-001",
					report: R,
				}),
				remember(call("report_finalize", { path: R })),
				keep,
			],
			reviewer: [confirm],
		});
		await (await session(b, routerB)).prompt(`/test 测 ${canary.url}`);

		// B saw A's category on entry (M2 acceptance 2) and its second-project evidence promoted it.
		expect(promptB).toMatch(/rest-api（interface，1 条经验）/);
		const kbB = join(b.home, ".prelude", "kb");
		const lesson = listLessons(kbB, "rest-api")[0];
		expect(lesson.status).toBe("confirmed");
		expect(new Set(lesson.evidence.map((e) => e.project)).size).toBe(2);
		expect(readFileSync(join(kbB, "skills", "rest-api", "SKILL.md"), "utf8").split("## 待验证")[0]).toContain(
			"并发扣减要查守恒",
		);
		const mainLesson = await new Git(t.base).exec([
			"--git-dir",
			remote,
			"show",
			`main:skills/rest-api/lessons/${id}.json`,
		]);
		expect(JSON.parse(mainLesson.stdout).status).toBe("confirmed");

		const auditA = readAudit(projectPaths(a.root).auditFile);
		expect(auditA.filter((e) => e.event === "kb_write").map((e) => e.detail?.action)).toEqual([
			"add category rest-api",
			"add lesson to rest-api",
		]);
		expect(auditA.some((e) => e.event === "kb_sync" && e.decision === "pushed")).toBe(true);
	});

	it("refuses evidence that is not a confirmed finding, and a report without a retro", async () => {
		const results: string[] = [];
		const remember =
			(next: Step): Step =>
			(ctx) => {
				results.push(ctx.lastToolResult().text);
				return next(ctx);
			};
		const m = await machine("c");
		const noRetro = REPORT.replace("见知识库写入。", "本次很顺利。");
		const router = createRouter(t.base, {
			main: [
				call("write", { path: ".prelude/work/oversell.mjs", content: OVERSELL(canary.url) }),
				call("finding_record", {
					title: "超卖",
					severity: "critical",
					kind: "defect",
					description: "d",
					repro: ".prelude/work/oversell.mjs",
				}),
				call("write", { path: R, content: noRetro }),
				call("kb_category_add", { name: "rest-api", dimension: "interface", description: "接口", report: R }),
				call("kb_lesson_add", {
					category: "rest-api",
					title: "t",
					applies_when: "a",
					guidance: "g",
					findings: ["f-001"],
					report: R,
				}),
				remember(call("verify_findings", {})),
				remember(call("report_finalize", { path: R })),
				remember(say("done")),
			],
			reviewer: [call("review_verdict", { verdict: "rejected", reason: "断言没有依据" })],
		});
		await (await session(m, router)).prompt(`/test 测 ${canary.url}`);
		expect(results[0]).toMatch(/f-001 is unverified; only confirmed findings are evidence/);
		// The category write counts as the retro; the rejected defect may not sit under 已复验缺陷.
		expect(results[2]).toMatch(/f-001 is under 已复验缺陷 but is not a confirmed defect/);
		expect(results[2]).not.toMatch(/no knowledge-base write/);
		expect(listLessons(join(m.home, ".prelude", "kb"), "rest-api")).toHaveLength(0);
	});
});
