/**
 * Mission tools: `test_run` (the only verdict source), `artifact_freeze`, and `mission_submit`
 * (adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/structured-output.ts).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalPath, isInside } from "../kernel/paths.ts";
import type { TestmodePaths } from "../paths.ts";
import { EnvelopeSchema, type Envelope, validateClaimsAgainstRuns } from "../missions/envelope.ts";
import type { Store } from "../store/db.ts";
import { audit, finishTestRun, freezeArtifact, insertTestRunStart, listFrozen, listTestRuns, type MissionSpecRecord } from "../store/repos.ts";
import type { Role, Verdict } from "../types.ts";
import { newId, sha256, textResult, truncate } from "../util.ts";
import { evidenceUri, putEvidence } from "./evidence.ts";
import { runShell } from "./process.ts";

export interface MissionToolHost {
	store: Store;
	missionId: string;
	role: Role;
	runDir: string;
	evidenceDir: string;
	root: string;
	paths: TestmodePaths;
	spec: MissionSpecRecord;
	/** Called once a valid envelope is submitted; the runner ends the mission. */
	onSubmit(envelope: Envelope): void;
	requestCapability?(req: CapabilityRequest): { message: string; gapId?: string };
}

export interface CapabilityRequest {
	capId: string;
	semantics: string;
	io?: unknown;
	acceptanceHints?: string[];
}

const TAIL = 2000;

/** Exit code → verdict. 126/127 mean the command could not run at all, which is no verdict on the SUT. */
export function verdictFor(r: { exitCode: number | null; timedOut: boolean; aborted: boolean; spawnError?: string }): { verdict: Verdict; note?: string } {
	if (r.spawnError) return { verdict: "error", note: `spawn failed: ${r.spawnError}` };
	if (r.aborted) return { verdict: "inconclusive", note: "aborted" };
	if (r.timedOut) return { verdict: "inconclusive", note: "timed out" };
	if (r.exitCode === null) return { verdict: "inconclusive", note: "killed by signal" };
	if (r.exitCode === 0) return { verdict: "pass" };
	if (r.exitCode === 126 || r.exitCode === 127) return { verdict: "error", note: `command not runnable (exit ${r.exitCode})` };
	return { verdict: "fail" };
}

function checkFrozen(host: MissionToolHost): { shas: string[]; tampered: string[] } {
	const shas: string[] = [];
	const tampered: string[] = [];
	for (const a of listFrozen(host.store, host.missionId)) {
		shas.push(a.sha256);
		if (!existsSync(a.path) || sha256(readFileSync(a.path)) !== a.sha256) tampered.push(a.path);
	}
	return { shas, tampered };
}

export function createTestRunTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "test_run",
		label: "Test Run",
		description:
			"Run a test command and record its verdict. The exit code decides the verdict: 0 = pass, non-zero = fail; timeouts are inconclusive. stdout/stderr are stored as evidence. This is the only way to produce a pass or fail verdict.",
		promptSnippet: "Run a test command; its exit code is the only source of pass/fail verdicts",
		promptGuidelines: [
			"Use test_run for every check whose outcome you will claim; write tests so that exit code 0 means the expected property held.",
			"Use test_run with a script you froze with artifact_freeze, so the verifier can replay the exact same check.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command (same shell as bash)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory, relative to the project root. Default: your run directory" })),
			timeout_s: Type.Optional(Type.Number({ description: "Timeout in seconds (default 300, max 1800)" })),
			purpose: Type.Optional(Type.String({ description: "What property this run checks" })),
		}),
		async execute(toolCallId, params, signal) {
			const cwd = params.cwd ? resolve(host.root, params.cwd) : host.runDir;
			const id = newId("tr");
			const frozen = checkFrozen(host);
			insertTestRunStart(host.store, { id, missionId: host.missionId, toolCallId, command: params.command, cwd, artifactShas: frozen.shas });
			if (frozen.tampered.length > 0) {
				const note = `frozen artifacts changed after freezing: ${frozen.tampered.join(", ")}`;
				finishTestRun(host.store, id, { exitCode: null, durationMs: 0, stdoutSha: null, stderrSha: null, verdict: "error", note });
				audit(host.store, { actor: `mission:${host.missionId}`, event: "artifact_tamper", tool: "test_run", decision: "block", reason: note });
				return textResult(`test_run ${id}: verdict error — ${note}. Tampered runs never count.`, { id, verdict: "error" }, { isError: true });
			}
			const timeoutMs = Math.min(Math.max(params.timeout_s ?? 300, 1), 1800) * 1000;
			const r = await runShell(params.command, {
				cwd,
				timeoutMs,
				signal,
				env: { TESTMODE_RUN_DIR: host.runDir, TESTMODE_MISSION_ID: host.missionId },
			});
			const out = putEvidence(host.store, host.evidenceDir, r.stdout, { missionId: host.missionId, kind: "stdout" });
			const err = putEvidence(host.store, host.evidenceDir, r.stderr, { missionId: host.missionId, kind: "stderr" });
			const { verdict, note } = verdictFor(r);
			finishTestRun(host.store, id, { exitCode: r.exitCode, durationMs: r.durationMs, stdoutSha: out.sha256, stderrSha: err.sha256, verdict, note });
			const text = [
				`test_run ${id}: verdict ${verdict}${note ? ` (${note})` : ""}, exit ${r.exitCode ?? "none"}, ${r.durationMs}ms`,
				`stdout: ${evidenceUri(out.sha256)}  stderr: ${evidenceUri(err.sha256)}`,
				r.stdout.trim() ? `--- stdout (tail)\n${truncate(r.stdout.slice(-TAIL), TAIL)}` : "",
				r.stderr.trim() ? `--- stderr (tail)\n${truncate(r.stderr.slice(-TAIL), TAIL)}` : "",
			]
				.filter(Boolean)
				.join("\n");
			return textResult(text, { id, verdict, exitCode: r.exitCode, stdout: out.sha256, stderr: err.sha256 });
		},
	});
}

export function createArtifactFreezeTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "artifact_freeze",
		label: "Freeze Artifact",
		description:
			"Freeze test scripts in your run directory: their sha256 is recorded and any later write or edit to them is blocked. Freeze before the test_run whose result you will claim.",
		promptSnippet: "Freeze test scripts so later edits are blocked and the verifier can replay them",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, description: "Files inside your run directory" }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const runDir = canonicalPath(host.runDir, host.root);
			const frozen: Array<{ path: string; sha256: string }> = [];
			for (const p of params.paths) {
				const abs = resolve(host.runDir, p);
				const canon = canonicalPath(abs, host.root);
				if (!isInside(canon, runDir)) throw new Error(`${p} is outside your run directory`);
				if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${p} does not exist or is not a file`);
				const data = readFileSync(abs);
				const ref = putEvidence(host.store, host.evidenceDir, data, { missionId: host.missionId, kind: "artifact" });
				freezeArtifact(host.store, { missionId: host.missionId, path: canon, sha256: ref.sha256 });
				frozen.push({ path: relative(host.runDir, abs).replaceAll("\\", "/"), sha256: ref.sha256 });
			}
			return textResult(frozen.map((f) => `frozen ${f.path} sha256=${f.sha256}`).join("\n"), { frozen });
		},
	});
}

export function createMissionSubmitTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "mission_submit",
		label: "Submit Mission",
		description:
			"Submit your result envelope and end the mission. Claims are statements, not facts: defect and pass claims must cite test_run ids whose verdict supports them (defect → fail, pass → pass).",
		promptSnippet: "Submit the result envelope; this ends the mission",
		promptGuidelines: [
			"Call mission_submit exactly once, as your final action.",
			"In mission_submit, list every assumption or surprise as a deviation and every unmet goal in goal_coverage.",
		],
		parameters: EnvelopeSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			if (!Value.Check(EnvelopeSchema, params)) throw new Error("envelope does not match the schema");
			const runs = listTestRuns(host.store, host.missionId);
			const errors = validateClaimsAgainstRuns(params.claims, runs, host.missionId);
			if (host.role === "verifier" && host.spec.verify) {
				const own = new Set(runs.map((r) => r.id));
				if (!params.verification?.length) errors.push("verifier envelopes must include verification entries for each claim");
				for (const v of params.verification ?? []) {
					for (const id of v.test_run_ids) if (!own.has(id)) errors.push(`verification of ${v.claim_id} cites ${id}, which is not one of your test_runs`);
				}
			}
			if (errors.length > 0) throw new Error(`Envelope rejected:\n- ${errors.join("\n- ")}\nFix and call mission_submit again.`);
			host.onSubmit(params);
			return textResult(`Envelope accepted (${params.status}, ${params.claims.length} claims). Mission ends.`, { status: params.status }, { terminate: true });
		},
	});
}
