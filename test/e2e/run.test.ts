/**
 * One full Prelude test against the canary with a faux model (plan M1-10): /test → findings →
 * verify_findings (rerun + review sub-sessions) → report_finalize, plus gate blocks and audit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAudit, verifyAudit } from "../../src/audit.ts";
import type { Prelude } from "../../src/context.ts";
import { createPrelude } from "../../src/index.ts";
import { TEST_PILOT } from "../../src/mode.ts";
import { Run } from "../../src/run.ts";
import { startCanary, type TempProject, tempProject } from "../helpers.ts";
import { call, createRouter, type Router, say, type Step } from "./faux.ts";

/** Real defect: concurrent orders oversell (canary B1). Exit 1 = reproduced. */
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

/** Reproduces every time, but asserts a made-up price: the reviewer must reject it. */
const WEAK = (url: string) => `const r = await (await fetch(${JSON.stringify(`${url}/products/p1`)})).json();
console.log("price", r.price);
process.exit(r.price === 10 ? 0 : 1);
`;

/** Never reproduces. */
const NOISE = `console.log("all good"); process.exit(0);\n`;

const REPORT = `# canary 测试报告

## 结论

发现 1 个已复验缺陷：并发下单超卖。

## 已复验缺陷

### f-001 并发下单超卖（critical）

- 复现 3/3。

## 建议

无

## 未复现项

- f-002 审查拒绝：预期价格没有依据。
- f-003 未复现。

## 测了什么

下单并发、商品读取。

## 没测什么

安全测试：未授权。

## 隔离级别

仅工具层策略，不是安全边界。
`;

let p: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let session: AgentSession | undefined;
let prelude: Prelude | undefined;

beforeEach(async () => {
	p = tempProject();
	canary = await startCanary({ bugs: new Set(["B1"]) });
	mkdirSync(p.paths.dir, { recursive: true });
	writeFileSync(
		p.paths.scopeFile,
		JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, allowed: ["functional"] }] }),
	);
});

afterEach(async () => {
	if (session) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		session = undefined;
	}
	await canary.close();
	p.cleanup();
});

async function mainSession(router: Router, sessionManager = SessionManager.inMemory(p.root)) {
	const loader = new DefaultResourceLoader({
		cwd: p.root,
		agentDir: p.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			createPrelude(
				{ home: p.home, agentDir: p.agentDir, modelRuntime: router.runtime, rerun: { runs: 3, timeoutMs: 20_000 } },
				(x) => {
					prelude = x;
				},
			),
		],
	});
	await loader.reload();
	const { session: s } = await createAgentSession({
		cwd: p.root,
		agentDir: p.agentDir,
		model: router.model(),
		modelRuntime: await router.runtime(),
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	});
	await s.bindExtensions({});
	return s;
}

/** `/test <goal>` hands the goal on with sendUserMessage, so the run starts after prompt() returns. */
async function runCommand(s: AgentSession, text: string) {
	const settled = new Promise<void>((resolve) => {
		const off = s.subscribe((e) => {
			if (e.type === "agent_settled") {
				off();
				resolve();
			}
		});
	});
	await s.prompt(text);
	await settled;
}

const write = (path: string, content: string): Step => call("write", { path, content });

describe("a Prelude test run", () => {
	it("records, verifies and reports; only confirmed defects count", async () => {
		const blocked: string[] = [];
		const expectBlocked: Step = (ctx) => {
			blocked.push(ctx.lastToolResult().text);
			return say("noted")(ctx);
		};
		const main: Step[] = [
			call("test_progress", { phase: "execute" }),
			write(".prelude/work/oversell.mjs", OVERSELL(canary.url)),
			write(".prelude/work/weak.mjs", WEAK(canary.url)),
			write(".prelude/work/noise.mjs", NOISE),
			// Gate: the model cannot widen its own scope or reach other hosts.
			write(".prelude/scope.json", '{"targets":[{"host":"*","allowed":["destructive"]}]}'),
			(ctx) => {
				blocked.push(ctx.lastToolResult().text);
				return call("bash", { command: "curl -s http://localhost:1/x" })(ctx);
			},
			(ctx) => {
				blocked.push(ctx.lastToolResult().text);
				return call("finding_record", {
					title: "并发下单超卖",
					severity: "critical",
					kind: "defect",
					description: "30 个并发下单，库存 10，接受数超过库存。预期：接受数 ≤ 初始库存（库存守恒）。",
					repro: ".prelude/work/oversell.mjs",
				})(ctx);
			},
			call("finding_record", {
				title: "价格错误",
				severity: "high",
				kind: "defect",
				description: "p1 的价格应为 10。",
				repro: ".prelude/work/weak.mjs",
			}),
			call("finding_record", {
				title: "偶发问题",
				severity: "low",
				kind: "defect",
				description: "看起来偶尔失败。",
				repro: ".prelude/work/noise.mjs",
			}),
			call("verify_findings", {}),
			write(".prelude/reports/2026-10-27-canary.md", REPORT),
			call("report_finalize", { path: ".prelude/reports/2026-10-27-canary.md" }),
			expectBlocked,
		];
		const reviewer: Step[] = [
			call("review_verdict", { verdict: "confirmed", reason: "断言基于库存守恒，输出显示接受数超过库存" }),
			call("review_verdict", { verdict: "rejected", reason: "预期价格 10 没有依据，文档未给出" }),
		];
		const router = createRouter(p.base, { main, reviewer });
		session = await mainSession(router);

		await runCommand(session, `/test 测一下 ${canary.url} 这个服务`);

		expect(prelude?.enabled).toBe(true);
		const run = new Run(p.paths, prelude?.runId ?? "");
		const findings = run.findings();
		expect(findings.map((f) => [f.id, f.verification?.verdict])).toEqual([
			["f-001", "confirmed"],
			["f-002", "rejected"],
			["f-003", "not-reproduced"],
		]);
		expect(findings[0].verification?.rerun).toMatchObject({ runs: 3, reproduced: 3 });
		expect(findings[2].verification?.rerun?.reproduced).toBe(0);
		expect(run.state()).toMatchObject({
			goal: `测一下 ${canary.url} 这个服务`,
			phase: "report",
			report: { path: ".prelude/reports/2026-10-27-canary.md" },
		});
		expect(existsSync(join(run.paths.verifyDir, "f-001", "run-3", "output.txt"))).toBe(true);

		// The reviewer saw the claim, script and output, never the test conversation.
		const reviews = router.seen.filter((s) => s.actor === "reviewer");
		expect(reviews.map((r) => r.firstUser.match(/## 发现 (f-\d+)/)?.[1])).toEqual(["f-001", "f-002"]);
		expect(reviews[0].firstUser).toContain('"accepted"');
		expect(reviews[0].tools.sort()).toEqual(["bash", "read", "review_verdict"]);
		expect(reviews.every((r) => !r.firstUser.includes("测一下"))).toBe(true);

		// Main session: prompt section, test-pilot skill, tools added without narrowing.
		const mainSeen = router.seen.find((s) => s.actor === "main");
		expect(mainSeen?.sections.prelude).toContain("test-pilot");
		expect(mainSeen?.tools).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "finding_record", "questionnaire"]),
		);
		expect(mainSeen?.sections.skills).toContain("test-pilot");
		expect(mainSeen?.sections.prelude).toContain(TEST_PILOT.replace(/\\/g, "/"));

		// Gate blocks and the audit chain (M1 acceptance 4).
		expect(blocked[0]).toMatch(/scope\.json is maintained by the user only/);
		expect(blocked[1]).toMatch(/localhost:1 is not in \.prelude\/scope\.json; no user is present/);
		expect(blocked[2]).toMatch(/Report registered.*Verified defects: f-001/s);
		expect(blocked[2]).toMatch(/System notes were not updated/);
		expect(JSON.parse(readFileSync(p.paths.scopeFile, "utf8")).targets).toHaveLength(1);
		expect(verifyAudit(p.paths.auditFile).ok).toBe(true);
		const audit = readAudit(p.paths.auditFile);
		expect(audit.filter((a) => a.decision === "block").map((a) => a.tool)).toEqual(["write", "bash"]);
		expect(audit.filter((a) => a.event === "verification").map((a) => [a.finding, a.decision])).toEqual([
			["f-001", "confirmed"],
			["f-002", "rejected"],
			["f-003", "not-reproduced"],
		]);
		expect(audit.find((a) => a.event === "tool_call")?.run).toBe(run.id);

		// /prelude-init ran on first /test (M1-2).
		expect(existsSync(p.paths.projectFile)).toBe(true);
		expect(readFileSync(p.paths.agentsFile, "utf8")).toContain("prelude:begin");
	});

	it("rejects a report whose defect list disagrees with the verdicts", async () => {
		const results: string[] = [];
		const keep: Step = (ctx) => {
			results.push(ctx.lastToolResult().text);
			return say("ok")(ctx);
		};
		const main: Step[] = [
			write(".prelude/work/oversell.mjs", OVERSELL(canary.url)),
			call("finding_record", {
				title: "超卖",
				severity: "critical",
				kind: "defect",
				description: "d",
				repro: ".prelude/work/oversell.mjs",
			}),
			call("report_finalize", { path: ".prelude/reports/r.md" }),
			(ctx) => {
				results.push(ctx.lastToolResult().text);
				return write(".prelude/reports/r.md", REPORT)(ctx);
			},
			call("report_finalize", { path: ".prelude/reports/r.md" }),
			keep,
		];
		const router = createRouter(p.base, { main });
		session = await mainSession(router);
		await runCommand(session, `/test ${canary.url}`);
		expect(results[0]).toMatch(/report not found/);
		expect(results[1]).toMatch(/not verified yet: f-001/);
		expect(results[1]).toMatch(/f-001 is under 已复验缺陷 but is not a confirmed defect/);
		expect(new Run(p.paths, prelude?.runId ?? "").state().report).toBeUndefined();
	});

	it("toggles off with /test and restores test mode on resume", async () => {
		const router = createRouter(p.base, { main: [say("on")], plain: [say("off")] });
		session = await mainSession(router);
		await runCommand(session, "/test 看看");
		const runId = prelude?.runId;
		const entries = [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()].filter(
			(e) => e !== null,
		);

		await session.prompt("/test");
		expect(prelude?.enabled).toBe(false);
		await session.prompt("hello");
		expect(router.seen.map((s) => s.actor)).toEqual(["main", "plain"]);
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();

		// A session resumed from the entries saved while the test ran comes back in test mode.
		const resumed = createRouter(p.base, { main: [say("back")] });
		session = await mainSession(resumed, SessionManager.inMemory(p.root, undefined, entries));
		expect(prelude?.enabled).toBe(true);
		expect(prelude?.runId).toBe(runId);
		await session.prompt("继续");
		expect(resumed.seen[0].actor).toBe("main");
		expect(resumed.seen[0].tools).toContain("finding_record");
	});

	it("is off outside /test: no prompt section, no test tools, no test-pilot", async () => {
		const router = createRouter(p.base, { plain: [say("hi")] });
		session = await mainSession(router);
		await session.prompt("hello");
		const seen = router.seen[0];
		expect(seen.actor).toBe("plain");
		expect(seen.tools).not.toContain("finding_record");
		expect(seen.sections.prelude).toBeUndefined();
		expect(seen.sections.skills ?? "").not.toContain("test-pilot");
	});
});
