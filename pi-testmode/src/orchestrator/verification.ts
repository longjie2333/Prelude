/** Joins executor claims with the verdict of their auto-dispatched verifier (plan M1-10). */
import {
	type Claim,
	type Envelope,
	expectedVerdict,
	type VerificationResult,
	verifyClaim,
} from "../missions/envelope.ts";
import type { Store } from "../store/db.ts";
import { listMissions, listTestRuns, type MissionRow } from "../store/repos.ts";
import { TERMINAL_STATUSES } from "../types.ts";

export type ClaimStatus = VerificationResult | "pending" | "unverified" | "not_applicable";

export interface ClaimView {
	missionId: string;
	claim: Claim;
	status: ClaimStatus;
	verifierId?: string;
	verifierRunIds: string[];
	note?: string;
}

export function verifierOf(store: Store, executorId: string): MissionRow | undefined {
	return listMissions(store, { parentId: executorId }).find((m) => m.role === "verifier");
}

export function needsVerification(m: MissionRow): boolean {
	const env = m.envelope as Envelope | null;
	return m.role === "executor" && !!env && env.claims.some((c) => expectedVerdict(c.type) !== undefined);
}

export function claimViews(store: Store, m: MissionRow): ClaimView[] {
	const env = m.envelope as Envelope | null;
	if (!env) return [];
	const verifier = m.role === "executor" ? verifierOf(store, m.id) : undefined;
	const vEnv = verifier?.envelope as Envelope | null | undefined;
	const vRuns = verifier ? listTestRuns(store, verifier.id) : [];
	return env.claims.map((claim) => {
		if (!expectedVerdict(claim.type) || m.role !== "executor")
			return { missionId: m.id, claim, status: "not_applicable", verifierRunIds: [] };
		if (!verifier)
			return { missionId: m.id, claim, status: "unverified", verifierRunIds: [], note: "no verifier ran" };
		if (!TERMINAL_STATUSES.includes(verifier.status) && verifier.status !== "blocked") {
			return { missionId: m.id, claim, status: "pending", verifierId: verifier.id, verifierRunIds: [] };
		}
		const entry = vEnv?.verification?.find((v) => v.claim_id === claim.id);
		const cited = new Set(entry?.test_run_ids ?? []);
		const runs = vRuns.filter((r) => cited.has(r.id));
		const status = runs.length > 0 ? verifyClaim(claim.type, runs) : "inconclusive";
		const note =
			runs.length > 0
				? entry?.note
				: verifier.status === "completed"
					? "verifier cited no test_run for this claim"
					: `verifier ${verifier.status}`;
		return { missionId: m.id, claim, status, verifierId: verifier.id, verifierRunIds: runs.map((r) => r.id), note };
	});
}
