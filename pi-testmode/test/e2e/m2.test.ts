/**
 * M2 acceptance (plan §9): first oversell intent → H0, a verified capability and a draft template;
 * second intent on another resource → H2 reusing both at ≤50% of the first run's cost; main never
 * sees capability bodies or user skills; a tampered skill is blocked and audited.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edges, getProvider, listGaps, listProviders, listRetrievals, listTemplates, listTemplateUses } from "../../src/knowledge/store.ts";
import { createTestmodeExtension } from "../../src/mode.ts";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { intentCost } from "../../src/orchestrator/report.ts";
import { getIntent, insertIntent, listAudit, listMissions } from "../../src/store/repos.ts";
import { debugFile, startCanary, type TempProject, tempProject, waitFor } from "../helpers.ts";
import { createRouter, idFrom, type Step } from "./faux.ts";

const SECRET = "SECRET-USER-SKILL-7f3a";
const SKILL_MD = "---\nname: stock-read\ndescription: Read a product's current stock as JSON. Use to snapshot state before and after a burst.\n---\nRun `node read.mjs <base-url> <product-id>`; prints {\"value\":n,\"read_at\":iso}.\n";
const READ_MJS = `const [base, id] = process.argv.slice(2);
const r = await fetch(base + "/products/" + id);
const p = await r.json();
console.log(JSON.stringify({ value: p.stock, read_at: new Date().toISOString() }));
`;
const oversell = (url: string, product: string, reader: string) => `import { execFileSync } from "node:child_process";
const base = ${JSON.stringify(url)};
const read = () => JSON.parse(execFileSync(process.execPath, [${JSON.stringify(reader)}, base, ${JSON.stringify(product)}]).toString()).value;
await fetch(base + "/reset", { method: "POST" });
const before = read();
const rs = await Promise.all(Array.from({ length: 30 }, () => fetch(base + "/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: ${JSON.stringify(product)}, qty: 1 }) })));
const accepted = rs.filter((r) => r.status === 201).length;
const after = read();
console.log(JSON.stringify({ before, accepted, after }));
process.exit(accepted <= before && after === before - accepted ? 0 : 1);
`;

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]): Step => () => fauxAssistantMessage(fauxToolCall(name, args));

let p: TempProject;
let canary: Awaited<ReturnType<typeof startCanary>>;
let session: AgentSession | undefined;

beforeEach(async () => {
	p = tempProject();
	canary = await startCanary({ bugs: new Set(["B1"]) });
	mkdirSync(p.paths.dir, { recursive: true });
	writeFileSync(p.paths.scopeFile, JSON.stringify({ targets: [{ host: `localhost:${canary.port}`, envs: ["local"], allowed: ["functional", "load"] }] }));
	const userSkill = join(p.agentDir, "skills", "secret-skill");
	mkdirSync(userSkill, { recursive: true });
	writeFileSync(join(userSkill, "SKILL.md"), `---\nname: secret-skill\ndescription: ${SECRET} user skill that must never reach test mode.\n---\nbody\n`);
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

const CAP = "cap:state.snapshot.read";
const reader = () => join(listProviders(p.store, { capId: CAP })[0].location.path as string, "read.mjs");
const intentIR = (raw: string) => ({
	raw,
	goal: { kind: "find_defects", quality_attributes: ["correctness.consistency"], hypotheses: ["concurrent orders oversell stock"] },
	sut_refs: [{ kind: "api", locator: `${canary.url}/openapi.json`, env: "local" }],
	constraints: { environment: "local", data: "synthetic-only" },
	acceptance: ["evidence-backed verdict on oversell"],
	assumptions: ["30 concurrent single-item orders"],
	open_questions: [],
});

function executorScript(product: string, opts: { explore: boolean; template: () => string }): Step[] {
	return [
		...(opts.explore ? [call("bash", { command: `curl -s ${canary.url}/openapi.json` })] : []),
		() => fauxAssistantMessage(fauxToolCall("read", { path: join(reader(), "..", "SKILL.md") })),
		(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "oversell.mjs"), content: oversell(canary.url, product, reader()) })),
		call("artifact_freeze", { paths: ["oversell.mjs"] }),
		call("test_run", { command: "node oversell.mjs" }),
		(ctx) => {
			const runId = idFrom(ctx.toolResults().find((r) => r.toolName === "test_run")?.text ?? "", "tr");
			return fauxAssistantMessage(
				fauxToolCall("mission_submit", {
					status: "completed",
					summary: `oversell of ${product} reproduced`,
					claims: [{ id: "c1", type: "defect", statement: `Concurrent orders oversell ${product}`, test_run_ids: [runId], oracle: { kind: "conservation-invariant", strength: "high" }, minimal_repro: "node oversell.mjs" }],
					used_templates: [{ id: opts.template(), role: "applied" }],
				}),
			);
		},
	];
}

const verifierScript: Step[] = [0, 1].flatMap(() => [
	call("test_run", { command: "node oversell.mjs" }),
	call("test_run", { command: "node oversell.mjs" }),
	(ctx) => {
		const ids = ctx.toolResults().filter((r) => r.toolName === "test_run").map((r) => idFrom(r.text, "tr"));
		return fauxAssistantMessage(fauxToolCall("mission_submit", { status: "completed", summary: "replayed", claims: [{ id: "v1", type: "observation", statement: "replayed" }], verification: [{ claim_id: "c1", test_run_ids: ids }] }));
	},
]);

describe("M2: templates, capabilities, progressive disclosure", () => {
	it("H0 → draft template + verified capability → H2 reuse at ≤50% cost; tampering is blocked", async () => {
		let i1 = "";
		let i2 = "";
		let projectTpl = "";
		const scripts: Record<string, Step[]> = {
			main: [
				call("intent_record", intentIR("测一下 canary 的下单接口在并发下会不会超卖")),
				(ctx) => ((i1 = idFrom(ctx.lastToolResult(), "i")), fauxAssistantMessage(fauxToolCall("knowledge_search", { intent_id: i1 }))),
				(ctx) => {
					expect(ctx.lastToolResult()).toMatch(/hit level: H0/);
					return fauxAssistantMessage(fauxToolCall("mission_dispatch", { intent_id: i1, missions: [{ role: "scout", objective: "Learn the order API and its state model", targets: [canary.url], test_kinds: ["functional"] }] }));
				},
				(ctx) => {
					expect(ctx.lastUserText()).toMatch(/capability cap:state\.snapshot\.read: resolved/);
					return fauxAssistantMessage(
						fauxToolCall("mission_dispatch", {
							intent_id: i1,
							missions: [{ role: "executor", objective: "Oversell under 30 concurrent orders of p1", targets: [canary.url], test_kinds: ["functional", "load"], template_ids: ["tpl://global/oracle.conservation-invariant"], capabilities: [CAP] }],
						}),
					);
				},
				(ctx) => (expect(ctx.lastUserText()).toContain("confirmed"), fauxAssistantMessage(fauxToolCall("report_finalize", { intent_id: i1, conclusion: "p1 oversells (B1)." }))),
				() => fauxAssistantMessage(fauxText("run 1 done")),
				call("intent_record", intentIR("看看 canary 的 p5 商品在并发下单时会不会超卖")),
				(ctx) => ((i2 = idFrom(ctx.lastToolResult(), "i")), fauxAssistantMessage(fauxToolCall("knowledge_search", { intent_id: i2 }))),
				(ctx) => {
					expect(ctx.lastToolResult()).toMatch(/hit level: H2/);
					projectTpl = ctx.lastToolResult().match(/1\. (tpl:\/\/project\/[^@\s]+)@/)?.[1] ?? "";
					return fauxAssistantMessage(
						fauxToolCall("mission_dispatch", { intent_id: i2, missions: [{ role: "executor", objective: "Oversell under 30 concurrent orders of p5", targets: [canary.url], test_kinds: ["functional", "load"], template_ids: [projectTpl] }] }),
					);
				},
				() => fauxAssistantMessage(fauxToolCall("report_finalize", { intent_id: i2, conclusion: "p5 oversells too." })),
				() => fauxAssistantMessage(fauxText("run 2 done")),
			],
			scout: [
				call("capability_request", { cap: CAP, semantics: "read a product's current stock, repeatedly during a burst", io: { input: "base url, product id", output: "{value, read_at}" }, acceptance_hints: ["after reset with stock p2=7, reading p2 returns 7"] }),
				call("mission_submit", {
					status: "completed",
					summary: "REST/JSON order service with shared stock; POST /reset available",
					claims: [{ id: "o1", type: "observation", statement: "stock is a shared mutable resource" }],
					fingerprint: [
						{ facet: "sut.kind", value: "rest-api", conf: 1, src: "openapi" },
						{ facet: "interface.protocol", value: "http/json", conf: 1, src: "headers" },
						{ facet: "state.shared_resource", value: "true", conf: 0.9, src: "openapi /orders" },
						{ facet: "sut.stack", value: "node", conf: 0.8, src: "behaviour" },
						{ facet: "interface.pagination", value: "true", conf: 0.9, src: "openapi /products" },
						{ facet: "consistency.model", value: "sync", conf: 0.6, src: "immediate reads" },
					],
					capability_issues: [CAP],
				}),
			],
			toolsmith: [
				(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "quarantine", "stock-read", "SKILL.md"), content: SKILL_MD })),
				(ctx) => fauxAssistantMessage(fauxToolCall("write", { path: join(ctx.info.runDir as string, "quarantine", "stock-read", "read.mjs"), content: READ_MJS })),
				call("skill_validate", { path: "quarantine/stock-read" }),
				call("provider_register", { path: "quarantine/stock-read", cap: CAP, semantics: "read a product's current stock" }),
				call("mission_submit", { status: "completed", summary: "stock-read skill registered", claims: [{ id: "o1", type: "observation", statement: "registered stock-read" }] }),
			],
			"verifier:conformance": [
				(ctx) =>
					fauxAssistantMessage(
						fauxToolCall("write", {
							path: join(ctx.info.runDir as string, "conf.mjs"),
							content: `import { execFileSync } from "node:child_process";
await fetch(${JSON.stringify(canary.url)} + "/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stock: { p2: 7 } }) });
const out = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(reader())}, ${JSON.stringify(canary.url)}, "p2"]).toString());
process.exit(out.value === 7 ? 0 : 1);
`,
						}),
					),
				call("test_run", { command: "node conf.mjs" }),
				(ctx) => {
					const id = idFrom(ctx.lastToolResult(), "tr");
					return fauxAssistantMessage(fauxToolCall("mission_submit", { status: "completed", summary: "reads known values", claims: [{ id: "k1", type: "pass", statement: "returns the reset stock", test_run_ids: [id] }] }));
				},
			],
			executor: [...executorScript("p1", { explore: true, template: () => "tpl://global/oracle.conservation-invariant" }), ...executorScript("p5", { explore: false, template: () => projectTpl })],
			verifier: verifierScript,
			curator: [
				call("template_propose", {
					name: "concurrency.oversell-invariant",
					type: "strategy",
					card: { title: "Oversell under concurrent writes", summary: "Burst same-key writes and check the conservation invariant with state snapshots." },
					intent_patterns: ["超卖", "并发下单", "库存为负", "oversell"],
					hypothesis: "concurrent writes to one resource lack mutual exclusion",
					stimulus: "N concurrent orders on one product (N ≈ 3 × stock)",
					oracle: { text: "initial − accepted == final ≥ 0", strength: "high" },
					procedure: [
						{ do: "reset and snapshot the stock", expect: "readable and stable" },
						{ do: "burst N orders", expect: "some 201, some 409" },
						{ do: "snapshot the stock again", expect: "readable" },
					],
					verdict: { fail_when: "invariant violated", pass_when: "invariant holds in all runs", inconclusive_when: "stock unreadable" },
					composes: [{ slot: "oracle", ref: "tpl://global/oracle.conservation-invariant" }],
					body: "Snapshot with the bound state reader before and after; expected values come from the invariant.",
				}),
				call("mission_submit", { status: "completed", summary: "drafted", claims: [{ id: "t1", type: "observation", statement: "drafted template" }] }),
			],
		};
		const router = createRouter(p.agentDir, scripts);
		let orch: Orchestrator | undefined;
		const loader = new DefaultResourceLoader({
			cwd: p.root,
			agentDir: p.agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				createTestmodeExtension({
					agentDir: p.agentDir,
					modelRuntime: router.runtime,
					orchestrator: { noSandbox: true, notifyDebounceMs: 50, heartbeatMs: 200, missionSettings: { retry: { enabled: false } } },
					onOrchestrator: (o) => (orch = o),
				}),
			],
		});
		await loader.reload();
		const { session: s } = await createAgentSession({
			cwd: p.root,
			agentDir: p.agentDir,
			model: router.model(),
			modelRuntime: await router.runtime(),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(p.root),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		});
		session = s;
		await s.bindExtensions({});
		expect(s.systemPrompt).toContain(SECRET); // the user skill is visible outside test mode

		await s.prompt("/test");
		await s.prompt("测一下 canary 的下单接口在并发下会不会超卖");
		await waitFor(() => getIntent(p.store, i1)?.status === "closed" && router.remaining("main") === 5 && !s.isStreaming, 60_000);
		await waitFor(() => listMissions(p.store, { intentId: i1 }).find((m) => m.role === "curator")?.status === "completed", 30_000);

		// Acceptance 1: H0, one draft template, a verified capability.
		expect(listRetrievals(p.store, i1)[0].hitLevel).toBe("H0");
		const drafts = listTemplates(p.store).filter((t) => t.layer === "project");
		expect(drafts.map((t) => [t.status, t.type])).toEqual([["draft", "strategy"]]);
		expect(drafts[0].spec.capabilities_required).toEqual([{ cap: CAP }]);
		expect(drafts[0].spec.applicability.hard.map((h) => h.facet)).toContain("state.shared_resource");
		expect(edges(p.store, { src: drafts[0].id, kind: "derived_from" })[0].dst).toBe(`intent:${i1}`);
		const provider = listProviders(p.store, { capId: CAP })[0];
		expect(provider).toMatchObject({ trust: "verified", conformanceScore: 1 });
		expect(listGaps(p.store, { capId: CAP })[0].status).toBe("resolved");

		await s.prompt("看看 canary 的 p5 商品在并发下单时会不会超卖");
		await waitFor(() => getIntent(p.store, i2)?.status === "closed" && router.remaining("main") === 0 && !s.isStreaming, 60_000);

		// Acceptance 2: H2 reuse of the template and capability, at ≤50% of the first run's cost.
		expect(listRetrievals(p.store, i2)[0].hitLevel).toBe("H2");
		const ex2 = listMissions(p.store, { intentId: i2 }).find((m) => m.role === "executor");
		expect(ex2?.spec.templates?.[0].id).toBe(drafts[0].id);
		expect(ex2?.spec.bindings?.map((b) => b.sha256)).toEqual([provider.sha256]);
		expect(listMissions(p.store, { intentId: i2 }).some((m) => m.role === "curator")).toBe(false);
		const c1 = intentCost(p.store, i1).tokens;
		const c2 = intentCost(p.store, i2).tokens;
		expect(c2 / c1).toBeLessThanOrEqual(0.5);
		const report2 = readFileSync(getIntent(p.store, i2)?.reportPath as string, "utf8");
		expect(report2).toContain("Hit level: H2");
		expect(report2).toMatch(new RegExp(`cost vs\\. ${i1}`));
		expect(listTemplateUses(p.store).some((u) => u.role === "applied" && u.templateId === drafts[0].id)).toBe(true);
		expect(listTemplateUses(p.store).some((u) => u.role === "retrieved_unused")).toBe(true);

		// Acceptance 3: main sees cards only; missions see only what they bind.
		const sys = (actor: string) => router.seen.filter((x) => x.info.actor === actor).map((x) => x.system);
		for (const text of sys("main")) {
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain("stock-read");
			expect(text).not.toContain("process.argv.slice(2)");
		}
		for (const actor of ["scout", "toolsmith", "executor", "verifier", "curator"]) for (const text of sys(actor)) expect(text).not.toContain(SECRET);
		expect(sys("executor").every((t) => t.includes("stock-read"))).toBe(true);
		expect(sys("scout").some((t) => t.includes("stock-read"))).toBe(false);

		// Acceptance 4: a changed skill is blocked at next use and audited.
		appendFileSync(join(provider.location.path as string, "read.mjs"), "\n// tampered\n");
		insertIntent(p.store, "i-tamper", "r", intentIR("r"));
		const [outcome] = await (orch as Orchestrator).dispatch("i-tamper", [{ role: "executor", objective: "o", targets: [canary.url], testKinds: ["functional"], capabilities: [CAP] }], router.model());
		expect(outcome).toMatchObject({ ok: false });
		expect(!outcome.ok && outcome.reason).toMatch(/content hash changed/);
		expect(getProvider(p.store, provider.sha256)?.trust).toBe("quarantined");
		expect(listAudit(p.store, { event: "provider_hash_mismatch" })).toHaveLength(1);

		if (process.env.TESTMODE_DEBUG) writeFileSync(debugFile("m2-report.md"), `${report2}\n\nratio ${c2}/${c1}`);
	});
});
