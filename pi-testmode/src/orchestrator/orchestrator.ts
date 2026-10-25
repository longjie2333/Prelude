/**
 * Orchestrator (plan M1-9, M1-10, M1-14): dispatch without waiting, wake the main session when
 * missions finish (outbox: `notified_at`), auto-verify executor claims, and reconcile missions
 * left behind by a crash.
 *
 * It holds only plain data and the *current* main-session handle; missions never see `pi`/`ctx`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { bindingOf, quarantineProvider, resolveCapabilities, verifyBinding } from "../capabilities/registry.ts";
import { putEvidence } from "../harness/evidence.ts";
import type { CapabilityRequest } from "../harness/tools.ts";
import { judge } from "../knowledge/applicability.ts";
import { activeOnly, assembleFingerprint, mergeFingerprints } from "../knowledge/fingerprint.ts";
import type { ReportInput } from "./report.ts";
import { getProvider, getTemplate, insertGap, listEpisodes, listGaps, listProviders, listRetrievals, seedKnowledge, setProviderTrust, updateGap } from "../knowledge/store.ts";
import { runtimeComplete } from "../learning/attributor.ts";
import { isLearningPaused } from "../learning/calibration.ts";
import { recordEpisode, recordRetrievedUnused } from "../learning/episodes.ts";
import { listDeltas } from "../learning/gate.ts";
import { Learner, probesFor } from "../learning/pipeline.ts";
import { buildReport, type ReportResult } from "./report.ts";
import { type ApprovalOutcome, type ApprovalRequest, type ApprovalUI, Approvals } from "../kernel/approvals.ts";
import { canonicalPath } from "../kernel/paths.ts";
import { assessMissionRisk } from "../kernel/risk.ts";
import { loadScope, type TestKind } from "../kernel/scope.ts";
import type { Envelope } from "../missions/envelope.ts";
import { type MissionRunner, type ResumeResult, SdkMissionRunner } from "../missions/runner.ts";
import type { TestmodePaths } from "../paths.ts";
import type { Store } from "../store/db.ts";
import {
	audit,
	closeIntent,
	freezeArtifact,
	getIntent,
	getMission,
	insertMission,
	listFrozen,
	listMissions,
	listTestRuns,
	type MissionRow,
	type MissionSpecRecord,
	updateMission,
} from "../store/repos.ts";
import type { Budget, RiskTier, Role } from "../types.ts";
import { maxTier, RISK_ORDER, TERMINAL_STATUSES } from "../types.ts";
import { newId, nowIso, sha256 } from "../util.ts";
import type { IntentIR } from "./intent.ts";
import { claimViews, needsVerification, verifierOf } from "./verification.ts";

export const DEFAULT_BUDGETS: Record<Role, Budget> = {
	scout: { tokens: 150_000, wallClockMs: 10 * 60_000 },
	executor: { tokens: 400_000, wallClockMs: 30 * 60_000 },
	verifier: { tokens: 200_000, wallClockMs: 15 * 60_000 },
	toolsmith: { tokens: 300_000, wallClockMs: 20 * 60_000 },
	curator: { tokens: 100_000, wallClockMs: 5 * 60_000 },
};

export const MISSION_DONE = "testmode-mission-done";

export interface MainHandle {
	/** Delivers a wake-up message; returns false when the session is gone. */
	notify(content: string, details: unknown): boolean;
	ui?: ApprovalUI & { confirm?(title: string, message: string): Promise<boolean> };
}

export interface OrchestratorOptions {
	paths: TestmodePaths;
	agentDir: string;
	store: Store;
	modelRuntime: () => Promise<ModelRuntime>;
	runnerFactory?: (o: ConstructorParameters<typeof SdkMissionRunner>[0]) => MissionRunner;
	concurrency?: number;
	heartbeatMs?: number;
	/** A running mission whose heartbeat is older than this is considered dead (M1-14 §3). */
	staleAfterMs?: number;
	notifyDebounceMs?: number;
	missionSettings?: Record<string, unknown>;
	noSandbox?: boolean;
}

export interface DispatchRequest {
	role: "scout" | "executor";
	objective: string;
	targets: string[];
	testKinds: TestKind[];
	context?: string;
	budget?: { tokens?: number; wall_clock_s?: number };
	/** Templates to activate (D2), from knowledge_search cards. */
	templateIds?: string[];
	/** Extra capabilities to bind beyond the templates' own requirements. */
	capabilities?: string[];
}

export type DispatchOutcome =
	| { ok: true; missionId: string; role: Role; tier: string; reasons: string[] }
	| { ok: false; objective: string; reason: string };

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class Orchestrator {
	readonly runner: MissionRunner;
	readonly approvals: Approvals;
	readonly learner: Learner;
	private main: MainHandle | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private lastModel: { provider: string; id: string } | undefined;
	private closed = false;

	private readonly opts: OrchestratorOptions;

	constructor(opts: OrchestratorOptions) {
		this.opts = opts;
		this.approvals = new Approvals(opts.store, () => this.main?.ui);
		const runnerOpts = {
			paths: opts.paths,
			agentDir: opts.agentDir,
			store: opts.store,
			modelRuntime: opts.modelRuntime,
			defaultModel: () => undefined,
			concurrency: opts.concurrency,
			heartbeatMs: opts.heartbeatMs,
			settings: opts.missionSettings,
			noSandbox: opts.noSandbox,
			hooks: {
				approve: (req: ApprovalRequest): Promise<ApprovalOutcome> => this.approvals.request(req),
				onMissionEnd: (id: string) => this.onMissionEnd(id),
				requestCapability: (id: string, req: CapabilityRequest) => this.requestCapability(id, req),
			},
		};
		this.runner = opts.runnerFactory ? opts.runnerFactory(runnerOpts) : new SdkMissionRunner(runnerOpts);
		seedKnowledge(opts.store);
		this.learner = new Learner({
			store: opts.store,
			complete: async () => {
				const model = this.lastModel;
				if (!model) return undefined;
				const runtime = await opts.modelRuntime();
				const m = runtime.getModel(model.provider, model.id);
				return m ? runtimeComplete(runtime, m) : undefined;
			},
			dispatchDeltaCurator: (id) => this.dispatchDeltaCurator(id),
			paused: () => isLearningPaused(opts.store),
		});
	}

	get store(): Store {
		return this.opts.store;
	}

	attachMain(handle: MainHandle): void {
		this.main = handle;
		this.scheduleFlush(0);
	}

	detachMain(): void {
		this.main = undefined;
	}

	/** Session shutdown: abort every running mission (recorded as aborted/shutdown). Idempotent. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.detachMain();
		if (this.flushTimer) clearTimeout(this.flushTimer);
		await this.runner.abortAll("shutdown");
	}

	approve(req: ApprovalRequest): Promise<ApprovalOutcome> {
		return this.approvals.request(req);
	}

	runningCount(): number {
		return this.runner.activeCount();
	}

	// ------------------------------------------------------------ dispatch

	async dispatch(intentId: string, requests: DispatchRequest[], model: Model<any> | undefined): Promise<DispatchOutcome[]> {
		const { store, paths } = this.opts;
		const intent = getIntent(store, intentId);
		if (!intent) throw new Error(`unknown intent ${intentId}; call intent_record first`);
		if (intent.status !== "open") throw new Error(`intent ${intentId} is closed`);
		if (model) this.lastModel = { provider: model.provider, id: model.id };
		const ir = intent.ir as IntentIR;
		const scope = loadScope(paths.scopeFile);
		const outcomes: DispatchOutcome[] = [];

		const { fingerprint } = assembleFingerprint(store, ir);
		for (const req of requests) {
			// Template activation (M2-5): the judge decides; the tier floor and capabilities follow the templates.
			const templates: NonNullable<MissionSpecRecord["templates"]> = [];
			let floor: RiskTier = "R0";
			const caps = new Set(req.capabilities ?? []);
			let refused: string | undefined;
			for (const tid of req.templateIds ?? []) {
				const t = getTemplate(store, tid.replace(/@\d+$/, ""));
				if (!t) {
					refused = `unknown template ${tid}`;
					break;
				}
				const j = judge(t.spec.applicability, fingerprint);
				if (j.result === "false") {
					refused = `${t.id} does not apply here: ${j.reasons.join("; ")}`;
					break;
				}
				templates.push({ id: t.id, version: t.version, exceptionId: j.exception?.id });
				floor = maxTier(floor, t.spec.risk_tier_floor);
				for (const c of t.spec.capabilities_required) caps.add(c.cap);
				// A fired `patch` exception brings its replacement slot template along (agent-core §7.4).
				const use = j.exception?.action === "patch" ? j.exception.patch?.use : undefined;
				const patchTpl = use?.startsWith("tpl://") ? getTemplate(store, use) : undefined;
				if (patchTpl && !templates.some((x) => x.id === patchTpl.id)) templates.push({ id: patchTpl.id, version: patchTpl.version });
			}
			if (refused) {
				audit(store, { actor: "main", event: "mission_dispatch", decision: "block", reason: refused });
				outcomes.push({ ok: false, objective: req.objective, reason: refused });
				continue;
			}
			const resolution = resolveCapabilities(store, [...caps], "main");
			if (resolution.mismatched.length > 0) {
				const reason = `provider content changed since registration (blocked and quarantined): ${resolution.mismatched.map((x) => `${x.capId} ${x.sha256.slice(0, 8)} — ${x.reason}`).join("; ")}`;
				outcomes.push({ ok: false, objective: req.objective, reason });
				continue;
			}
			const risk = assessMissionRisk({
				role: req.role,
				targets: req.targets,
				testKinds: req.testKinds,
				environment: ir.constraints?.environment,
				templateFloor: floor,
				scope: scope.scope,
			});
			if (!risk.allowed) {
				audit(store, { actor: "main", event: "mission_dispatch", decision: "block", reason: `${req.role}: ${risk.denyReason}` });
				outcomes.push({ ok: false, objective: req.objective, reason: `${risk.denyReason}${scope.error ? ` (${scope.error})` : ""}` });
				continue;
			}
			const missionId = newId("m");
			if (risk.requiresApproval) {
				const outcome = await this.approvals.request({
					actor: "main",
					missionId,
					tier: risk.tier,
					subject: `mission:${req.role}:${req.targets.join(",")}:${req.testKinds.join(",")}`,
					title: `Dispatch ${req.role} mission at ${risk.tier}`,
					detail: `${req.objective}\n\n${risk.reasons.join("; ")}`,
				});
				if (!outcome.approved) {
					outcomes.push({ ok: false, objective: req.objective, reason: `${risk.tier} mission not approved: ${outcome.reason}` });
					continue;
				}
			}
			const base = DEFAULT_BUDGETS[req.role];
			const spec: MissionSpecRecord = {
				missionId,
				intentId,
				role: req.role,
				objective: req.objective,
				targets: req.targets,
				testKinds: req.testKinds,
				context: req.context,
				riskTier: risk.tier,
				riskReasons: risk.reasons,
				budget: {
					tokens: req.budget?.tokens ?? base.tokens,
					wallClockMs: req.budget?.wall_clock_s ? req.budget.wall_clock_s * 1000 : base.wallClockMs,
				},
				model: this.lastModel,
				templates: templates.length ? templates : undefined,
				bindings: resolution.bindings.length ? resolution.bindings : undefined,
				unboundCaps: resolution.missing.length ? resolution.missing : undefined,
				probes: (() => {
					const pr = probesFor(store, templates.map((x) => x.id));
					return pr.length ? pr : undefined;
				})(),
			};
			this.insertAndStart(spec);
			outcomes.push({ ok: true, missionId, role: req.role, tier: risk.tier, reasons: risk.reasons });
		}
		return outcomes;
	}

	private insertAndStart(spec: MissionSpecRecord, parentId?: string): void {
		const { store, paths } = this.opts;
		const runDir = join(paths.runsDir, spec.missionId);
		store.tx(() => {
			insertMission(store, spec, runDir, parentId);
			audit(store, {
				actor: "main",
				event: "mission_dispatch",
				decision: "allow",
				reason: `${spec.missionId} ${spec.role} ${spec.riskTier}${parentId ? ` (verifies ${parentId})` : ""}`,
			});
		});
		this.runner.start(spec.missionId);
	}

	/**
	 * Plan M1-10: the verifier gets the claims, frozen artifacts, and commands, never the
	 * executor's conversation. Artifacts are copied into its own run directory and re-frozen.
	 */
	private dispatchVerifier(executor: MissionRow): void {
		const { store, paths } = this.opts;
		const env = executor.envelope as Envelope;
		const claims = env.claims.filter((c) => c.type === "defect" || c.type === "pass");
		const runs = listTestRuns(store, executor.id);
		const cited = new Set(claims.flatMap((c) => c.test_run_ids ?? []));
		const missionId = newId("m");
		const runDir = join(paths.runsDir, missionId);
		mkdirSync(runDir, { recursive: true });

		const execRun = canonicalPath(executor.runDir, paths.root);
		const artifacts: Array<{ path: string; sha256: string }> = [];
		for (const a of listFrozen(store, executor.id)) {
			const rel = relative(execRun, a.path).replaceAll("\\", "/");
			const dest = join(runDir, rel);
			mkdirSync(dirname(dest), { recursive: true });
			if (!existsSync(a.path)) continue;
			copyFileSync(a.path, dest);
			if (sha256(readFileSync(dest)) !== a.sha256) continue; // tampered: not handed to the verifier
			artifacts.push({ path: rel, sha256: a.sha256 });
		}
		const rewrite = (cmd: string) => {
			let out = cmd;
			for (const form of [executor.runDir, executor.runDir.replaceAll("\\", "/")]) out = out.split(form).join(runDir.replaceAll("\\", "/"));
			return out;
		};
		const spec: MissionSpecRecord = {
			missionId,
			intentId: executor.intentId,
			role: "verifier",
			objective: `Independently re-check ${claims.length} claim(s) from ${executor.id}`,
			targets: executor.spec.targets,
			testKinds: executor.spec.testKinds,
			context: `The executor's run directory ${executor.runDir} corresponds to your run directory ${runDir}; the frozen scripts are already there.`,
			// Same targets and operations as the executor it verifies, which was already authorized.
			riskTier: executor.riskTier,
			riskReasons: [`inherits ${executor.id}`],
			budget: DEFAULT_BUDGETS.verifier,
			model: executor.spec.model,
			verify: {
				executorMissionId: executor.id,
				claims: claims.map((c) => ({ id: c.id, type: c.type, statement: c.statement, testRunIds: c.test_run_ids ?? [], evidence: c.evidence ?? [] })),
				artifacts,
				testRuns: runs.filter((r) => cited.has(r.id)).map((r) => ({ id: r.id, command: rewrite(r.command), verdict: r.verdict })),
			},
		};
		store.tx(() => {
			insertMission(store, spec, runDir, executor.id);
			for (const a of artifacts) {
				const dest = join(runDir, a.path);
				putEvidence(store, paths.evidenceDir, readFileSync(dest), { missionId, kind: "artifact" });
				freezeArtifact(store, { missionId, path: canonicalPath(dest, paths.root), sha256: a.sha256 });
			}
			audit(store, { actor: "main", event: "mission_dispatch", decision: "allow", reason: `${missionId} verifier ${spec.riskTier} (verifies ${executor.id})` });
		});
		this.runner.start(missionId);
	}

	// ------------------------------------------------------------ completion and wake-up

	private onMissionEnd(missionId: string): void {
		if (this.closed) return;
		const { store } = this.opts;
		const m = getMission(store, missionId);
		if (!m) return;
		const step = (what: string, fn: () => void) => {
			try {
				fn();
			} catch (err) {
				audit(store, { actor: "main", event: `${what}_failed`, reason: `${m.id}: ${(err as Error).message}` });
			}
		};
		if (TERMINAL_STATUSES.includes(m.status) || m.status === "blocked") step("episode", () => recordEpisode(store, m));
		if (m.role === "executor" && m.status === "completed" && needsVerification(m) && !verifierOf(store, m.id)) step("verifier_dispatch", () => this.dispatchVerifier(m));
		if (m.role === "toolsmith" && TERMINAL_STATUSES.includes(m.status)) step("conformance_dispatch", () => this.afterToolsmith(m));
		if (m.role === "verifier" && m.spec.conformance && TERMINAL_STATUSES.includes(m.status)) step("promotion", () => this.afterConformance(m));
		if (m.role === "curator") updateMission(store, m.id, { notifiedAt: m.notifiedAt ?? nowIso() });
		this.scheduleFlush();
	}

	// ------------------------------------------------------------ capabilities (M2-6)

	/** A mission filed a capability gap: dispatch a Toolsmith in the background. */
	requestCapability(missionId: string, req: CapabilityRequest): { message: string; gapId?: string } {
		const { store, paths } = this.opts;
		const m = getMission(store, missionId);
		if (!m) return { message: "unknown mission" };
		const open = listGaps(store, { capId: req.capId }).find((g) => g.status === "open" || g.status === "acquiring");
		if (open) return { message: `${req.capId} is already being acquired (gap ${open.id}); continue without it.`, gapId: open.id };
		if (listProviders(store, { capId: req.capId, trust: ["verified", "pinned"] }).length > 0) {
			return { message: `${req.capId} already has a verified provider; ask for it to be bound in the next mission (mission_dispatch capabilities).` };
		}
		const gapId = newId("g");
		const toolsmithId = newId("m");
		const risk = assessMissionRisk({ role: "toolsmith", targets: m.spec.targets, testKinds: ["functional"], scope: loadScope(paths.scopeFile).scope });
		const spec: MissionSpecRecord = {
			missionId: toolsmithId,
			intentId: m.intentId,
			role: "toolsmith",
			objective: `Provide ${req.capId}: ${req.semantics}`,
			targets: m.spec.targets,
			testKinds: ["functional"],
			riskTier: risk.tier,
			riskReasons: risk.reasons,
			budget: DEFAULT_BUDGETS.toolsmith,
			model: m.spec.model,
			gap: { gapId, capId: req.capId, semantics: req.semantics, io: req.io, acceptanceHints: req.acceptanceHints },
		};
		store.tx(() => {
			insertGap(store, { id: gapId, requestedBy: m.id, capId: req.capId, spec: { semantics: req.semantics, io: req.io, acceptance_hints: req.acceptanceHints } });
			audit(store, { actor: `mission:${m.id}`, event: "capability_request", decision: risk.allowed && !risk.requiresApproval ? "allow" : "block", reason: `${gapId} ${req.capId}` });
			if (!risk.allowed || risk.requiresApproval) updateGap(store, gapId, { status: "failed" });
		});
		if (!risk.allowed || risk.requiresApproval) {
			return { message: `Recorded gap ${gapId}, but a Toolsmith cannot run here (${risk.denyReason ?? `${risk.tier} needs approval`}). Continue without it and list it in capability_issues.`, gapId };
		}
		this.insertAndStart(spec, m.id);
		updateGap(store, gapId, { status: "acquiring", toolsmithMissionId: toolsmithId });
		return { message: `Recorded gap ${gapId}; Toolsmith ${toolsmithId} is acquiring ${req.capId} in the background. Continue without it and list it in capability_issues.`, gapId };
	}

	private afterToolsmith(t: MissionRow): void {
		const { store } = this.opts;
		const gap = listGaps(store, { toolsmithMissionId: t.id })[0];
		if (!gap) return;
		const provider = gap.providerSha ? getProvider(store, gap.providerSha) : undefined;
		if (t.status !== "completed" || !provider || (provider.kind === "skill" && !provider.location.path)) {
			updateGap(store, gap.id, { status: "failed" });
			audit(store, { actor: "main", event: "capability_failed", reason: `${gap.id} ${gap.capId}: toolsmith ${t.status}${provider ? "" : ", no provider registered"}` });
			return;
		}
		// Conformance is written by a different role than the builder (agent-core §9.4).
		const missionId = newId("m");
		const spec: MissionSpecRecord = {
			missionId,
			intentId: t.intentId,
			role: "verifier",
			objective: `Conformance check of ${provider.name}@${provider.sha256.slice(0, 8)} for ${gap.capId}`,
			targets: t.spec.targets,
			testKinds: ["functional"],
			riskTier: t.riskTier,
			riskReasons: [`conformance of ${t.id}'s provider`],
			budget: DEFAULT_BUDGETS.verifier,
			model: t.spec.model,
			// The candidate is bound here on purpose: checking it is what promotes it.
			bindings: [bindingOf(store, provider.sha256, gap.capId)].filter((b) => b !== undefined),
			conformance: {
				gapId: gap.id,
				capId: gap.capId,
				semantics: gap.spec.semantics,
				io: gap.spec.io,
				acceptanceHints: gap.spec.acceptance_hints,
				providerSha: provider.sha256,
				providerPath: provider.location.path ?? `mcp server ${provider.location.server}`,
				providerName: provider.name,
			},
		};
		this.insertAndStart(spec, t.id);
	}

	/** Promotion is computed from the conformance verifier's own test runs, not its wording. */
	private afterConformance(v: MissionRow): void {
		const { store } = this.opts;
		const c = v.spec.conformance;
		if (!c) return;
		const env = v.envelope as Envelope | null;
		const decided = listTestRuns(store, v.id).filter((r) => r.verdict === "pass" || r.verdict === "fail");
		const passed = decided.filter((r) => r.verdict === "pass").length;
		const score = decided.length ? passed / decided.length : 0;
		const binding = bindingOf(store, c.providerSha, c.capId);
		const intact = binding ? verifyBinding(binding) : { ok: false as const, reason: "provider missing" };
		const ok = v.status === "completed" && !!env?.claims.some((x) => x.type === "pass") && !env.claims.some((x) => x.type === "defect") && score >= 0.9 && intact.ok;
		if (!intact.ok) quarantineProvider(store, c.providerSha, "main", intact.reason);
		store.tx(() => {
			if (ok) setProviderTrust(store, c.providerSha, "verified", score);
			updateGap(store, c.gapId, { status: ok ? "resolved" : "failed" });
			audit(store, {
				actor: "main",
				event: ok ? "provider_verified" : "provider_rejected",
				decision: ok ? "verified" : "candidate",
				reason: `${c.capId} ← ${c.providerName}@${c.providerSha.slice(0, 8)} conformance ${passed}/${decided.length}`,
			});
		});
	}

	// ------------------------------------------------------------ closing an intent

	/** Report, close, background curator (M2-8), and background learning (M3). */
	finalizeIntent(intentId: string, input: { conclusion: string; uncovered?: string[]; notes?: string; force?: boolean }): { report: ReportResult; curator?: string; learning: Promise<unknown> } {
		const { store, paths } = this.opts;
		const intent = getIntent(store, intentId);
		if (!intent) throw new Error(`unknown intent ${intentId}`);
		const running = listMissions(store, { intentId, statuses: ["queued", "running"] }).filter((m) => m.role !== "curator");
		if (running.length > 0 && !input.force) {
			throw new Error(`${running.length} mission(s) still running (${running.map((m) => m.id).join(", ")}); end your turn and wait, or pass force: true`);
		}
		const report = buildReport(store, paths, { intentId, conclusion: input.conclusion, uncoveredTargets: input.uncovered, notes: input.notes, isolation: this.runner.isolation() });
		store.tx(() => {
			closeIntent(store, intentId, report.path);
			audit(store, { actor: "main", event: "report_finalize", reason: `${intentId}: ${report.path}` });
		});
		const curator = this.afterIntentClosed(intentId);
		const learning = this.learner.enqueue(intentId).catch(() => undefined);
		return { report, curator, learning };
	}

	/** Resolves once queued learning has run (tests, /test-kb). */
	learningIdle(): Promise<void> {
		return this.learner.idle();
	}

	/** An accumulated hypothesis reached its threshold: a curator turns it into a gated delta. */
	dispatchDeltaCurator(deltaId: string): string | undefined {
		const { store } = this.opts;
		const d = listDeltas(store).find((x) => x.id === deltaId);
		if (!d || (d.status !== "suspended" && d.status !== "pending")) return undefined;
		if (listMissions(store).some((m) => m.spec.deltaTask?.deltaId === deltaId && m.status !== "failed" && m.status !== "aborted")) return undefined;
		const episodes = d.evidence.map((id) => listEpisodes(store, {}).find((e) => e.id === id)).filter((e) => e !== undefined);
		const latest = episodes.at(-1);
		if (!latest) return undefined;
		const missions = episodes.map((e) => getMission(store, e.missionId)).filter((m) => m !== undefined);
		const condition =
			d.op === "except"
				? ((d.payload as { exception: { when: Array<{ facet: string; op: string; value?: string; values?: string[] }> } }).exception.when ?? []).map((w) => `${w.facet} ${w.op} ${w.value ?? w.values?.join("|")}`).join(" ∧ ")
				: d.op;
		const digest = [
			`evidence (${episodes.length} episode(s)):`,
			...missions.map((m) => {
				const env = m.envelope as Envelope | null;
				return [
					`- ${m.id}: ${env?.summary ?? m.objective}`,
					...(env?.deviations ?? []).map((x) => `  deviation @${x.at}: expected ${x.expected}; observed ${x.observed}${x.agent_hypothesis ? ` (${x.agent_hypothesis})` : ""}`),
					...claimViews(store, m).map((v) => `  claim [${v.claim.type}, ${v.status}] ${v.claim.statement}${v.note ? ` — ${v.note}` : ""}`),
				].join("\n");
			}),
		].join("\n");
		const fingerprint = activeOnly(store, mergeFingerprints(...episodes.map((e) => e.fingerprint)));
		const missionId = newId("m");
		const spec: MissionSpecRecord = {
			missionId,
			intentId: latest.intentId,
			role: "curator",
			objective: `Turn hypothesis ${d.id} (${d.op} on ${d.target}) into a delta`,
			targets: [],
			testKinds: [],
			riskTier: "R0",
			riskReasons: ["curator writes only through the gate"],
			budget: DEFAULT_BUDGETS.curator,
			model: missions[0]?.spec.model ?? this.lastModel,
			deltaTask: { deltaId: d.id, op: d.op, target: d.target, condition, digest },
			// For a replacement slot template born from these episodes (template_propose).
			curate: { episodeIds: episodes.map((e) => e.id), fingerprint, capabilities: [], riskFloor: "R0", evidenceKinds: [], digest },
		};
		this.insertAndStart(spec);
		updateMission(store, missionId, { notifiedAt: nowIso() });
		audit(store, { actor: "main", event: "delta_curator", reason: `${missionId} for ${d.id}` });
		return missionId;
	}

	// ------------------------------------------------------------ curator (M2-8)

	/** After report_finalize: retrieved-unused records, and a background Curator for H0/H1 successes. */
	afterIntentClosed(intentId: string): string | undefined {
		const { store } = this.opts;
		recordRetrievedUnused(store, intentId);
		const intent = getIntent(store, intentId);
		if (!intent || (intent.hitLevel !== "H0" && intent.hitLevel !== "H1" && intent.hitLevel !== null)) return undefined;
		const executors = listMissions(store, { intentId }).filter((m) => m.role === "executor" && m.status === "completed");
		const confirmed = executors.filter((m) => claimViews(store, m).some((v) => v.status === "confirmed"));
		if (confirmed.length === 0) return undefined;
		return this.dispatchCurator(intentId, confirmed);
	}

	private dispatchCurator(intentId: string, executors: MissionRow[]): string {
		const { store } = this.opts;
		const intent = getIntent(store, intentId) as NonNullable<ReturnType<typeof getIntent>>;
		const episodes = listEpisodes(store, { intentId }).filter((e) => executors.some((x) => x.id === e.missionId));
		const fingerprint = activeOnly(store, mergeFingerprints(...episodes.map((e) => e.fingerprint)));
		const capabilities = [
			...executors.flatMap((m) => (m.spec.bindings ?? []).map((b) => b.capId)),
			...listMissions(store, { intentId }).flatMap((m) => listGaps(store, { requestedBy: m.id }).filter((g) => g.status === "resolved").map((g) => g.capId)),
		];
		const riskFloor = executors.map((m) => m.riskTier).sort((a, b) => RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b))[0] ?? "R0";
		const views = executors.flatMap((m) => claimViews(store, m));
		const evidenceKinds = [
			...(views.some((v) => v.claim.type === "defect" && v.status === "confirmed") ? ["minimal_repro"] : []),
			...(executors.some((m) => listFrozen(store, m.id).length > 0) ? ["frozen_script"] : []),
			"independent_replay",
		];
		const recalled = listRetrievals(store, intentId).flatMap((r) => r.cards).slice(0, 3);
		const digest = [
			`intent: ${intent.raw}`,
			`hit level: ${intent.hitLevel ?? "H0"}`,
			...executors.map((m) => {
				const env = m.envelope as Envelope;
				const runs = listTestRuns(store, m.id).map((r) => `${r.command} → ${r.verdict}`);
				return [
					`executor ${m.id}: ${m.objective}`,
					`  summary: ${env.summary}`,
					...claimViews(store, m).map((v) => `  claim [${v.claim.type}, ${v.status}] ${v.claim.statement}${v.claim.oracle ? ` (oracle ${v.claim.oracle.kind})` : ""}`),
					...(env.deviations ?? []).map((d) => `  deviation @${d.at}: expected ${d.expected}; observed ${d.observed}`),
					...runs.map((r) => `  test_run: ${r}`),
				].join("\n");
			}),
			`fingerprint: ${Object.entries(fingerprint).map(([k, v]) => `${k}=${v.values.join("|")}`).join(", ")}`,
			recalled.length ? `existing templates you may compose: ${recalled.map((c) => c.id).join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n");
		const missionId = newId("m");
		const spec: MissionSpecRecord = {
			missionId,
			intentId,
			role: "curator",
			objective: `Distill a draft template from intent ${intentId}`,
			targets: [],
			testKinds: [],
			riskTier: "R0",
			riskReasons: ["curator writes only the draft area"],
			budget: DEFAULT_BUDGETS.curator,
			model: executors[0].spec.model,
			curate: { episodeIds: episodes.map((e) => e.id), fingerprint, capabilities: [...new Set(capabilities)], riskFloor, evidenceKinds, digest },
		};
		this.insertAndStart(spec);
		// Silent: the curator never wakes the main session.
		updateMission(store, missionId, { notifiedAt: nowIso() });
		return missionId;
	}

	private scheduleFlush(delay = this.opts.notifyDebounceMs ?? 500): void {
		if (this.closed) return;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushNotifications();
		}, delay);
		this.flushTimer.unref?.();
	}

	/** A mission is settled when it and all its descendants have stopped moving on their own. */
	private settled(m: MissionRow, children: Map<string, MissionRow[]>): boolean {
		const own = TERMINAL_STATUSES.includes(m.status) || m.status === "blocked" || m.status === "interrupted";
		return own && (children.get(m.id) ?? []).every((c) => this.settled(c, children));
	}

	private childrenMap(): Map<string, MissionRow[]> {
		const children = new Map<string, MissionRow[]>();
		for (const m of listMissions(this.opts.store)) if (m.parentId) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
		return children;
	}

	private descendants(id: string, children: Map<string, MissionRow[]>): MissionRow[] {
		return (children.get(id) ?? []).flatMap((c) => [c, ...this.descendants(c.id, children)]);
	}

	/**
	 * Root missions whose end has not been delivered yet (outbox). A root waits for its whole
	 * subtree (verifier, toolsmith, conformance check) so the main session wakes once per result.
	 */
	pendingNotifications(): MissionRow[] {
		const children = this.childrenMap();
		return listMissions(this.opts.store).filter((m) => {
			if (m.parentId || m.notifiedAt || m.role === "curator") return false;
			if (!this.settled(m, children)) return false;
			if (m.status === "aborted" && m.interruptReason === "shutdown") return false; // offered on re-entry instead
			if (m.status === "interrupted" && m.interruptReason !== "network") return false; // crash recovery menu
			if (m.status === "blocked" && !m.envelope && m.error?.startsWith("side effects")) return false; // recovery menu
			return true;
		});
	}

	flushNotifications(): number {
		if (!this.main || this.closed) return 0;
		const { store } = this.opts;
		const due = this.pendingNotifications();
		if (due.length === 0) return 0;
		const content = this.wakeMessage(due);
		const details = { missions: due.map((m) => ({ id: m.id, intentId: m.intentId, role: m.role, status: m.status })) };
		if (!this.main.notify(content, details)) return 0;
		const ts = nowIso();
		const children = this.childrenMap();
		store.tx(() => {
			for (const m of due) for (const x of [m, ...this.descendants(m.id, children)]) if (!x.notifiedAt) updateMission(store, x.id, { notifiedAt: ts });
			audit(store, { actor: "main", event: "wake", reason: due.map((m) => m.id).join(",") });
		});
		return due.length;
	}

	missionSummary(m: MissionRow): string {
		const { store } = this.opts;
		const env = m.envelope as Envelope | null;
		const lines = [`- ${m.id} (${m.role}, ${m.riskTier}) → ${m.status}${m.interruptReason ? `/${m.interruptReason}` : ""}${m.error ? `: ${m.error}` : ""}`];
		if (env?.summary) lines.push(`  summary: ${env.summary}`);
		for (const t of m.spec.templates ?? []) lines.push(`  - template ${t.id}@${t.version}${t.exceptionId ? ` (exception ${t.exceptionId})` : ""}`);
		for (const v of claimViews(store, m)) {
			const tag = v.status === "not_applicable" ? v.claim.type : `${v.claim.type}, ${v.status}`;
			lines.push(`  - [${tag}] ${v.claim.statement}`);
		}
		for (const d of env?.deviations ?? []) lines.push(`  - deviation @${d.at}: expected "${d.expected}", observed "${d.observed}"`);
		for (const g of listGaps(store, { requestedBy: m.id })) {
			const p = g.providerSha ? getProvider(store, g.providerSha) : undefined;
			lines.push(`  - capability ${g.capId}: ${g.status}${p ? ` (provider ${p.name}@${p.sha256.slice(0, 8)}, ${p.trust})` : ""}`);
		}
		return lines.join("\n");
	}

	private wakeMessage(due: MissionRow[]): string {
		const byIntent = new Map<string, MissionRow[]>();
		for (const m of due) byIntent.set(m.intentId, [...(byIntent.get(m.intentId) ?? []), m]);
		const parts = ["[testmode] Mission results arrived."];
		for (const [intentId, ms] of byIntent) {
			const open = listMissions(this.opts.store, { intentId, statuses: ["queued", "running"] }).length;
			parts.push(`\nIntent ${intentId}${open ? ` (${open} mission(s) still running)` : ""}:`, ...ms.map((m) => this.missionSummary(m)));
		}
		parts.push(
			"\nOnly claims marked confirmed count as findings. Dispatch follow-up missions if the intent is not yet satisfied; otherwise call report_finalize.",
		);
		return parts.join("\n");
	}

	// ------------------------------------------------------------ crash recovery (M1-14)

	/**
	 * Startup scan: running/queued missions whose owner is gone become `interrupted(crash)`.
	 * Missions of another live pi process with a fresh heartbeat are left alone.
	 */
	recoverOnStartup(now = Date.now()): MissionRow[] {
		const { store } = this.opts;
		const staleMs = this.opts.staleAfterMs ?? 60_000;
		const marked: MissionRow[] = [];
		for (const m of listMissions(store, { statuses: ["running", "queued"] })) {
			if (this.runner.isActive(m.id)) continue;
			const heartbeat = m.heartbeatAt ? Date.parse(m.heartbeatAt) : 0;
			const fresh = now - heartbeat < staleMs;
			const ownerAlive = m.ownerPid !== null && m.ownerPid !== process.pid && isPidAlive(m.ownerPid);
			if (fresh && ownerAlive) continue; // another live pi process owns it
			store.tx(() => {
				updateMission(store, m.id, { status: "interrupted", interruptReason: "crash", ownerPid: null });
				audit(store, { actor: "main", event: "mission_interrupted", reason: `${m.id}: crash (pid ${m.ownerPid ?? "none"}, heartbeat ${m.heartbeatAt ?? "never"})` });
			});
			marked.push(getMission(store, m.id) as MissionRow);
		}
		return marked;
	}

	/** Missions waiting for a human decision: resume, re-dispatch, or abandon (M1-14 §7). */
	parkedMissions(): MissionRow[] {
		return listMissions(this.opts.store, { statuses: ["interrupted", "blocked", "aborted"] }).filter((m) => {
			if (m.status === "aborted") return m.interruptReason === "shutdown" && !m.notifiedAt;
			if (m.status === "blocked") return !m.envelope;
			return true;
		});
	}

	async resumeMission(missionId: string, confirmUnknownSideEffects = false): Promise<ResumeResult> {
		const r = await this.runner.resume(missionId, { confirmUnknownSideEffects });
		if (r.kind === "failed") this.scheduleFlush();
		return r;
	}

	/** Re-dispatches the same spec as a new mission and retires the old one. */
	redispatch(missionId: string): string {
		const { store } = this.opts;
		const m = getMission(store, missionId);
		if (!m) throw new Error(`unknown mission ${missionId}`);
		const spec: MissionSpecRecord = { ...m.spec, missionId: newId("m") };
		store.tx(() => {
			updateMission(store, m.id, { status: "aborted", error: `re-dispatched as ${spec.missionId}`, notifiedAt: nowIso(), endedAt: m.endedAt ?? nowIso() });
		});
		this.insertAndStart(spec, m.parentId ?? undefined);
		return spec.missionId;
	}

	abandon(missionId: string): void {
		const { store } = this.opts;
		store.tx(() => {
			updateMission(store, missionId, { status: "aborted", error: "abandoned by user", notifiedAt: nowIso(), endedAt: nowIso() });
			audit(store, { actor: "main", event: "mission_abandoned", reason: missionId });
		});
		this.scheduleFlush();
	}
}
