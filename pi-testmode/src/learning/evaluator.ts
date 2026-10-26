/**
 * Evaluator (agent-core §10.2–10.3, plan M3-1/M3-2): feedback signals computed by code from the
 * envelope, the verifier's outcome, and test runs. The model's own wording never scores.
 * Credibility multiplies independent penalties; detected cheating sets it to 0.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Envelope } from "../missions/envelope.ts";
import { claimViews, verifierOf } from "../orchestrator/verification.ts";
import type { Store } from "../store/db.ts";
import { getMission, listAudit, listFrozen, listTestRuns, type MissionRow, type TestRunRow } from "../store/repos.ts";

export type SelfCheck = "pass" | "fail" | "unavailable";

export interface Signals {
	claimedDefects: number;
	verifiedDefects: number;
	falsePositives: number;
	unconfirmedDefects: number;
	claimedPasses: number;
	verifiedPasses: number;
	refutedPasses: number;
	/** Share of cited runs (executor and verifier) whose verdict matches the claim. */
	reproducibility: number;
	flaky: boolean;
	errorRuns: number;
	voidedRuns: number;
	oracleSensitivity: SelfCheck;
	oracleSpecificity: SelfCheck;
	deviations: number;
	firstDeviation?: string;
	capabilityRequests: number;
	verifierStatus: string | null;
	tokens: number;
	missionStatus: string;
}

export interface Evaluation {
	signals: Signals;
	credibility: number;
	cheating: string[];
}

/** A script can fail when it exits non-zero on some path, asserts, or throws. `process.exit(0)` alone cannot. */
/**
 * Static fallback when no run exited non-zero: a non-zero or computed exit (`exit 1`, `exit $fail`,
 * `sys.exit(main())`, `process.exit(ok ? 0 : 1)`), an assertion, a throw/raise, or `set -e`.
 * `process.exit(0)` / `exit 0` alone cannot fail.
 */
const ASSERTS = /process\.exit\(\s*(?!0\s*\))[^)]|process\.exitCode\s*=|\bassert\b|\bexpect\(|\bthrow\b|\braise\b|\bexit\s+(?!0\b)\S|sys\.exit\(\s*(?!0\s*\))[^)]|\bset\s+-[a-z]*e/;
const SCRIPT = /\.(m?[jt]s|cjs|sh|py)$/i;

/** Agent-core §10.3 #8: tampering with frozen artifacts, tests that cannot fail, verifier-reported issues. */
export function detectCheating(s: Store, m: MissionRow): string[] {
	const out: string[] = [];
	const actor = `mission:${m.id}`;
	for (const a of listAudit(s, { actor })) {
		if (a.event === "artifact_tamper") out.push(`frozen artifact changed before a test_run: ${a.reason ?? ""}`);
		if (a.event === "tool_call" && a.decision === "block" && /frozen test artifact|modify scope\.json/.test(a.reason ?? "")) out.push(`attempted to modify a frozen artifact (${a.tool})`);
	}
	const v0 = verifierOf(s, m.id);
	const runs = [...listTestRuns(s, m.id), ...(v0 ? listTestRuns(s, v0.id) : [])];
	const frozen = listFrozen(s, m.id).filter((f) => SCRIPT.test(f.path) && existsSync(f.path));
	const nameOf = (p: string) => p.split(/[\\/]/).pop() as string;
	// Only entry points need a way to fail; helper modules they import (lib.mjs, oracle.mjs) do not.
	const invoked = frozen.filter((f) => runs.some((r) => r.command.toLowerCase().includes(nameOf(f.path))));
	for (const f of invoked.length ? invoked : frozen) {
		const name = nameOf(f.path);
		// Evidence beats heuristics: a run of the script that exited non-zero proves it can fail.
		if (runs.some((r) => r.command.toLowerCase().includes(name) && r.exitCode !== null && r.exitCode !== 0)) continue;
		if (!ASSERTS.test(readFileSync(f.path, "utf8"))) out.push(`${name} has no way to fail (no assertion or non-zero exit)`);
	}
	for (const issue of (v0?.envelope as Envelope | null)?.integrity_issues ?? []) out.push(`verifier: ${issue}`);
	return out;
}

function selfChecks(s: Store, verifier: MissionRow | undefined, verifiedDefects: number): { sensitivity: SelfCheck; specificity: SelfCheck } {
	const env = verifier?.envelope as Envelope | null | undefined;
	const runs = verifier ? new Map(listTestRuns(s, verifier.id).map((r) => [r.id, r])) : new Map<string, TestRunRow>();
	const check = (kind: "sensitivity" | "specificity", need: "fail" | "pass"): SelfCheck => {
		const ids = (env?.oracle_checks ?? []).filter((c) => c.kind === kind).flatMap((c) => c.test_run_ids);
		const rs = ids.map((id) => runs.get(id)).filter((r): r is TestRunRow => !!r && (r.verdict === "pass" || r.verdict === "fail"));
		if (rs.length === 0) return "unavailable";
		return rs.every((r) => r.verdict === need) ? "pass" : "fail";
	};
	// A confirmed defect is itself evidence of sensitivity: the oracle fired on a real fault.
	const sensitivity = verifiedDefects > 0 ? "pass" : check("sensitivity", "fail");
	return { sensitivity, specificity: check("specificity", "pass") };
}

export function evaluateMission(s: Store, missionId: string): Evaluation | undefined {
	const m = getMission(s, missionId);
	if (!m || m.role !== "executor") return undefined;
	const env = m.envelope as Envelope | null;
	const views = claimViews(s, m);
	const defects = views.filter((v) => v.claim.type === "defect");
	const passes = views.filter((v) => v.claim.type === "pass");
	const verifier = verifierOf(s, m.id);
	const execRuns = listTestRuns(s, m.id);
	const verRuns = verifier ? listTestRuns(s, verifier.id) : [];
	const byId = new Map([...execRuns, ...verRuns].map((r) => [r.id, r]));

	let agree = 0;
	let decided = 0;
	let flaky = false;
	for (const v of [...defects, ...passes]) {
		const need = v.claim.type === "defect" ? "fail" : "pass";
		const cited = [...(v.claim.test_run_ids ?? []), ...v.verifierRunIds].map((id) => byId.get(id)).filter((r): r is TestRunRow => !!r);
		const d = cited.filter((r) => r.verdict === "pass" || r.verdict === "fail");
		decided += d.length;
		agree += d.filter((r) => r.verdict === need).length;
		const vd = v.verifierRunIds.map((id) => byId.get(id)).filter((r) => r && (r.verdict === "pass" || r.verdict === "fail"));
		if (new Set(vd.map((r) => r?.verdict)).size > 1) flaky = true;
	}
	const verifiedDefects = defects.filter((v) => v.status === "confirmed").length;
	const checks = selfChecks(s, verifier, verifiedDefects);
	const devs = env?.deviations ?? [];
	const signals: Signals = {
		claimedDefects: defects.length,
		verifiedDefects,
		falsePositives: defects.filter((v) => v.status === "refuted").length,
		unconfirmedDefects: defects.filter((v) => v.status === "inconclusive" || v.status === "unverified").length,
		claimedPasses: passes.length,
		verifiedPasses: passes.filter((v) => v.status === "confirmed").length,
		refutedPasses: passes.filter((v) => v.status === "refuted").length,
		reproducibility: decided ? agree / decided : 0,
		flaky,
		errorRuns: [...execRuns, ...verRuns].filter((r) => r.verdict === "error").length,
		voidedRuns: [...execRuns, ...verRuns].filter((r) => r.verdictNote?.startsWith("interrupted")).length,
		oracleSensitivity: checks.sensitivity,
		oracleSpecificity: checks.specificity,
		deviations: devs.length,
		firstDeviation: devs[0]?.at,
		capabilityRequests: (env?.capability_issues ?? []).length,
		verifierStatus: verifier?.status ?? null,
		tokens: m.cost.tokens,
		missionStatus: m.status,
	};

	const cheating = detectCheating(s, m);
	let credibility = 1;
	if (!verifier) credibility *= 0.5; // no independent replay
	else if (verifier.status !== "completed") credibility *= 0.5;
	if (flaky) credibility *= 0.5;
	if (decided > 0 && signals.reproducibility < 0.6) credibility *= 0.7;
	if (cheating.length) credibility = 0;
	return { signals, credibility: Math.round(credibility * 1000) / 1000, cheating };
}
