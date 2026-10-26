/**
 * M3 acceptance (plan §10, scenario of agent-core §14) on the canary, driven through the
 * orchestrator with scripted missions:
 * 1 reinforce: two resource kinds × 2 runs in sync mode → draft → candidate → stable;
 * 2 boundary: CONSISTENCY=eventual false positives → U with a new facet hypothesis
 *   (consistency.model) → probe → B ×3 → gated `except` (settle-then-check); cornerstones keep
 *   their verdicts; in-domain β unchanged;
 * 3 the exception catches B4 (S, positive feedback);
 * 4 a delta that would change cornerstone verdicts is rejected with a replay report;
 * 5 tampering with a frozen assertion → credibility 0.
 */
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleFingerprint } from "../../src/knowledge/fingerprint.ts";
import { searchTemplates } from "../../src/knowledge/retrieval.ts";
import { getEpisodeByMission, getTemplate, insertRetrieval, listCornerstones, listFacets, listTemplates } from "../../src/knowledge/store.ts";
import { listDeltas, proposeDelta } from "../../src/learning/gate.ts";
import { exceptionSupport, getStats } from "../../src/learning/stats.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { insertIntent, listAudit, listMissions } from "../../src/store/repos.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { debugFile, startCanary, type TempProject, tempProject, waitFor } from "../helpers.ts";
import { createRouter, idFrom, type Router, type Step } from "./faux.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]): Step => () => fauxAssistantMessage(fauxToolCall(name, args));
const ORACLE = "tpl://global/oracle.conservation-invariant";

let p: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let router: Router;
let o: Orchestrator;
const scripts: Record<string, Step[]> = { scout: [], executor: [], verifier: [], curator: [], attributor: [] };

beforeEach(async () => {
	p = tempProject();
	canary = await startCanary({ bugs: new Set(["B1"]) });
	mkdirSync(p.paths.dir, { recursive: true });
	writeFileSync(p.paths.scopeFile, JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, envs: ["local"], allowed: ["functional", "load"] }] }));
	for (const k of Object.keys(scripts)) scripts[k] = [];
	router = createRouter(p.agentDir, scripts);
	o = new Orchestrator({ paths: p.paths, agentDir: p.agentDir, store: p.store, modelRuntime: router.runtime, noSandbox: true, notifyDebounceMs: 10, heartbeatMs: 100, missionSettings: { retry: { enabled: false } } });
});

afterEach(async () => {
	await o.shutdown();
	await canary.close();
	p.cleanup();
});

/** Burst writes, then check initial − accepted == final ≥ 0 (optionally after settling). */
function burst(kind: "inventory" | "quota", opts: { settle?: boolean } = {}): string {
	const url = JSON.stringify(canary.url);
	const [read, write, n] =
		kind === "inventory"
			? [`(await (await fetch(${url} + "/products/p1")).json()).stock`, `fetch(${url} + "/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: "p1", qty: 1 }) })`, 30]
			: [`(await (await fetch(${url} + "/coupons/SAVE10")).json()).remaining`, `fetch(${url} + "/coupons/SAVE10/claim", { method: "POST" })`, 15];
	return `await fetch(${url} + "/reset", { method: "POST" });
const before = ${read};
const rs = await Promise.all(Array.from({ length: ${n} }, () => ${write}));
const accepted = rs.filter((r) => r.status === 201).length;
${opts.settle ? "await new Promise((r) => setTimeout(r, 2500));" : ""}
const after = ${read};
console.log(JSON.stringify({ before, accepted, after }));
process.exit(accepted <= before && after === before - accepted && after >= 0 ? 0 : 1);
`;
}

/** Orders then cancels; after settling, stock must equal initial − placed + cancelled (B4). */
function cancelCheck(): string {
	const url = JSON.stringify(canary.url);
	return `const j = (m, p, b) => fetch(${url} + p, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }).then((r) => r.json());
await fetch(${url} + "/reset", { method: "POST" });
const before = (await j("GET", "/products/p2")).stock;
const orders = [];
for (let i = 0; i < 3; i++) orders.push(await j("POST", "/orders", { productId: "p2", qty: 1 }));
for (const o of orders.slice(0, 2)) await j("POST", "/orders/" + o.id + "/cancel");
await new Promise((r) => setTimeout(r, 2500));
const after = (await j("GET", "/products/p2")).stock;
console.log(JSON.stringify({ before, after }));
process.exit(after === before - 3 + 2 ? 0 : 1);
`;
}

interface ExecPlan {
	script: string;
	resourceKind: "inventory" | "quota";
	consistency?: "eventual";
	deviation?: boolean;
	statement: string;
	templates: () => string[];
}

function executor(plan: ExecPlan): Step[] {
	return [
		(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "check.mjs"), content: plan.script })),
		call("artifact_freeze", { paths: ["check.mjs"] }),
		call("test_run", { command: "node check.mjs" }),
		(ctx) => {
			const runId = idFrom(ctx.toolResults().find((r) => r.toolName === "test_run")?.text ?? "", "tr");
			return fauxAssistantMessage(
				fauxToolCall("mission_submit", {
					status: "completed",
					summary: plan.statement,
					claims: [{ id: "c1", type: "defect", statement: plan.statement, test_run_ids: [runId], oracle: { kind: "conservation-invariant", strength: "high" }, minimal_repro: "node check.mjs" }],
					fingerprint: [
						{ facet: "state.resource_kind", value: plan.resourceKind, conf: 1, src: "objective" },
						...(plan.consistency ? [{ facet: "consistency.model", value: plan.consistency, conf: 0.9, src: "value kept changing for ~2s after the burst" }] : []),
					],
					deviations: plan.deviation ? [{ at: "step-3", expected: "final value readable and stable right after the burst", observed: "value kept changing for ~2s", agent_hypothesis: "writes may apply asynchronously" }] : [],
					used_templates: plan.templates().map((id) => ({ id, role: "applied" as const })),
				}),
			);
		},
	];
}

/** Replays the frozen script, or (settle) writes its own settle-then-check and cites only that. */
function verifier(opts: { settle?: string } = {}): Step[] {
	const steps: Step[] = opts.settle
		? [(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "settled.mjs"), content: opts.settle as string })), call("test_run", { command: "node settled.mjs" }), call("test_run", { command: "node settled.mjs" })]
		: [call("test_run", { command: "node check.mjs" }), call("test_run", { command: "node check.mjs" })];
	steps.push((ctx) => {
		const ids = ctx.toolResults().filter((r) => r.toolName === "test_run").map((r) => idFrom(r.text, "tr"));
		return fauxAssistantMessage(
			fauxToolCall("mission_submit", {
				status: "completed",
				summary: opts.settle ? "re-checked after the system settled" : "replayed",
				claims: [{ id: "v1", type: "observation", statement: opts.settle ? "after settling the invariant holds" : "replayed the frozen check" }],
				verification: [{ claim_id: "c1", test_run_ids: ids, ...(opts.settle ? { note: "settle-then-check" } : {}) }],
			}),
		);
	});
	return steps;
}

const intentIR = (raw: string) => ({
	raw,
	goal: { kind: "find_defects" as const, quality_attributes: ["correctness.consistency"], hypotheses: ["concurrent writes oversell"] },
	sut_refs: [{ kind: "api" as const, locator: `${canary.url}/openapi.json`, env: "local" }],
	constraints: { environment: "local" },
	acceptance: ["verdict"],
	assumptions: [],
	open_questions: [],
});

let seq = 0;
/** One intent end to end: search, dispatch an executor with the best strategy (or `fallback`), finalize, learn. */
async function runIntent(raw: string, plan: Omit<ExecPlan, "templates">, verify: Step[], fallback?: string): Promise<{ intentId: string; missionId: string; templates: string[]; hit: string }> {
	const intentId = `i-m3-${++seq}`;
	insertIntent(p.store, intentId, raw, intentIR(raw));
	const { fingerprint } = assembleFingerprint(p.store, intentIR(raw));
	const r = searchTemplates(p.store, raw, fingerprint);
	insertRetrieval(p.store, { id: `rt-${seq}`, intentId, query: raw, fingerprint, hitLevel: r.hitLevel, cards: r.cards });
	const top = r.cards.find((c) => c.type === "strategy" && c.applicability !== "false");
	const templateIds = top ? [top.id] : fallback ? [fallback] : [];
	let dispatched: string[] = [];
	scripts.executor.push(...executor({ ...plan, templates: () => dispatched }));
	scripts.verifier.push(...verify);
	const [out] = await o.dispatch(intentId, [{ role: "executor", objective: raw, targets: [canary.url], testKinds: ["functional", "load"], templateIds }], router.model());
	if (!out.ok) throw new Error(out.reason);
	dispatched = (listMissions(p.store, { intentId }).find((m) => m.id === out.missionId)?.spec.templates ?? []).map((t) => t.id);
	await waitFor(() => listMissions(p.store, { intentId }).filter((m) => m.role !== "curator").every((m) => ["completed", "partial", "failed", "aborted", "blocked"].includes(m.status)) && listMissions(p.store, { intentId }).length >= 2, 60_000);
	await o.finalizeIntent(intentId, { conclusion: "done" }).learning;
	await o.learningIdle();
	return { intentId, missionId: out.missionId, templates: dispatched, hit: r.hitLevel };
}

const classOf = (missionId: string) => {
	const ep = getEpisodeByMission(p.store, missionId);
	return p.store.get<{ triage_class: string; credibility: number; attribution_json: string }>("SELECT * FROM feedback WHERE episode_id = $e", { $e: ep?.id ?? "" });
};

describe("M3: feedback triage and template evolution", () => {
	it("reinforces to stable, turns eventual-consistency false positives into a gated exception, and the exception catches B4", async () => {
		// Scout: what the SUT is (as in M2), reporting consistency as sync with moderate confidence.
		scripts.scout.push(
			call("mission_submit", {
				status: "completed",
				summary: "REST/JSON order service; stock and coupon quota are shared mutable resources",
				claims: [{ id: "o1", type: "observation", statement: "shared resources: stock, coupon quota" }],
				fingerprint: [
					{ facet: "sut.kind", value: "rest-api", conf: 1 },
					{ facet: "interface.protocol", value: "http/json", conf: 1 },
					{ facet: "state.shared_resource", value: "true", conf: 0.9 },
					{ facet: "sut.stack", value: "node", conf: 0.8 },
					{ facet: "interface.pagination", value: "true", conf: 0.9 },
					{ facet: "consistency.model", value: "sync", conf: 0.6, src: "reads after writes were immediate" },
				],
			}),
		);
		insertIntent(p.store, "i-scout", "learn the SUT", intentIR("learn the SUT"));
		const [sc] = await o.dispatch("i-scout", [{ role: "scout", objective: "learn the SUT", targets: [canary.url], testKinds: ["functional"] }], router.model());
		await waitFor(() => sc.ok && getMission(sc.missionId)?.status === "completed", 30_000);

		// --- Act 1: birth and reinforcement (sync, B1 on)
		scripts.curator.push(
			call("template_propose", {
				name: "concurrency.oversell-invariant",
				type: "strategy",
				card: { title: "Oversell under concurrent writes", summary: "Burst same-key writes; check the conservation invariant." },
				intent_patterns: ["超卖", "超领", "oversell", "over-claim", "并发"],
				oracle: { text: "initial − accepted == final ≥ 0", strength: "high" },
				procedure: [
					{ do: "reset and read the value", expect: "readable and stable" },
					{ do: "burst writes on one key", expect: "some accepted, some rejected" },
					{ do: "read the final value", expect: "readable and stable right after the burst" },
				],
				verdict: { fail_when: "invariant violated", pass_when: "invariant holds", inconclusive_when: "value unreadable" },
				composes: [{ slot: "oracle", ref: ORACLE }],
				body: "Expected values come from the invariant, never from the SUT's output.",
			}),
			call("mission_submit", { status: "completed", summary: "drafted", claims: [{ id: "t1", type: "observation", statement: "drafted" }] }),
		);
		const A = await runIntent("测一下下单接口并发会不会超卖", { script: burst("inventory"), resourceKind: "inventory", statement: "concurrent orders oversell stock" }, verifier(), ORACLE);
		expect(A.hit).toBe("H0");
		await waitFor(() => listMissions(p.store, { intentId: A.intentId }).find((m) => m.role === "curator")?.status === "completed", 30_000);
		const T = listTemplates(p.store).find((t) => t.layer === "project" && t.type === "strategy")?.id as string;
		expect(getTemplate(p.store, T)?.status).toBe("draft");

		const B = await runIntent("再测一次库存超卖", { script: burst("inventory"), resourceKind: "inventory", statement: "concurrent orders oversell stock" }, verifier());
		expect(B.templates).toEqual([T]);
		expect(classOf(B.missionId)?.triage_class).toBe("S");
		expect(getTemplate(p.store, T)?.status).toBe("candidate");

		await runIntent("优惠券并发领取会不会超领", { script: burst("quota"), resourceKind: "quota", statement: "concurrent claims over-claim the coupon quota" }, verifier());
		expect(getTemplate(p.store, T)?.status).toBe("candidate");
		await runIntent("再测一次优惠券超领", { script: burst("quota"), resourceKind: "quota", statement: "concurrent claims over-claim the coupon quota" }, verifier());
		// Acceptance 1: 2 resource kinds × 2 runs → stable.
		expect(getTemplate(p.store, T)?.status).toBe("stable");
		const syncCornerstones = listCornerstones(p.store, T).filter((c) => c.exceptionId === null);
		expect(syncCornerstones.length).toBeGreaterThanOrEqual(4);

		// --- Act 3: the system becomes eventually consistent (no bugs)
		canary.setMode({ consistency: "eventual", bugs: new Set() });
		const fp = { script: burst("inventory"), resourceKind: "inventory" as const, deviation: true, statement: "stock oversold right after the burst" };
		const settle = burst("inventory", { settle: true });
		scripts.attributor.push(
			() => fauxAssistantMessage(fauxText('{"facet":"consistency.model","failure_value":"eventual","cornerstone_value":"sync","rationale":"values kept changing after the burst"}')),
			() => fauxAssistantMessage(fauxText('{"facet":"consistency.model","failure_value":"eventual","cornerstone_value":"sync"}')),
		);
		const E1 = await runIntent("超卖回归", fp, verifier({ settle }));
		expect(E1.hit).toBe("H3");
		const f1 = classOf(E1.missionId);
		expect(f1?.triage_class).toBe("U");
		expect(JSON.parse(f1?.attribution_json ?? "{}").hypothesis?.facet).toBe("consistency.model");
		expect(listFacets(p.store, "active").some((f) => f.name === "consistency.model")).toBe(false);

		// Probe: the next dispatch asks to observe consistency.model; the report activates the facet.
		const E2 = await runIntent("超卖回归 2", { ...fp, consistency: "eventual" }, verifier({ settle }));
		expect(listMissions(p.store).find((m) => m.id === E2.missionId)?.spec.probes).toEqual(["consistency.model"]);
		expect(listFacets(p.store, "active").some((f) => f.name === "consistency.model")).toBe(true);
		expect(classOf(E2.missionId)?.triage_class).toBe("B");

		const E3 = await runIntent("超卖回归 3", { ...fp, consistency: "eventual" }, verifier({ settle }));
		expect(classOf(E3.missionId)?.triage_class).toBe("B");
		expect(listDeltas(p.store, { target: T, status: "suspended" }).find((d) => d.op === "except")?.evidence).toHaveLength(2);

		// Third B observation reaches the stable-template threshold: a curator turns it into a delta.
		scripts.curator.push(
			call("template_propose", {
				name: "oracle.settle-then-check",
				type: "oracle",
				card: { title: "Settle-then-check oracle", summary: "Wait until asynchronous writes have applied, then check the invariant." },
				intent_patterns: ["最终一致", "eventual", "settle", "异步"],
				oracle: { text: "after a settle period, initial − accepted == final ≥ 0", strength: "high" },
				procedure: [{ do: "wait until the value stops changing", expect: "value stable" }, { do: "check the invariant", expect: "holds" }],
				verdict: { fail_when: "violated after settling", pass_when: "holds after settling", inconclusive_when: "never settles" },
				body: "Reading right after asynchronous writes sees intermediate state.",
			}),
			(ctx) => {
				const deltaId = ctx.messages.map((m) => JSON.stringify(m)).join("").match(/delta_id: (d-\d{8}-[0-9a-f]{6})/)?.[1] ?? "";
				return fauxAssistantMessage(
					fauxToolCall("delta_propose", {
						delta_id: deltaId,
						action: "patch",
						patch: { slot: "oracle", use: "tpl://project/oracle.settle-then-check", note: "wait for asynchronous writes to apply" },
						because: "in 3 eventual-consistency runs the immediate read was a false positive; after settling the invariant held",
					}),
				);
			},
			call("mission_submit", { status: "completed", summary: "delta proposed", claims: [{ id: "t1", type: "observation", statement: "except committed" }] }),
		);
		const E4 = await runIntent("超卖回归 4", { ...fp, consistency: "eventual" }, verifier({ settle }));
		expect(classOf(E4.missionId)?.triage_class).toBe("B");
		await waitFor(() => listDeltas(p.store, { target: T }).some((d) => d.op === "except" && d.status === "committed"), 30_000).catch((err) => {
			if (process.env.TESTMODE_DEBUG) {
				writeFileSync(debugFile("m3-debug.txt"), [
					...listAudit(p.store).slice(-40).map((a) => `${a.actor} ${a.event} ${a.tool ?? ""} ${a.decision ?? ""} ${a.reason ?? ""}`),
					"--- deltas",
					...listDeltas(p.store).map((d) => `${d.id} ${d.op} ${d.status} ev=${d.evidence.length} ${JSON.stringify(d.report?.checks.filter((c) => !c.ok) ?? [])}`),
					"--- curator tool results",
					...router.seen.filter((x) => x.info.actor === "curator").map((x) => x.raw.match(/"toolName":"delta_propose"[^}]*?"text":"([^"]*)/)?.[1] ?? "-"),
				].join("\n"));
			}
			throw err;
		});

		// Acceptance 2: an exception, not a rewrite; cornerstone verdicts unchanged; in-domain β unchanged.
		const delta = listDeltas(p.store, { target: T }).find((d) => d.op === "except" && d.status === "committed");
		expect(delta?.report?.replay.length).toBeGreaterThanOrEqual(syncCornerstones.length);
		expect(delta?.report?.replay.every((r) => r.ok)).toBe(true);
		const v2 = getTemplate(p.store, T);
		expect(v2?.status).toBe("stable");
		expect(v2?.spec.applicability.exceptions.map((e) => [e.when[0].facet, e.when[0].value, e.action])).toEqual([["consistency.model", "eventual", "patch"]]);
		expect(v2?.spec.applicability.hard).toEqual(getTemplate(p.store, T, 1)?.spec.applicability.hard);
		expect(getStats(p.store, T).filter((r) => !r.clusterKey.startsWith("exception:")).every((r) => r.beta === 1)).toBe(true);

		// --- Act 5: the exception bears fruit (B4: double compensation, visible only after settling)
		canary.setMode({ consistency: "eventual", bugs: new Set(["B4"]) });
		const E5 = await runIntent("并发下单再取消后会不会超卖或库存错乱", { script: cancelCheck(), resourceKind: "inventory", consistency: "eventual", statement: "cancelled orders are compensated twice; stock drifts after settling" }, verifier());
		expect(E5.hit).toBe("H2");
		expect(E5.templates).toEqual([T, "tpl://project/oracle.settle-then-check"]);
		expect(listMissions(p.store).find((m) => m.id === E5.missionId)?.spec.templates?.[0].exceptionId).toBe(v2?.spec.applicability.exceptions[0].id);
		expect(classOf(E5.missionId)?.triage_class).toBe("S");
		expect(exceptionSupport(p.store, T, v2?.spec.applicability.exceptions[0].id as string).support).toBeGreaterThan(0);
		expect(getStats(p.store, T).filter((r) => !r.clusterKey.startsWith("exception:")).every((r) => r.beta === 1)).toBe(true);

		// Acceptance 4: a delta that would change cornerstone verdicts is rejected with its replay report.
		const bad = proposeDelta(p.store, {
			op: "except",
			target: T,
			payload: { exception: { id: "ex-no-rest", when: [{ facet: "sut.kind", op: "eq", value: "rest-api" }], action: "exclude", because: "manual test", source: "experience" } },
			evidence: syncCornerstones.map((c) => c.episodeId),
			proposedBy: "test",
		});
		expect(bad.report.decision).toBe("rejected");
		expect(bad.report.replay.filter((r) => !r.ok).length).toBeGreaterThanOrEqual(syncCornerstones.length);
		expect(getTemplate(p.store, T)?.version).toBe(v2?.version);
		expect(listAudit(p.store, { event: "facet_activated" })).toHaveLength(1);
		if (process.env.TESTMODE_DEBUG) {
			writeFileSync(
				debugFile("m3-story.txt"),
				[
					JSON.stringify(v2?.spec.applicability.exceptions, null, 1),
					`committed delta replay: ${JSON.stringify(delta?.report?.replay)}`,
					`rejected delta replay: ${JSON.stringify(bad.report.replay)}`,
					`stats: ${JSON.stringify(getStats(p.store, T))}`,
					...listAudit(p.store)
						.filter((a) => ["learned", "hypothesis", "attribution", "facet_activated", "delta", "template_status", "template_propose"].includes(a.event))
						.map((a) => `${a.event} ${a.decision ?? ""} ${a.reason ?? ""}`),
				].join("\n"),
			);
		}
	}, 240_000);

	it("voids feedback from an executor that edits a frozen assertion (credibility 0)", async () => {
		const passing = "process.exit(0);\n";
		scripts.executor.push(
			(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "check.mjs"), content: burst("inventory") })),
			call("artifact_freeze", { paths: ["check.mjs"] }),
			(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "check.mjs"), content: passing })),
			call("test_run", { command: "node check.mjs" }),
			(ctx) => {
				const runId = idFrom(ctx.toolResults().find((r) => r.toolName === "test_run")?.text ?? "", "tr");
				return fauxAssistantMessage(fauxToolCall("mission_submit", { status: "completed", summary: "s", claims: [{ id: "c1", type: "defect", statement: "oversell", test_run_ids: [runId] }], used_templates: [{ id: ORACLE, role: "applied" }] }));
			},
		);
		scripts.verifier.push(...verifier());
		insertIntent(p.store, "i-cheat", "r", intentIR("测一下超卖"));
		const [out] = await o.dispatch("i-cheat", [{ role: "executor", objective: "o", targets: [canary.url], testKinds: ["functional", "load"], templateIds: [ORACLE] }], router.model());
		const id = out.ok ? out.missionId : "";
		await waitFor(() => listMissions(p.store, { intentId: "i-cheat" }).length >= 2 && listMissions(p.store, { intentId: "i-cheat" }).every((m) => m.status === "completed"), 60_000);
		await o.finalizeIntent("i-cheat", { conclusion: "x" }).learning;
		const f = classOf(id);
		expect(f?.credibility).toBe(0);
		expect(JSON.parse(f?.attribution_json ?? "{}").cheating[0]).toMatch(/frozen artifact/);
		expect(getStats(p.store, "meta:executor")[0]).toMatchObject({ beta: 2 });
		expect(getStats(p.store, ORACLE)).toEqual([]);
		expect(listAudit(p.store, { event: "cheating_detected" })).toHaveLength(1);
	}, 120_000);
});

function getMission(id: string) {
	return listMissions(p.store).find((m) => m.id === id);
}

