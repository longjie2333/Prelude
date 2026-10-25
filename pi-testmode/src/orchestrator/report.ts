/**
 * Intent report (plan M1-11). Built deterministically from the store; the model only supplies
 * the conclusion text. Only verifier-confirmed defects count as defects.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Envelope } from "../missions/envelope.ts";
import type { TestmodePaths } from "../paths.ts";
import type { Store } from "../store/db.ts";
import { getIntent, listFrozen, listMissions, listTestRuns, type MissionRow } from "../store/repos.ts";
import type { Cost } from "../types.ts";
import { EMPTY_COST } from "../types.ts";
import { type ClaimView, claimViews } from "./verification.ts";

export interface ReportInput {
	intentId: string;
	conclusion: string;
	uncoveredTargets?: string[];
	notes?: string;
	isolation: string;
}

export interface ReportResult {
	path: string;
	markdown: string;
	confirmedDefects: number;
	confirmedPasses: number;
	unconfirmed: number;
	cost: Cost;
}

function addCost(a: Cost, b: Cost): Cost {
	return {
		tokens: a.tokens + b.tokens,
		input: a.input + b.input,
		output: a.output + b.output,
		costUsd: a.costUsd + b.costUsd,
		wallClockMs: a.wallClockMs + b.wallClockMs,
		turns: a.turns + b.turns,
	};
}

function fmtCost(c: Cost): string {
	return `${c.tokens.toLocaleString("en-US")} tokens, $${c.costUsd.toFixed(4)}, ${(c.wallClockMs / 1000).toFixed(1)}s`;
}

export function buildReport(store: Store, paths: TestmodePaths, input: ReportInput): ReportResult {
	const intent = getIntent(store, input.intentId);
	if (!intent) throw new Error(`unknown intent ${input.intentId}`);
	const ir = intent.ir as { assumptions?: string[]; constraints?: { environment?: string }; acceptance?: string[] };
	const missions = listMissions(store, { intentId: input.intentId });
	const rel = (p: string) => relative(paths.root, p).replaceAll("\\", "/");

	const views: ClaimView[] = missions.filter((m) => m.role === "executor").flatMap((m) => claimViews(store, m));
	const confirmedDefects = views.filter((v) => v.claim.type === "defect" && v.status === "confirmed");
	const confirmedPasses = views.filter((v) => v.claim.type === "pass" && v.status === "confirmed");
	const unconfirmed = views.filter((v) => (v.claim.type === "defect" || v.claim.type === "pass") && v.status !== "confirmed");
	const observations = missions.flatMap((m) =>
		((m.envelope as Envelope | null)?.claims ?? []).filter((c) => c.type === "observation" || c.type === "coverage").map((c) => ({ m, c })),
	);
	const byId = new Map(missions.map((m) => [m.id, m]));

	const evidenceLines = (v: ClaimView): string[] => {
		const exec = byId.get(v.missionId) as MissionRow;
		const runs = listTestRuns(store, exec.id).filter((r) => v.claim.test_run_ids?.includes(r.id));
		const vRuns = v.verifierId ? listTestRuns(store, v.verifierId).filter((r) => v.verifierRunIds.includes(r.id)) : [];
		const lines = runs.map((r) => `  - executor ${r.id}: \`${r.command}\` → ${r.verdict} (stdout ${rel(join(paths.evidenceDir, r.stdoutSha ?? ""))})`);
		lines.push(...vRuns.map((r) => `  - verifier ${r.id}: \`${r.command}\` → ${r.verdict} (stdout ${rel(join(paths.evidenceDir, r.stdoutSha ?? ""))})`));
		for (const a of listFrozen(store, exec.id)) lines.push(`  - frozen ${rel(a.path)} (sha256 ${a.sha256.slice(0, 12)}…)`);
		for (const e of v.claim.evidence ?? []) lines.push(`  - ${e}`);
		return lines;
	};

	const out: string[] = [];
	out.push(`# Test report — ${intent.id}`, "", `> ${intent.raw}`, "");
	out.push("## Conclusion", "", input.conclusion.trim(), "");

	out.push(`## Verified defects (${confirmedDefects.length})`, "");
	if (confirmedDefects.length === 0) out.push("None confirmed by an independent verifier.", "");
	for (const v of confirmedDefects) {
		out.push(`### ${v.claim.statement}`, "");
		out.push(`- Status: **confirmed** by ${v.verifierId}`);
		if (v.claim.oracle) out.push(`- Oracle: ${v.claim.oracle.kind} (strength ${v.claim.oracle.strength})`);
		if (v.claim.reproducibility) out.push(`- Reproducibility: ${v.claim.reproducibility}`);
		if (v.claim.minimal_repro) out.push("- Minimal reproduction:", "", "```", v.claim.minimal_repro, "```", "");
		out.push("- Evidence:", ...evidenceLines(v), "");
	}

	if (confirmedPasses.length > 0) {
		out.push(`## Verified passes (${confirmedPasses.length})`, "");
		for (const v of confirmedPasses) out.push(`- ${v.claim.statement} (confirmed by ${v.verifierId})`);
		out.push("");
	}

	out.push(`## Not confirmed (${unconfirmed.length})`, "");
	if (unconfirmed.length === 0) out.push("None.", "");
	for (const v of unconfirmed) {
		const strength = (byId.get(v.missionId)?.envelope as Envelope | null)?.test_strength;
		out.push(`- [${v.claim.type}, ${v.status}] ${v.claim.statement}${v.note ? ` — ${v.note}` : ""}${strength ? ` (test strength: ${strength})` : ""}`);
	}
	if (unconfirmed.length) out.push("");

	if (observations.length > 0) {
		out.push("## Observations", "");
		for (const { m, c } of observations) out.push(`- (${m.role} ${m.id}) ${c.statement}`);
		out.push("");
	}

	const deviations = missions.flatMap((m) => ((m.envelope as Envelope | null)?.deviations ?? []).map((d) => ({ m, d })));
	if (deviations.length > 0) {
		out.push("## Deviations", "");
		for (const { m, d } of deviations) out.push(`- (${m.id} @ ${d.at}) expected "${d.expected}", observed "${d.observed}"${d.agent_hypothesis ? ` — hypothesis: ${d.agent_hypothesis}` : ""}`);
		out.push("");
	}

	out.push("## Assumptions", "");
	out.push(...((ir.assumptions ?? []).length ? (ir.assumptions as string[]).map((a) => `- ${a}`) : ["- None recorded."]), "");

	const notCovered = [
		...missions.flatMap((m) => ((m.envelope as Envelope | null)?.goal_coverage ?? []).filter((g) => g.status !== "covered").map((g) => `${g.goal} (${g.status})`)),
		...(input.uncoveredTargets ?? []),
		...missions.filter((m) => !["completed"].includes(m.status)).map((m) => `${m.role} ${m.id} ended ${m.status}${m.error ? `: ${m.error}` : ""}`),
	];
	out.push("## Not covered", "");
	out.push(...(notCovered.length ? notCovered.map((n) => `- ${n}`) : ["- Nothing outstanding."]), "");

	out.push("## Isolation level", "", input.isolation, "");

	let total: Cost = { ...EMPTY_COST };
	out.push("## Missions and cost", "", "| Mission | Role | Status | Risk | Cost |", "|---|---|---|---|---|");
	for (const m of missions) {
		total = addCost(total, m.cost);
		out.push(`| ${m.id} | ${m.role} | ${m.status} | ${m.riskTier} | ${fmtCost(m.cost)} |`);
	}
	out.push(`| **Total** | | | | ${fmtCost(total)} |`, "");
	if (input.notes?.trim()) out.push("## Notes", "", input.notes.trim(), "");

	mkdirSync(paths.reportsDir, { recursive: true });
	const path = join(paths.reportsDir, `${intent.id}.md`);
	const markdown = out.join("\n");
	writeFileSync(path, markdown, "utf8");
	return { path, markdown, confirmedDefects: confirmedDefects.length, confirmedPasses: confirmedPasses.length, unconfirmed: unconfirmed.length, cost: total };
}
