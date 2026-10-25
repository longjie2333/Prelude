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
import { putEvidence } from "../harness/evidence.ts";
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
import type { Budget, Role } from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
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
			},
		};
		this.runner = opts.runnerFactory ? opts.runnerFactory(runnerOpts) : new SdkMissionRunner(runnerOpts);
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

		for (const req of requests) {
			const risk = assessMissionRisk({
				role: req.role,
				targets: req.targets,
				testKinds: req.testKinds,
				environment: ir.constraints?.environment,
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
		const m = getMission(this.opts.store, missionId);
		if (!m) return;
		if (m.status === "completed" && needsVerification(m) && !verifierOf(this.opts.store, m.id)) {
			try {
				this.dispatchVerifier(m);
			} catch (err) {
				audit(this.opts.store, { actor: "main", event: "verifier_dispatch_failed", reason: `${m.id}: ${(err as Error).message}` });
			}
		}
		this.scheduleFlush();
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

	/** Missions whose end has not been delivered to the main session yet (outbox). */
	pendingNotifications(): MissionRow[] {
		const { store } = this.opts;
		const ended = listMissions(store, { statuses: [...TERMINAL_STATUSES, "blocked", "interrupted"] }).filter((m) => !m.notifiedAt);
		return ended.filter((m) => {
			if (m.status === "aborted" && m.interruptReason === "shutdown") return false; // offered on re-entry instead
			if (m.status === "interrupted" && m.interruptReason !== "network") return false; // crash recovery menu
			if (m.status === "blocked" && !m.envelope && m.error?.startsWith("side effects")) return false; // recovery menu
			if (m.role === "verifier" && m.parentId) return false; // reported with its executor
			if (m.role === "executor" && m.status === "completed" && needsVerification(m)) {
				const v = verifierOf(store, m.id);
				if (!v) return false; // about to be dispatched
				if (!TERMINAL_STATUSES.includes(v.status) && v.status !== "blocked") return false;
			}
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
		store.tx(() => {
			for (const m of due) {
				updateMission(store, m.id, { notifiedAt: ts });
				const v = m.role === "executor" ? verifierOf(store, m.id) : undefined;
				if (v) updateMission(store, v.id, { notifiedAt: ts });
			}
			audit(store, { actor: "main", event: "wake", reason: due.map((m) => m.id).join(",") });
		});
		return due.length;
	}

	missionSummary(m: MissionRow): string {
		const env = m.envelope as Envelope | null;
		const lines = [`- ${m.id} (${m.role}, ${m.riskTier}) → ${m.status}${m.interruptReason ? `/${m.interruptReason}` : ""}${m.error ? `: ${m.error}` : ""}`];
		if (env?.summary) lines.push(`  summary: ${env.summary}`);
		for (const v of claimViews(this.opts.store, m)) {
			const tag = v.status === "not_applicable" ? v.claim.type : `${v.claim.type}, ${v.status}`;
			lines.push(`  - [${tag}] ${v.claim.statement}`);
		}
		for (const d of env?.deviations ?? []) lines.push(`  - deviation @${d.at}: expected "${d.expected}", observed "${d.observed}"`);
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
