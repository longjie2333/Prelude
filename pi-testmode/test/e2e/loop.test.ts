import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestmodeExtension } from "../../src/mode.ts";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { getIntent, listAudit, listMissions, listTestRuns } from "../../src/store/repos.ts";
import { startCanary, type TempProject, tempProject, waitFor } from "../helpers.ts";
import { createRouter, idFrom, type Step } from "./faux.ts";

const OVERSELL = (url: string) => `const base = process.argv[2] ?? ${JSON.stringify(url)};
const j = (m, p, b) => fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) });
await j("POST", "/reset");
const before = (await (await j("GET", "/products/p1")).json()).stock;
const rs = await Promise.all(Array.from({ length: 30 }, () => j("POST", "/orders", { productId: "p1", qty: 1 })));
const accepted = rs.filter((r) => r.status === 201).length;
const after = (await (await j("GET", "/products/p1")).json()).stock;
console.log(JSON.stringify({ before, accepted, after }));
process.exit(accepted <= before && after === before - accepted && after >= 0 ? 0 : 1);
`;

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]): Step => () => fauxAssistantMessage(fauxToolCall(name, args));

let p: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let session: AgentSession | undefined;

beforeEach(async () => {
	p = tempProject();
	canary = await startCanary({ bugs: new Set(["B1"]) });
	mkdirSync(p.paths.dir, { recursive: true });
	writeFileSync(
		p.paths.scopeFile,
		JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, envs: ["local"], allowed: ["functional", "load"] }], egress_allowlist: [] }),
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

async function mainSession(router: ReturnType<typeof createRouter>, onOrchestrator: (o: Orchestrator) => void) {
	const runtime = await router.runtime();
	const loader = new DefaultResourceLoader({
		cwd: p.root,
		agentDir: p.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			createTestmodeExtension({
				agentDir: p.agentDir,
				modelRuntime: router.runtime,
				orchestrator: { noSandbox: true, notifyDebounceMs: 50, heartbeatMs: 200, missionSettings: { retry: { enabled: false } } },
				onOrchestrator,
			}),
		],
	});
	await loader.reload();
	const { session: s } = await createAgentSession({
		cwd: p.root,
		agentDir: p.agentDir,
		model: router.model(),
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(p.root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	});
	await s.bindExtensions({});
	return s;
}

describe("test mode loop", () => {
	it("dispatches, settles, wakes on results, and reports a verified defect", async () => {
		let intentId = "";
		const outside = join(p.root, "src", "hack.ts");
		const scripts: Record<string, Step[]> = {
			main: [
				call("intent_record", {
					raw: "测一下 canary 的下单接口在并发下会不会超卖",
					goal: { kind: "find_defects", quality_attributes: ["correctness.consistency"], hypotheses: ["concurrent orders oversell stock"] },
					sut_refs: [{ kind: "api", locator: `${canary.url}/openapi.json`, env: "local" }],
					constraints: { environment: "local", data: "synthetic-only" },
					acceptance: ["evidence-backed verdict on the oversell hypothesis"],
					assumptions: ["30 concurrent single-item orders"],
					open_questions: [],
				}),
				(ctx) => {
					intentId = idFrom(ctx.lastToolResult(), "i");
					return fauxAssistantMessage(
						fauxToolCall("mission_dispatch", {
							intent_id: intentId,
							missions: [{ role: "executor", objective: "Check POST /orders for oversell under 30 concurrent orders", targets: [canary.url], test_kinds: ["functional", "load"], context: "POST /reset restores seed data" }],
						}),
					);
				},
				// Woken by the mission results.
				(ctx) => {
					expect(ctx.lastUserText()).toContain("confirmed");
					return fauxAssistantMessage(fauxToolCall("report_finalize", { intent_id: intentId, conclusion: "Concurrent orders oversell p1 (B1)." }));
				},
				() => fauxAssistantMessage(fauxText("Report written.")),
			],
			executor: [
				// Policy probes: all must be blocked and audited.
				(ctx) => fauxAssistantMessage([
					fauxToolCall("write", { path: outside, content: "x" }),
					fauxToolCall("write", { path: p.paths.scopeFile, content: "{}" }),
					fauxToolCall("bash", { command: "npm i autocannon" }),
					fauxToolCall("bash", { command: "curl -s https://example.com/" }),
				]),
				(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "oversell.mjs"), content: OVERSELL(canary.url) })),
				call("artifact_freeze", { paths: ["oversell.mjs"] }),
				(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "oversell.mjs"), content: "process.exit(0)" })),
				call("test_run", { command: "node oversell.mjs", purpose: "conservation invariant under concurrency" }),
				// A defect claim without a test_run is rejected.
				call("mission_submit", { status: "completed", summary: "s", claims: [{ id: "c1", type: "defect", statement: "oversell" }] }),
				(ctx) => {
					const runId = idFrom(ctx.toolResults().find((r) => r.toolName === "test_run")?.text ?? "", "tr");
					return fauxAssistantMessage(
						fauxToolCall("mission_submit", {
							status: "completed",
							summary: "Oversell reproduced with 30 concurrent orders.",
							claims: [{ id: "c1", type: "defect", statement: "Concurrent orders oversell p1", test_run_ids: [runId], oracle: { kind: "conservation-invariant", strength: "high" }, minimal_repro: "node oversell.mjs" }],
							goal_coverage: [{ goal: "order concurrency", status: "covered" }],
							test_strength: "30 concurrent orders x 1",
						}),
					);
				},
			],
			verifier: [
				call("test_run", { command: "node oversell.mjs" }),
				call("test_run", { command: "node oversell.mjs" }),
				(ctx) => {
					const ids = ctx.toolResults().filter((r) => r.toolName === "test_run").map((r) => idFrom(r.text, "tr"));
					return fauxAssistantMessage(
						fauxToolCall("mission_submit", {
							status: "completed",
							summary: "Replayed twice.",
							claims: [{ id: "v1", type: "observation", statement: "replayed the frozen script" }],
							verification: [{ claim_id: "c1", test_run_ids: ids }],
						}),
					);
				},
			],
		};
		const router = createRouter(p.agentDir, scripts);
		let orch: Orchestrator | undefined;
		session = await mainSession(router, (o) => (orch = o));

		const settledSnapshots: string[][] = [];
		session.subscribe((e) => {
			if (e.type === "agent_settled" && orch) settledSnapshots.push(listMissions(orch.store).map((m) => `${m.role}:${m.status}`));
		});

		await session.prompt("/test");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["mission_dispatch", "intent_record"]));
		expect(session.getActiveToolNames()).not.toContain("bash");

		await session.prompt("测一下 canary 的下单接口在并发下会不会超卖");
		// mission_dispatch terminated the turn: the main session settled while the mission runs.
		expect(settledSnapshots[0]?.some((x) => /^executor:(queued|running)$/.test(x))).toBe(true);

		await waitFor(() => getIntent(p.store, intentId)?.status === "closed", 45_000);
		await waitFor(() => router.remaining("main") === 0 && session?.isStreaming === false, 10_000);

		const missions = listMissions(p.store, { intentId });
		expect(missions.map((m) => `${m.role}:${m.status}`).sort()).toEqual(["executor:completed", "verifier:completed"]);
		const verifier = missions.find((m) => m.role === "verifier");
		expect(verifier?.parentId).toBe(missions.find((m) => m.role === "executor")?.id);
		expect(listTestRuns(p.store, verifier?.id as string).every((r) => r.verdict === "fail")).toBe(true);

		// No polling: main never called mission_status.
		expect(router.seen.filter((s) => s.info.actor === "main")).toHaveLength(4);
		const report = readFileSync(getIntent(p.store, intentId)?.reportPath as string, "utf8");
		if (process.env.TESTMODE_DEBUG) {
			writeFileSync(join(process.cwd(), "tmp", "loop-report.md"), report);
			writeFileSync(join(process.cwd(), "tmp", "loop-audit.txt"), listAudit(p.store).map((a) => `${a.actor} ${a.event} ${a.tool ?? ""} ${a.decision ?? ""} ${a.reason ?? ""}`).join("\n"));
		}
		expect(report).toContain("## Verified defects (1)");
		expect(report).toContain("**confirmed**");
		expect(report).toContain("tool-layer policy only");

		const audit = listAudit(p.store);
		const blocked = audit.filter((a) => a.event === "tool_call" && a.decision === "block").map((a) => `${a.tool}: ${a.reason}`);
		expect(blocked.some((b) => b.startsWith("write:") && b.includes("run directory"))).toBe(true);
		expect(blocked.some((b) => b.startsWith("write:") && b.includes("scope.json"))).toBe(true);
		expect(blocked.some((b) => b.startsWith("write:") && b.includes("frozen"))).toBe(true);
		expect(blocked.some((b) => b.startsWith("bash:") && b.includes("npm i autocannon"))).toBe(true);
		expect(blocked.some((b) => b.startsWith("bash:") && b.includes("example.com"))).toBe(true);
		expect(audit.some((a) => a.event === "approval" && a.decision === "denied" && a.reason?.includes("dep:npm i autocannon"))).toBe(true);
		expect(audit.filter((a) => a.event === "wake")).toHaveLength(1);
		expect(audit.every((a) => !a.reason?.includes("process.exit"))).toBe(true); // inputs are digested, never stored
		expect(existsSync(outside)).toBe(false);
	});

	it("refuses an executor mission without an authorization scope", async () => {
		let intentId = "";
		const scripts: Record<string, Step[]> = {
			main: [
				call("intent_record", {
					raw: "r",
					goal: { kind: "find_defects", quality_attributes: [], hypotheses: [] },
					sut_refs: [{ kind: "api", locator: canary.url }],
					constraints: { environment: "local" },
					acceptance: ["a"],
					assumptions: [],
					open_questions: [],
				}),
				(ctx) => {
					intentId = idFrom(ctx.lastToolResult(), "i");
					return fauxAssistantMessage(fauxToolCall("mission_dispatch", { intent_id: intentId, missions: [{ role: "executor", objective: "o", targets: [canary.url], test_kinds: ["functional"] }] }));
				},
				(ctx) => fauxAssistantMessage(fauxText(ctx.lastToolResult())),
			],
		};
		writeFileSync(p.paths.scopeFile, "not json");
		const router = createRouter(p.agentDir, scripts);
		session = await mainSession(router, () => undefined);
		await session.prompt("/test");
		await session.prompt("go");
		const last = router.seen.at(-1);
		expect(last?.info.actor).toBe("main");
		expect(listMissions(p.store)).toHaveLength(0);
		expect(session.getLastAssistantText()).toMatch(/NOT dispatched.*authorization scope/s);
	});
});
