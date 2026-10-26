/**
 * Result envelope (agent-core §5.3) and the deterministic rules that tie claims to `test_run`
 * verdicts (plan §3 "判决可执行化"): a pass or defect claim must cite a finished test_run of the
 * same mission whose verdict supports it.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { FingerprintEntrySchema } from "../knowledge/schema.ts";
import type { TestRunRow } from "../store/repos.ts";
import type { Verdict } from "../types.ts";

export const CLAIM_TYPES = ["defect", "pass", "coverage", "observation"] as const;
export const ENVELOPE_STATUSES = ["completed", "partial", "blocked", "failed"] as const;

export const ClaimSchema = Type.Object({
	id: Type.String({ description: "Short id, unique within the envelope, e.g. c1" }),
	type: StringEnum(CLAIM_TYPES),
	statement: Type.String({ description: "What is claimed, one sentence" }),
	test_run_ids: Type.Optional(
		Type.Array(Type.String(), { description: "test_run ids backing this claim; required for defect and pass claims" }),
	),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence refs (ev://<sha256>) or run-directory paths" })),
	oracle: Type.Optional(Type.Object({ kind: Type.String(), strength: StringEnum(["low", "medium", "high"] as const) })),
	reproducibility: Type.Optional(Type.String({ description: "e.g. 5/5" })),
	minimal_repro: Type.Optional(Type.String({ description: "Smallest command or steps that reproduce the defect" })),
});

export const EnvelopeSchema = Type.Object({
	status: StringEnum(ENVELOPE_STATUSES),
	summary: Type.String({ description: "Two or three sentences on what was done and found" }),
	claims: Type.Array(ClaimSchema),
	goal_coverage: Type.Optional(
		Type.Array(Type.Object({ goal: Type.String(), status: StringEnum(["covered", "partial", "not_covered"] as const) })),
	),
	deviations: Type.Optional(
		Type.Array(
			Type.Object({
				at: Type.String(),
				expected: Type.String(),
				observed: Type.String(),
				agent_hypothesis: Type.Optional(Type.String()),
			}),
		),
	),
	capability_issues: Type.Optional(Type.Array(Type.String())),
	test_strength: Type.Optional(Type.String({ description: "How hard the target was exercised (e.g. 50 concurrent orders x 5 runs)" })),
	verification: Type.Optional(
		Type.Array(
			Type.Object({
				claim_id: Type.String({ description: "Id of the claim under verification" }),
				test_run_ids: Type.Array(Type.String()),
				note: Type.Optional(Type.String()),
			}),
			{ description: "Verifier only: which of your own test_runs re-checked each claim" },
		),
	),
	fingerprint: Type.Optional(
		Type.Array(FingerprintEntrySchema, { description: "Scout: situation fingerprint, using the facet names listed in your mission" }),
	),
	integrity_issues: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Verifier only, and only when you found one: a test that cannot fail, skips its own assertions, or takes expected values from the SUT's current output. Each entry voids the executor's feedback. Omit the field (or leave it empty) when there are none; put caveats and minor notes in claims or deviations instead.",
		}),
	),
	oracle_checks: Type.Optional(
		Type.Array(
			Type.Object({
				kind: StringEnum(["sensitivity", "specificity"] as const, {
					description: "sensitivity: the oracle run against a seeded fault must fail; specificity: clean reruns must all pass",
				}),
				test_run_ids: Type.Array(Type.String()),
			}),
			{ description: "Verifier: oracle self-checks (agent-core §7.1)" },
		),
	),
	used_templates: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), role: StringEnum(["applied", "cited"] as const) }), {
			description: "Templates you followed (applied) or borrowed from (cited)",
		}),
	),
	self_assessment: Type.Optional(Type.String({ description: "For reference only; not used in scoring" })),
});

export type Claim = Static<typeof ClaimSchema>;
export type Envelope = Static<typeof EnvelopeSchema>;

/** The verdict a claim needs from its test runs. */
export function expectedVerdict(claimType: string): Verdict | undefined {
	return claimType === "defect" ? "fail" : claimType === "pass" ? "pass" : undefined;
}

export function validateClaimsAgainstRuns(claims: readonly Claim[], runs: readonly TestRunRow[], missionId: string): string[] {
	const byId = new Map(runs.map((r) => [r.id, r]));
	const errors: string[] = [];
	const ids = new Set<string>();
	for (const c of claims) {
		if (ids.has(c.id)) errors.push(`claim id ${c.id} is used twice`);
		ids.add(c.id);
		const need = expectedVerdict(c.type);
		if (!need) continue;
		const cited = c.test_run_ids ?? [];
		if (cited.length === 0) {
			errors.push(`${c.type} claim ${c.id} cites no test_run; pass/fail verdicts come only from test_run`);
			continue;
		}
		for (const id of cited) {
			const run = byId.get(id);
			if (!run || run.missionId !== missionId) errors.push(`claim ${c.id} cites unknown test_run ${id}`);
		}
		const supporting = cited.map((id) => byId.get(id)).filter((r) => r && r.verdict === need);
		if (supporting.length === 0) {
			errors.push(`${c.type} claim ${c.id} needs at least one cited test_run with verdict "${need}"`);
		}
	}
	return errors;
}

export type VerificationResult = "confirmed" | "refuted" | "inconclusive";

/** Evidence contract default (agent-core §7.5: `reproducibility pass >= 0.6`). */
export const MIN_REPRODUCIBILITY = 0.6;

/**
 * Deterministic verification of one executor claim from the verifier's own test runs:
 * confirmed when at least 60% of the decided runs reproduce the expected verdict (race-dependent
 * defects do not reproduce every time), refuted when none does, inconclusive in between.
 */
export function verifyClaim(claimType: string, verifierRuns: readonly TestRunRow[]): VerificationResult {
	const need = expectedVerdict(claimType);
	if (!need) return "inconclusive";
	const decided = verifierRuns.filter((r) => r.verdict === "pass" || r.verdict === "fail");
	const agree = decided.filter((r) => r.verdict === need).length;
	if (agree > 0 && agree / decided.length >= MIN_REPRODUCIBILITY) return "confirmed";
	if (agree === 0 && decided.length > 0) return "refuted";
	return "inconclusive";
}
