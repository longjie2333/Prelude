import type { CapabilityBinding } from "../capabilities/registry.ts";
import type { CurateInput } from "../learning/curator.ts";
import type { Actor, Budget, Cost, EffectClass, InterruptReason, MissionStatus, RiskTier, Role, Verdict } from "../types.ts";
import { EMPTY_COST } from "../types.ts";
import { nowIso } from "../util.ts";
import type { Store } from "./db.ts";

// ---------------------------------------------------------------- intents

export interface IntentRow {
	id: string;
	raw: string;
	ir: unknown;
	status: "open" | "closed";
	reportPath: string | null;
	hitLevel: string | null;
	createdAt: string;
	closedAt: string | null;
}

export function insertIntent(s: Store, id: string, raw: string, ir: unknown): void {
	s.run("INSERT INTO intents (id, raw, ir_json, created_at) VALUES ($id, $raw, $ir, $ts)", {
		$id: id,
		$raw: raw,
		$ir: JSON.stringify(ir),
		$ts: nowIso(),
	});
}

export function getIntent(s: Store, id: string): IntentRow | undefined {
	const r = s.get<Record<string, string | null>>("SELECT * FROM intents WHERE id = $id", { $id: id });
	if (!r) return undefined;
	return {
		id: r.id as string,
		raw: r.raw as string,
		ir: JSON.parse(r.ir_json as string),
		status: r.status as IntentRow["status"],
		reportPath: r.report_path,
		hitLevel: r.hit_level ?? null,
		createdAt: r.created_at as string,
		closedAt: r.closed_at,
	};
}

export function closeIntent(s: Store, id: string, reportPath: string): void {
	s.run("UPDATE intents SET status = 'closed', report_path = $p, closed_at = $ts WHERE id = $id", {
		$id: id,
		$p: reportPath,
		$ts: nowIso(),
	});
}

// ---------------------------------------------------------------- missions

export interface MissionRow {
	id: string;
	intentId: string;
	parentId: string | null;
	role: Role;
	objective: string;
	spec: MissionSpecRecord;
	status: MissionStatus;
	interruptReason: InterruptReason | null;
	riskTier: RiskTier;
	budget: Budget;
	cost: Cost;
	envelope: unknown | null;
	error: string | null;
	sessionPath: string | null;
	runDir: string;
	ownerPid: number | null;
	heartbeatAt: string | null;
	resumeCount: number;
	notifiedAt: string | null;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
}

/** Persisted Mission Spec (agent-core §5.3), the full input needed to (re)start a mission. */
export interface MissionSpecRecord {
	missionId: string;
	intentId: string;
	role: Role;
	objective: string;
	targets: string[];
	testKinds: string[];
	context?: string;
	riskTier: RiskTier;
	riskReasons: string[];
	budget: Budget;
	/** Model to run with, captured as plain data from the main session at dispatch time. */
	model?: { provider: string; id: string };
	/** Verifier only: the claims to re-check and where to find what the executor froze. */
	verify?: VerifyInput;
	/** Activated templates (D2), with the exception that fired for this mission, if any. */
	templates?: Array<{ id: string; version: number; exceptionId?: string }>;
	/** Providers bound to this mission, hash-locked at dispatch. */
	bindings?: CapabilityBinding[];
	/** Required capabilities with no verified provider. */
	unboundCaps?: string[];
	/** Toolsmith only: the capability gap to fill. */
	gap?: GapInput;
	/** Conformance verifier only: the candidate provider under test. */
	conformance?: GapInput & { providerSha: string; providerPath: string; providerName: string };
	/** Curator only. */
	curate?: CurateInput;
	/** Delta curator only (M3-5): the accumulated hypothesis to turn into a delta. */
	deltaTask?: { deltaId: string; op: string; target: string; condition: string; digest: string };
	/** Facets the mission must observe and report (open hypotheses on its templates). */
	probes?: string[];
}

export interface GapInput {
	gapId: string;
	capId: string;
	semantics: string;
	io?: unknown;
	acceptanceHints?: string[];
}

export interface VerifyInput {
	executorMissionId: string;
	claims: Array<{ id: string; type: string; statement: string; testRunIds: string[]; evidence: string[] }>;
	artifacts: Array<{ path: string; sha256: string }>;
	testRuns: Array<{ id: string; command: string; verdict: Verdict | null }>;
}

function toMission(r: Record<string, unknown>): MissionRow {
	return {
		id: r.id as string,
		intentId: r.intent_id as string,
		parentId: (r.parent_id as string) ?? null,
		role: r.role as Role,
		objective: r.objective as string,
		spec: JSON.parse(r.spec_json as string),
		status: r.status as MissionStatus,
		interruptReason: (r.interrupt_reason as InterruptReason) ?? null,
		riskTier: r.risk_tier as RiskTier,
		budget: JSON.parse(r.budget_json as string),
		cost: { ...EMPTY_COST, ...JSON.parse((r.cost_json as string) || "{}") },
		envelope: r.envelope_json ? JSON.parse(r.envelope_json as string) : null,
		error: (r.error as string) ?? null,
		sessionPath: (r.session_path as string) ?? null,
		runDir: r.run_dir as string,
		ownerPid: (r.owner_pid as number) ?? null,
		heartbeatAt: (r.heartbeat_at as string) ?? null,
		resumeCount: Number(r.resume_count ?? 0),
		notifiedAt: (r.notified_at as string) ?? null,
		createdAt: r.created_at as string,
		startedAt: (r.started_at as string) ?? null,
		endedAt: (r.ended_at as string) ?? null,
	};
}

export function insertMission(s: Store, spec: MissionSpecRecord, runDir: string, parentId?: string): void {
	s.run(
		`INSERT INTO missions (id, intent_id, parent_id, role, objective, spec_json, status, risk_tier, budget_json, run_dir, created_at)
		 VALUES ($id, $intent, $parent, $role, $obj, $spec, 'queued', $tier, $budget, $run, $ts)`,
		{
			$id: spec.missionId,
			$intent: spec.intentId,
			$parent: parentId ?? null,
			$role: spec.role,
			$obj: spec.objective,
			$spec: JSON.stringify(spec),
			$tier: spec.riskTier,
			$budget: JSON.stringify(spec.budget),
			$run: runDir,
			$ts: nowIso(),
		},
	);
}

export function getMission(s: Store, id: string): MissionRow | undefined {
	const r = s.get<Record<string, unknown>>("SELECT * FROM missions WHERE id = $id", { $id: id });
	return r ? toMission(r) : undefined;
}

export function listMissions(s: Store, where: { intentId?: string; statuses?: readonly MissionStatus[]; parentId?: string } = {}): MissionRow[] {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.intentId) {
		clauses.push("intent_id = $intent");
		params.$intent = where.intentId;
	}
	if (where.parentId) {
		clauses.push("parent_id = $parent");
		params.$parent = where.parentId;
	}
	if (where.statuses) {
		const names = where.statuses.map((st, i) => {
			params[`$s${i}`] = st;
			return `$s${i}`;
		});
		clauses.push(`status IN (${names.join(",") || "''"})`);
	}
	const sql = `SELECT * FROM missions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`;
	return s.all<Record<string, unknown>>(sql, params).map(toMission);
}

export interface MissionPatch {
	status?: MissionStatus;
	interruptReason?: InterruptReason | null;
	cost?: Cost;
	envelope?: unknown;
	error?: string | null;
	sessionPath?: string;
	ownerPid?: number | null;
	heartbeatAt?: string | null;
	resumeCount?: number;
	notifiedAt?: string | null;
	startedAt?: string;
	endedAt?: string | null;
}

const PATCH_COLUMNS: Record<keyof MissionPatch, string> = {
	status: "status",
	interruptReason: "interrupt_reason",
	cost: "cost_json",
	envelope: "envelope_json",
	error: "error",
	sessionPath: "session_path",
	ownerPid: "owner_pid",
	heartbeatAt: "heartbeat_at",
	resumeCount: "resume_count",
	notifiedAt: "notified_at",
	startedAt: "started_at",
	endedAt: "ended_at",
};

export function updateMission(s: Store, id: string, patch: MissionPatch): void {
	const sets: string[] = [];
	const params: Record<string, string | number | null> = { $id: id };
	for (const [key, value] of Object.entries(patch) as Array<[keyof MissionPatch, unknown]>) {
		if (value === undefined) continue;
		const col = PATCH_COLUMNS[key];
		sets.push(`${col} = $${col}`);
		params[`$${col}`] =
			key === "cost" || key === "envelope" ? (value === null ? null : JSON.stringify(value)) : (value as string | number | null);
	}
	if (sets.length === 0) return;
	s.run(`UPDATE missions SET ${sets.join(", ")} WHERE id = $id`, params);
}

// ---------------------------------------------------------------- tool journal

export interface JournalRow {
	missionId: string;
	toolCallId: string;
	tool: string;
	inputDigest: string;
	effectClass: EffectClass;
	status: "started" | "finished";
	isError: boolean | null;
	resultDigest: string | null;
	resultRef: string | null;
}

export function journalStart(s: Store, e: { missionId: string; toolCallId: string; tool: string; inputDigest: string; effectClass: EffectClass }): void {
	s.run(
		`INSERT INTO tool_journal (mission_id, tool_call_id, tool, input_digest, effect_class, status, started_at)
		 VALUES ($m, $c, $t, $d, $e, 'started', $ts)
		 ON CONFLICT(mission_id, tool_call_id) DO NOTHING`,
		{ $m: e.missionId, $c: e.toolCallId, $t: e.tool, $d: e.inputDigest, $e: e.effectClass, $ts: nowIso() },
	);
}

export function journalFinish(s: Store, e: { missionId: string; toolCallId: string; isError: boolean; resultDigest: string; resultRef: string | null }): void {
	s.run(
		`UPDATE tool_journal SET status = 'finished', is_error = $err, result_digest = $d, result_ref = $r, finished_at = $ts
		 WHERE mission_id = $m AND tool_call_id = $c`,
		{ $m: e.missionId, $c: e.toolCallId, $err: e.isError, $d: e.resultDigest, $r: e.resultRef, $ts: nowIso() },
	);
}

export function getJournal(s: Store, missionId: string, toolCallId: string): JournalRow | undefined {
	const r = s.get<Record<string, unknown>>("SELECT * FROM tool_journal WHERE mission_id = $m AND tool_call_id = $c", {
		$m: missionId,
		$c: toolCallId,
	});
	if (!r) return undefined;
	return {
		missionId: r.mission_id as string,
		toolCallId: r.tool_call_id as string,
		tool: r.tool as string,
		inputDigest: r.input_digest as string,
		effectClass: r.effect_class as EffectClass,
		status: r.status as JournalRow["status"],
		isError: r.is_error === null || r.is_error === undefined ? null : Boolean(r.is_error),
		resultDigest: (r.result_digest as string) ?? null,
		resultRef: (r.result_ref as string) ?? null,
	};
}

// ---------------------------------------------------------------- evidence

export function insertEvidence(s: Store, e: { sha256: string; missionId: string | null; kind: string; path: string; bytes: number }): void {
	s.run(
		`INSERT INTO evidence (sha256, mission_id, kind, path, bytes, created_at) VALUES ($h, $m, $k, $p, $b, $ts)
		 ON CONFLICT(sha256) DO NOTHING`,
		{ $h: e.sha256, $m: e.missionId, $k: e.kind, $p: e.path, $b: e.bytes, $ts: nowIso() },
	);
}

export function evidenceShas(s: Store): Set<string> {
	return new Set(s.all<{ sha256: string }>("SELECT sha256 FROM evidence").map((r) => r.sha256));
}

// ---------------------------------------------------------------- test runs

export interface TestRunRow {
	id: string;
	missionId: string;
	toolCallId: string | null;
	command: string;
	cwd: string;
	exitCode: number | null;
	durationMs: number | null;
	stdoutSha: string | null;
	stderrSha: string | null;
	verdict: Verdict | null;
	verdictNote: string | null;
	artifactShas: string[];
}

function toTestRun(r: Record<string, unknown>): TestRunRow {
	return {
		id: r.id as string,
		missionId: r.mission_id as string,
		toolCallId: (r.tool_call_id as string) ?? null,
		command: r.command as string,
		cwd: r.cwd as string,
		exitCode: (r.exit_code as number) ?? null,
		durationMs: (r.duration_ms as number) ?? null,
		stdoutSha: (r.stdout_sha as string) ?? null,
		stderrSha: (r.stderr_sha as string) ?? null,
		verdict: (r.verdict as Verdict) ?? null,
		verdictNote: (r.verdict_note as string) ?? null,
		artifactShas: JSON.parse((r.artifact_shas_json as string) || "[]"),
	};
}

export function insertTestRunStart(s: Store, e: { id: string; missionId: string; toolCallId: string; command: string; cwd: string; artifactShas: string[] }): void {
	s.run(
		`INSERT INTO test_runs (id, mission_id, tool_call_id, command, cwd, artifact_shas_json, started_at)
		 VALUES ($id, $m, $c, $cmd, $cwd, $a, $ts)`,
		{ $id: e.id, $m: e.missionId, $c: e.toolCallId, $cmd: e.command, $cwd: e.cwd, $a: JSON.stringify(e.artifactShas), $ts: nowIso() },
	);
}

export function finishTestRun(
	s: Store,
	id: string,
	e: { exitCode: number | null; durationMs: number; stdoutSha: string | null; stderrSha: string | null; verdict: Verdict; note?: string },
): void {
	s.run(
		`UPDATE test_runs SET exit_code = $x, duration_ms = $d, stdout_sha = $o, stderr_sha = $e, verdict = $v, verdict_note = $n, finished_at = $ts
		 WHERE id = $id`,
		{ $id: id, $x: e.exitCode, $d: e.durationMs, $o: e.stdoutSha, $e: e.stderrSha, $v: e.verdict, $n: e.note ?? null, $ts: nowIso() },
	);
}

export function getTestRun(s: Store, id: string): TestRunRow | undefined {
	const r = s.get<Record<string, unknown>>("SELECT * FROM test_runs WHERE id = $id", { $id: id });
	return r ? toTestRun(r) : undefined;
}

export function listTestRuns(s: Store, missionId: string): TestRunRow[] {
	return s.all<Record<string, unknown>>("SELECT * FROM test_runs WHERE mission_id = $m ORDER BY started_at, id", { $m: missionId }).map(toTestRun);
}

/** Test runs that never finished (the process died mid-run): their verdict is void (M1-14 4b). */
export function voidUnfinishedTestRuns(s: Store, missionId: string): number {
	return s.run(
		`UPDATE test_runs SET verdict = 'inconclusive', verdict_note = 'interrupted: verdict void', finished_at = $ts
		 WHERE mission_id = $m AND finished_at IS NULL`,
		{ $m: missionId, $ts: nowIso() },
	).changes;
}

// ---------------------------------------------------------------- frozen artifacts

export function freezeArtifact(s: Store, e: { missionId: string; path: string; sha256: string }): void {
	s.run(
		`INSERT INTO frozen_artifacts (path, sha256, mission_id, frozen_at) VALUES ($p, $h, $m, $ts)
		 ON CONFLICT(mission_id, path) DO UPDATE SET sha256 = excluded.sha256, frozen_at = excluded.frozen_at`,
		{ $p: e.path, $h: e.sha256, $m: e.missionId, $ts: nowIso() },
	);
}

export function listFrozen(s: Store, missionId?: string): Array<{ path: string; sha256: string; missionId: string }> {
	const rows = missionId
		? s.all<Record<string, string>>("SELECT * FROM frozen_artifacts WHERE mission_id = $m", { $m: missionId })
		: s.all<Record<string, string>>("SELECT * FROM frozen_artifacts");
	return rows.map((r) => ({ path: r.path, sha256: r.sha256, missionId: r.mission_id }));
}

// ---------------------------------------------------------------- approvals

export function insertApproval(
	s: Store,
	e: { id: string; missionId: string | null; tier: RiskTier; subject: string; decision: "approved" | "denied"; scope: "once" | "session" | "always" },
): void {
	s.run(
		`INSERT INTO approvals (id, mission_id, tier, subject, decision, scope, decided_at)
		 VALUES ($id, $m, $t, $s, $d, $sc, $ts)`,
		{ $id: e.id, $m: e.missionId, $t: e.tier, $s: e.subject, $d: e.decision, $sc: e.scope, $ts: nowIso() },
	);
}

/** True when a standing ("always") approval exists for this subject. */
export function hasStandingApproval(s: Store, subject: string): boolean {
	return !!s.get("SELECT 1 FROM approvals WHERE subject = $s AND decision = 'approved' AND scope = 'always' LIMIT 1", { $s: subject });
}

// ---------------------------------------------------------------- audit

export interface AuditEntry {
	actor: Actor;
	event: string;
	tool?: string;
	inputDigest?: string;
	decision?: string;
	reason?: string;
}

export function audit(s: Store, e: AuditEntry): void {
	s.run(
		"INSERT INTO audit (ts, actor, event, tool, input_digest, decision, reason) VALUES ($ts, $a, $e, $t, $d, $dec, $r)",
		{ $ts: nowIso(), $a: e.actor, $e: e.event, $t: e.tool, $d: e.inputDigest, $dec: e.decision, $r: e.reason },
	);
}

export function listAudit(s: Store, where: { actor?: string; event?: string } = {}): Array<AuditEntry & { seq: number; ts: string }> {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.actor) {
		clauses.push("actor = $a");
		params.$a = where.actor;
	}
	if (where.event) {
		clauses.push("event = $e");
		params.$e = where.event;
	}
	return s
		.all<Record<string, unknown>>(`SELECT * FROM audit ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY seq`, params)
		.map((r) => ({
			seq: Number(r.seq),
			ts: r.ts as string,
			actor: r.actor as Actor,
			event: r.event as string,
			tool: (r.tool as string) ?? undefined,
			inputDigest: (r.input_digest as string) ?? undefined,
			decision: (r.decision as string) ?? undefined,
			reason: (r.reason as string) ?? undefined,
		}));
}
