/**
 * Failure triage (agent-core §10.5, plan M3-3), fixed order S → N → E/C → P → B/K, else U.
 * `V` is a valid non-detection (oracle self-checks passed, §10.2). Network/unreachable SUT and
 * voided runs are E — never negative feedback — so network noise is not learned as "not applicable".
 *
 * B vs K uses the contrast set: the failure fingerprint against every cornerstone of the applied
 * strategy, looking for the smallest set of active facets that separates them.
 */
import { activeOnly } from "../knowledge/fingerprint.ts";
import type { Fingerprint } from "../knowledge/schema.ts";
import { getProvider, listCornerstones, listEpisodes, type EpisodeRow } from "../knowledge/store.ts";
import type { Store } from "../store/db.ts";
import { getMission, listAudit, listTestRuns } from "../store/repos.ts";
import type { Evaluation } from "./evaluator.ts";

export type TriageClass = "S" | "V" | "E" | "N" | "J" | "C" | "I" | "P" | "B" | "K" | "U";

export interface Contrast {
	/** Facets (with the failure's values) that separate the failure from every cornerstone. */
	facets: Array<{ facet: string; values: string[] }>;
	cornerstones: number;
}

export interface Triage {
	klass: TriageClass;
	reason: string;
	/** B: the distinguishing condition (a candidate exception). */
	contrast?: Contrast;
	/** U: facets that are unknown on the failure or some cornerstone (worth probing). */
	unknownFacets?: string[];
	/** U: a hypothesised new facet (from the attributor), awaiting probes. */
	hypothesis?: { facet: string; failureValue: string; cornerstoneValue: string };
	/** No existing facet separates the failure: ask the attributor (pipeline), then decide U or K. */
	needsHypothesis?: boolean;
	/** Earlier unresolved failures of the same strategy (for the K decision). */
	priorFailures?: number;
	strategyId?: string;
	firstDeviation?: string;
}

const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|unreachable/i;

function separates(fv: string[], cv: string[] | undefined): boolean | undefined {
	if (!cv) return undefined;
	return fv.every((v) => !cv.includes(v));
}

/** Smallest distinguishing facet set (size 1, then 2) over facets known on both sides. */
export function contrastSet(failure: Fingerprint, cornerstones: readonly Fingerprint[]): { contrast?: Contrast; unknown: string[] } {
	const facets = Object.keys(failure).sort();
	const unknown = new Set<string>();
	const sep = (f: string) =>
		cornerstones.map((c) => {
			const r = separates(failure[f].values, c[f]?.values);
			if (r === undefined) unknown.add(f);
			return r;
		});
	const singles = facets.filter((f) => {
		const r = sep(f);
		return r.length > 0 && r.every((x) => x === true);
	});
	if (singles.length) return { contrast: { facets: singles.slice(0, 1).map((f) => ({ facet: f, values: failure[f].values })), cornerstones: cornerstones.length }, unknown: [...unknown] };
	for (let i = 0; i < facets.length; i++) {
		for (let j = i + 1; j < facets.length; j++) {
			const a = sep(facets[i]);
			const b = sep(facets[j]);
			if (a.length && a.every((x, k) => x === true || b[k] === true)) {
				return {
					contrast: { facets: [facets[i], facets[j]].map((f) => ({ facet: f, values: failure[f].values })), cornerstones: cornerstones.length },
					unknown: [...unknown],
				};
			}
		}
	}
	for (const c of cornerstones) for (const f of Object.keys(c)) if (!failure[f]) unknown.add(f);
	return { unknown: [...unknown] };
}

export interface TriageInput {
	episode: EpisodeRow;
	evaluation: Evaluation;
	/** The applied strategy template, if any (B/K need its cornerstones). */
	strategyId?: string;
}

/** After the attributor: a hypothesis keeps it U (probe first); repeated unexplained failures are K. */
export function resolveUnexplained(t: Triage, hypothesis: Triage["hypothesis"] | undefined): Triage {
	if (!t.needsHypothesis) return t;
	if (hypothesis) return { ...t, needsHypothesis: false, klass: "U", hypothesis, reason: `no known facet separates it; new facet hypothesis ${hypothesis.facet}` };
	if ((t.priorFailures ?? 0) >= 2) return { ...t, needsHypothesis: false, klass: "K", reason: "repeated failures in situations no facet separates from the cornerstones" };
	return { ...t, needsHypothesis: false };
}

export function triage(s: Store, input: TriageInput): Triage {
	const { episode, evaluation } = input;
	const sig = evaluation.signals;
	const base = { strategyId: input.strategyId, firstDeviation: sig.firstDeviation };

	if (sig.verifiedDefects > 0) return { ...base, klass: "S", reason: `${sig.verifiedDefects} defect(s) confirmed by independent replay` };
	if (sig.claimedPasses > 0 && sig.verifiedPasses === sig.claimedPasses && sig.falsePositives === 0) {
		if (sig.oracleSensitivity === "pass" && sig.oracleSpecificity === "pass") return { ...base, klass: "V", reason: "valid non-detection: oracle self-checks passed" };
		return { ...base, klass: "U", reason: "pass without oracle self-checks: an invalid non-detection proves nothing (§10.2)" };
	}
	if (sig.flaky) return { ...base, klass: "N", reason: "verifier replays disagree with each other" };

	const m = getMission(s, episode.missionId);
	const runs = m ? listTestRuns(s, m.id) : [];
	const errorText = [m?.error ?? "", ...runs.filter((r) => r.verdict === "error").map((r) => r.verdictNote ?? "")].join(" ");
	if (sig.voidedRuns > 0 && sig.claimedDefects + sig.claimedPasses === 0) return { ...base, klass: "E", reason: "runs voided by an interruption (no feedback)" };
	if (UNREACHABLE.test(errorText) || m?.interruptReason === "network") return { ...base, klass: "E", reason: "SUT or provider unreachable (environment, not the template)" };
	if (sig.errorRuns > 0 && sig.claimedDefects + sig.claimedPasses === 0) return { ...base, klass: "E", reason: "test runs could not execute" };

	const providerTrouble = (m?.spec.bindings ?? []).some((b) => getProvider(s, b.sha256)?.trust === "quarantined");
	const toolErrors = m ? listAudit(s, { actor: `mission:${m.id}` }).some((a) => a.event === "provider_hash_mismatch") : false;
	if (providerTrouble || toolErrors) return { ...base, klass: "C", reason: "a bound provider failed its contract or changed" };

	if (sig.falsePositives === 0 && sig.refutedPasses === 0) {
		if (sig.capabilityRequests > 0) return { ...base, klass: "P", reason: "capabilities requested outside the template's bindings" };
		if (sig.unconfirmedDefects > 0) return { ...base, klass: "N", reason: "claim not reproduced decisively" };
		return { ...base, klass: "U", reason: "nothing decisive to learn from" };
	}

	// A refuted claim: the template was used where it does not fit (B) or is wrong where it fits (K).
	if (!input.strategyId) return { ...base, klass: "U", reason: "false positive without an applied strategy template" };
	const cornerstones = listCornerstones(s, input.strategyId)
		.filter((c) => c.exceptionId === null)
		.map((c) => activeOnly(s, c.fingerprint));
	const failure = activeOnly(s, episode.fingerprint);
	if (cornerstones.length === 0) return { ...base, klass: "U", reason: "no cornerstones to contrast with" };
	const { contrast, unknown } = contrastSet(failure, cornerstones);
	if (contrast) {
		return { ...base, klass: "B", reason: `separated from all ${contrast.cornerstones} cornerstones by ${contrast.facets.map((f) => `${f.facet}=${f.values.join("|")}`).join(" ∧ ")}`, contrast };
	}
	// Earlier unresolved failures of the same strategy (repeated failures where no facet helps → K).
	const priorFailures = listEpisodes(s, {})
		.filter((e) => e.id !== episode.id && e.plan.templates.some((t) => t.id === input.strategyId))
		.filter((e) => s.get("SELECT 1 FROM feedback WHERE episode_id = $e AND triage_class IN ('K', 'U') AND credibility > 0", { $e: e.id })).length;
	return {
		...base,
		klass: "U",
		reason: unknown.length ? `undecided: ${unknown.join(", ")} unknown` : "no facet separates it from the cornerstones",
		unknownFacets: unknown,
		needsHypothesis: true,
		priorFailures,
	};
}
