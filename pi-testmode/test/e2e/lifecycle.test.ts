/** Mission lifecycle edges (plan M1-8, M1-9, M1-14 §5): network loss, budget, shutdown. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capShellTimeout } from "../../src/kernel/policy-extension.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { getMission, insertIntent, listAudit } from "../../src/store/repos.ts";
import { type TempProject, tempProject, waitFor } from "../helpers.ts";
import { createRouter, type Step } from "./faux.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
	insertIntent(p.store, "i-1", "r", { constraints: { environment: "local" } });
});
afterEach(() => p.cleanup());

function orchestrator(scripts: Record<string, Step[]>) {
	const router = createRouter(p.agentDir, scripts);
	const o = new Orchestrator({
		paths: p.paths,
		agentDir: p.agentDir,
		store: p.store,
		modelRuntime: router.runtime,
		noSandbox: true,
		heartbeatMs: 50,
		notifyDebounceMs: 10,
		missionSettings: { retry: { enabled: false } },
	});
	return { o, router };
}

async function dispatchScout(o: Orchestrator, router: ReturnType<typeof createRouter>, budget?: { tokens?: number }) {
	const [r] = await o.dispatch("i-1", [{ role: "scout", objective: "look around", targets: [], testKinds: [], budget }], router.model());
	if (!r.ok) throw new Error(r.reason);
	return r.missionId;
}

const submit: Step = () => fauxAssistantMessage(fauxToolCall("mission_submit", { status: "completed", summary: "done", claims: [] }));
/** A turn that adds ~2k genuinely new tokens (its own output) and keeps calling tools. */
const chatter: Step = () => fauxAssistantMessage([fauxText(`thinking aloud ${"x".repeat(8000)}`), fauxToolCall("ls", { path: "." })]);

describe("mission lifecycle", () => {
	it("network loss after retries parks the mission as interrupted(network); it resumes later", async () => {
		const { o, router } = orchestrator({
			scout: [() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "fetch failed: ECONNRESET" }), submit],
		});
		const id = await dispatchScout(o, router);
		await waitFor(() => getMission(p.store, id)?.status === "interrupted");
		expect(getMission(p.store, id)?.interruptReason).toBe("network");

		const delivered: string[] = [];
		o.attachMain({ notify: (c) => (delivered.push(c), true) });
		await waitFor(() => delivered.length === 1);
		expect(delivered[0]).toContain("interrupted/network");

		expect((await o.resumeMission(id)).kind).toBe("resumed");
		await waitFor(() => getMission(p.store, id)?.status === "completed");
		await waitFor(() => delivered.length === 2);
		await o.shutdown();
	});

	it("a mission that blows its budget ends partial; requested budgets have a floor", async () => {
		const { o, router } = orchestrator({ scout: Array.from({ length: 200 }, () => chatter) });
		const id = await dispatchScout(o, router, { tokens: 2000 });
		expect(getMission(p.store, id)?.budget.tokens).toBe(30_000); // half the scout default
		await waitFor(() => getMission(p.store, id)?.status === "partial", 60_000);
		const m = getMission(p.store, id);
		expect(m?.error).toMatch(/budget/);
		// The budget counts new tokens; the processed total (resent context) is much larger.
		expect(m?.cost.processed).toBeGreaterThan(2 * (m?.cost.tokens ?? 0));
		await o.shutdown();
	}, 90_000);

	it("at 100% of the budget a mission may still submit; it is aborted only past the grace margin", async () => {
		// The scout keeps calling ls until it is told the budget is exhausted, then submits.
		const steps: Step[] = Array.from({ length: 200 }, () => (ctx) => (ctx.lastUserText().includes("Budget exhausted") ? submit(ctx) : chatter(ctx)));
		const { o, router } = orchestrator({ scout: steps });
		const id = await dispatchScout(o, router, { tokens: 2000 });
		await waitFor(() => ["completed", "partial"].includes(getMission(p.store, id)?.status ?? ""), 60_000);
		const m = getMission(p.store, id);
		expect(m?.status).toBe("completed");
		expect(m?.cost.tokens).toBeGreaterThanOrEqual(m?.budget.tokens ?? 0);
		await o.shutdown();
	}, 90_000);

	it("caps mission shell timeouts", () => {
		const a: Record<string, unknown> = { command: "find . -name x" };
		capShellTimeout("bash", a);
		expect(a.timeout).toBe(120);
		const b: Record<string, unknown> = { command: "x", timeout: 30 };
		capShellTimeout("powershell", b);
		expect(b.timeout).toBe(30);
		const c: Record<string, unknown> = { command: "x", timeout: 9999 };
		capShellTimeout("bash", c);
		expect(c.timeout).toBe(120);
		const d: Record<string, unknown> = { path: "x" };
		capShellTimeout("read", d);
		expect(d.timeout).toBeUndefined();
	});

	it("session shutdown aborts running missions; they are offered again on re-entry", async () => {
		mkdirSync(p.paths.dir, { recursive: true });
		writeFileSync(p.paths.scopeFile, JSON.stringify({ targets: [{ host: "localhost:1", allowed: ["functional"] }] }));
		const slow: Step = () => fauxAssistantMessage(fauxToolCall("test_run", { command: "sleep 5" }));
		const { o, router } = orchestrator({ executor: [slow, () => fauxAssistantMessage(fauxText("never"))] });
		const [r] = await o.dispatch("i-1", [{ role: "executor", objective: "slow", targets: [], testKinds: ["functional"] }], router.model());
		const id = r.ok ? r.missionId : "";
		await waitFor(() => listAudit(p.store).some((a) => a.actor === `mission:${id}` && a.event === "tool_call" && a.decision === "allow"));
		await o.shutdown();
		expect(getMission(p.store, id)).toMatchObject({ status: "aborted", interruptReason: "shutdown" });

		const { o: next } = orchestrator({});
		expect(next.recoverOnStartup()).toHaveLength(0);
		expect(next.parkedMissions().map((m) => m.id)).toEqual([id]);
		const newId = next.redispatch(id);
		expect(getMission(p.store, id)?.error).toContain(newId);
		expect(next.parkedMissions()).toHaveLength(0);
		await next.shutdown();
	});

	it("runs at most `concurrency` missions at once", async () => {
		const router = createRouter(p.agentDir, { scout: Array.from({ length: 3 }, () => submit) });
		const o = new Orchestrator({ paths: p.paths, agentDir: p.agentDir, store: p.store, modelRuntime: router.runtime, noSandbox: true, concurrency: 1 });
		const ids = await Promise.all([dispatchScout(o, router), dispatchScout(o, router), dispatchScout(o, router)]);
		expect(o.runningCount()).toBeLessThanOrEqual(1);
		await waitFor(() => ids.every((id) => getMission(p.store, id)?.status === "completed"));
		await o.shutdown();
	});
});
