/**
 * Crash recovery e2e (plan M1-14 §9, acceptance M1 #5): kill the host process while tools are
 * executing, restart, and check that
 * - completed calls are not executed again,
 * - a half-done side-effecting call parks the mission as blocked and asks for confirmation,
 * - the interrupted test_run's verdict is void,
 * - the main session gets the deferred wake-up message.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { getJournal, getMission, listAudit, listMissions, listTestRuns } from "../../src/store/repos.ts";
import { startCanary, type TempProject, tempProject, waitFor } from "../helpers.ts";
import { createRouter, type Ctx } from "./faux.ts";

let p: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let child: ChildProcess | undefined;

beforeEach(async () => {
	p = tempProject();
	canary = await startCanary({ bugs: new Set() });
	mkdirSync(p.paths.dir, { recursive: true });
	writeFileSync(p.paths.scopeFile, JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, allowed: ["functional"] }] }));
});

afterEach(async () => {
	if (child && child.exitCode === null) child.kill("SIGKILL");
	await canary.close();
	p.cleanup();
});

async function orderCount(): Promise<number> {
	const r = await fetch(`${canary.url}/orders`);
	return ((await r.json()) as { items: unknown[] }).items.length;
}

describe("crash recovery", () => {
	it("restores finished calls, blocks on unknown side effects, voids the test_run, and re-delivers the wake-up", async () => {
		child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "crash-child.ts")], {
			env: { ...process.env, TM_ROOT: p.root, TM_AGENT: p.agentDir, CANARY_URL: canary.url, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout?.on("data", (b) => (out += b));
		child.stderr?.on("data", (b) => (out += b));
		const missionId = (await waitFor(() => out.match(/"missionId":"(m-[^"]+)"/)?.[1], 30_000).catch(() => {
			throw new Error(`child did not dispatch:\n${out}`);
		})) as string;

		// Kill once the slow calls are mid-execution and the fast side effects landed.
		await waitFor(() => getJournal(p.store, missionId, "hang") && getJournal(p.store, missionId, "tr1") && getJournal(p.store, missionId, "post2")?.status === "finished", 30_000);
		await waitFor(async () => (await orderCount()) >= 3, 10_000);
		const exited = new Promise((r) => child?.once("exit", r));
		child.kill("SIGKILL");
		await exited;

		expect(getMission(p.store, missionId)?.status).toBe("running");
		expect(await orderCount()).toBe(3); // post1, post2, and the first half of "hang"
		const sessionPath = getMission(p.store, missionId)?.sessionPath as string;
		expect(existsSync(sessionPath)).toBe(true);

		// Restart: a new orchestrator in a new "process" (fresh runner, same store files).
		let resumedCtx: Ctx | undefined;
		const router = createRouter(p.agentDir, {
			executor: [
				(ctx) => {
					resumedCtx = ctx;
					return fauxAssistantMessage(
						fauxToolCall("mission_submit", { status: "partial", summary: "resumed after crash", claims: [{ id: "o1", type: "observation", statement: "orders placed" }] }),
					);
				},
			],
		});
		const o = new Orchestrator({ paths: p.paths, agentDir: p.agentDir, store: p.store, modelRuntime: router.runtime, noSandbox: true, notifyDebounceMs: 20, missionSettings: { retry: { enabled: false } } });
		const marked = o.recoverOnStartup();
		expect(marked.map((m) => [m.id, m.status, m.interruptReason])).toEqual([[missionId, "interrupted", "crash"]]);
		expect(o.parkedMissions().map((m) => m.id)).toEqual([missionId]);

		const first = await o.resumeMission(missionId);
		expect(first).toEqual({ kind: "needs_confirmation", tools: ["bash"] });
		expect(getMission(p.store, missionId)?.status).toBe("blocked");
		const tr = listTestRuns(p.store, missionId);
		expect(tr).toHaveLength(1);
		expect(tr[0]).toMatchObject({ verdict: "inconclusive", verdictNote: "interrupted: verdict void" });

		const second = await o.resumeMission(missionId, true);
		expect(second.kind).toBe("resumed");
		await waitFor(() => getMission(p.store, missionId)?.status === "partial", 30_000);

		// The resumed conversation saw real or explicit results for every orphan, never a synthetic one.
		const results = resumedCtx?.toolResults() ?? [];
		const byId = Object.fromEntries(results.map((r) => [r.toolCallId, r]));
		expect(byId.post1?.text).toContain('"status":"placed"');
		expect(byId.post2?.text).toContain('"status":"placed"');
		expect(byId.hang?.text).toMatch(/UNKNOWN/);
		expect(byId.tr1?.text).toMatch(/safe to re-run/);
		expect(results.some((r) => r.text === "No result provided")).toBe(false);
		expect(resumedCtx?.lastUserText()).toMatch(/interrupted \(crash\)/);
		expect(await orderCount()).toBe(3); // nothing re-executed

		// Outbox: the result waits until a main session is attached, then is delivered once.
		expect(getMission(p.store, missionId)?.notifiedAt).toBeNull();
		const delivered: string[] = [];
		o.attachMain({ notify: (content) => (delivered.push(content), true) });
		await waitFor(() => delivered.length > 0, 5000);
		expect(delivered[0]).toContain(missionId);
		expect(getMission(p.store, missionId)?.notifiedAt).not.toBeNull();
		expect(o.flushNotifications()).toBe(0);

		const events = listAudit(p.store).map((a) => a.event);
		expect(events).toEqual(expect.arrayContaining(["mission_interrupted", "mission_blocked", "mission_resume", "mission_end", "wake"]));
		expect(getMission(p.store, missionId)?.resumeCount).toBe(1);
		await o.shutdown();
	});

	it("re-runs a mission that crashed before its session was persisted", async () => {
		const router = createRouter(p.agentDir, {
			executor: [() => fauxAssistantMessage(fauxToolCall("mission_submit", { status: "completed", summary: "ok", claims: [] }))],
		});
		const o = new Orchestrator({ paths: p.paths, agentDir: p.agentDir, store: p.store, modelRuntime: router.runtime, noSandbox: true });
		p.store.run("INSERT INTO intents (id, raw, ir_json, created_at) VALUES ('i-1', 'r', '{}', 'now')");
		p.store.run(
			`INSERT INTO missions (id, intent_id, role, objective, spec_json, status, risk_tier, budget_json, run_dir, owner_pid, heartbeat_at, created_at)
			 VALUES ('m-1', 'i-1', 'executor', 'o', $spec, 'running', 'R2', $b, $run, 999999, '2000-01-01T00:00:00Z', 'now')`,
			{
				$spec: JSON.stringify({ missionId: "m-1", intentId: "i-1", role: "executor", objective: "o", targets: [], testKinds: [], riskTier: "R2", riskReasons: [], budget: { tokens: 1e6, wallClockMs: 60_000 }, model: { provider: "faux", id: router.model().id } }),
				$b: JSON.stringify({ tokens: 1e6, wallClockMs: 60_000 }),
				$run: join(p.paths.runsDir, "m-1"),
			},
		);
		expect(o.recoverOnStartup().map((m) => m.status)).toEqual(["interrupted"]);
		expect((await o.resumeMission("m-1")).kind).toBe("restarted");
		await waitFor(() => getMission(p.store, "m-1")?.status === "completed", 20_000);
		await o.shutdown();
	});

	it("leaves missions of another live process alone and gives up after two resumes", async () => {
		const router = createRouter(p.agentDir, {});
		const o = new Orchestrator({ paths: p.paths, agentDir: p.agentDir, store: p.store, modelRuntime: router.runtime, noSandbox: true });
		p.store.run("INSERT INTO intents (id, raw, ir_json, created_at) VALUES ('i-1', 'r', '{}', 'now')");
		const insert = (id: string, status: string, pid: number | null, heartbeat: string, resumes = 0) =>
			p.store.run(
				`INSERT INTO missions (id, intent_id, role, objective, spec_json, status, risk_tier, budget_json, run_dir, owner_pid, heartbeat_at, resume_count, session_path, created_at)
				 VALUES ($id, 'i-1', 'executor', 'o', '{}', $st, 'R2', '{}', $run, $pid, $hb, $rc, $sp, 'now')`,
				{ $id: id, $st: status, $run: join(p.paths.runsDir, id), $pid: pid, $hb: heartbeat, $rc: resumes, $sp: join(p.root, "missing.jsonl") },
			);
		// The test runner's parent process stands in for "another live pi process".
		insert("m-live", "running", process.ppid, new Date().toISOString());
		insert("m-tired", "interrupted", null, "2000-01-01T00:00:00Z", 2);
		expect(o.recoverOnStartup()).toHaveLength(0);
		expect(getMission(p.store, "m-live")?.status).toBe("running");
		expect(await o.resumeMission("m-tired")).toMatchObject({ kind: "failed" });
		expect(getMission(p.store, "m-tired")?.status).toBe("failed");
		expect(listMissions(p.store, { statuses: ["failed"] })).toHaveLength(1);
		await o.shutdown();
	});
});
