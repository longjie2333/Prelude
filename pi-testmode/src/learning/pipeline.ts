/**
 * L3 learning pipeline (agent-core §10.1, plan M3): after an intent closes, for each executor
 * episode: evaluate → triage → credit (one transaction, keyed by episode_id) → hypotheses and
 * deltas through the gate → state machine. Runs in the background, serialized.
 *
 * "Better not to learn than to learn wrong": low credibility updates nothing; B never touches the
 * template's in-domain β; U and K become suspended hypotheses, not edits.
 */
import { activeOnly } from "../knowledge/fingerprint.ts";
import {
	activateFacet,
	getEpisodeByMission,
	getProvider,
	getTemplate,
	insertCornerstone,
	listCornerstones,
	listFacets,
	listTemplateUses,
	proposeFacet,
	setProviderTrust,
} from "../knowledge/store.ts";
import type { Envelope } from "../missions/envelope.ts";
import type { Store } from "../store/db.ts";
import { audit, getIntent, listMissions } from "../store/repos.ts";
import { newId, nowIso } from "../util.ts";
import { type Complete, proposeFacetHypothesis } from "./attributor.ts";
import { evaluateMission } from "./evaluator.ts";
import { hypothesisKey, listDeltas, proposeDelta, THRESHOLDS } from "./gate.ts";
import { applyLifecycle } from "./lifecycle.ts";
import { bumpException, bumpStats, clusterKey } from "./stats.ts";
import { resolveUnexplained, type Triage, triage } from "./triage.ts";

export const MIN_CREDIBILITY = 0.5;
export const MAX_CORNERSTONES_PER_CLUSTER = 5;
export const FACET_ACTIVATION_CONF = 0.7;

export interface LearnerDeps {
	store: Store;
	/** Single LLM call for the attributor; undefined when no model is available (abstain). */
	complete?: () => Promise<Complete | undefined>;
	/** Starts a curator that turns an accumulated hypothesis into a gated delta. */
	dispatchDeltaCurator(deltaId: string): void;
	/** Calibration drift pauses automatic learning (M3-9). */
	paused(): boolean;
}

export interface LearnResult {
	intentId: string;
	episodes: Array<{ episodeId: string; klass: string; credibility: number; reason: string }>;
	transitions: string[];
	skipped?: string;
}

export class Learner {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly deps: LearnerDeps;

	constructor(deps: LearnerDeps) {
		this.deps = deps;
	}

	enqueue(intentId: string): Promise<LearnResult> {
		const run = this.queue.then(() => this.learnIntent(intentId));
		this.queue = run.catch((err) => {
			try {
				audit(this.deps.store, {
					actor: "main",
					event: "learning_failed",
					reason: `${intentId}: ${(err as Error).message}`,
				});
			} catch {
				// store closed
			}
		});
		return run;
	}

	idle(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	async learnIntent(intentId: string): Promise<LearnResult> {
		const s = this.deps.store;
		const result: LearnResult = { intentId, episodes: [], transitions: [] };
		const intent = getIntent(s, intentId);
		if (!intent) return { ...result, skipped: "unknown intent" };
		if (s.get("SELECT 1 FROM intents WHERE id = $i AND learned_at IS NOT NULL", { $i: intentId }))
			return { ...result, skipped: "already learned" };
		if (this.deps.paused()) {
			audit(s, { actor: "main", event: "learning_paused", reason: `${intentId}: calibration drift` });
			return { ...result, skipped: "paused by calibration drift" };
		}
		this.activateFacets();
		const touched = new Set<string>();

		for (const m of listMissions(s, { intentId }).filter((x) => x.role === "executor")) {
			const episode = getEpisodeByMission(s, m.id);
			if (!episode || s.get("SELECT 1 FROM feedback WHERE episode_id = $e", { $e: episode.id })) continue;
			const evaluation = evaluateMission(s, m.id);
			if (!evaluation) continue;
			const uses = listTemplateUses(s, { episodeId: episode.id }).filter(
				(u) => u.role === "applied" || u.role === "cited",
			);
			const strategy = uses
				.map((u) => getTemplate(s, u.templateId))
				.find((t) => t?.type === "strategy" && uses.some((u) => u.templateId === t.id && u.role === "applied"));
			let t: Triage = triage(s, { episode, evaluation, strategyId: strategy?.id });
			if (t.needsHypothesis && strategy)
				t = resolveUnexplained(t, await this.hypothesize(episode.id, strategy.id, m.envelope as Envelope | null));
			else if (t.needsHypothesis) t = resolveUnexplained(t, undefined);
			const firedException = (m.spec.templates ?? []).find((x) => x.id === strategy?.id)?.exceptionId;

			s.tx(() => {
				s.run(
					`INSERT INTO feedback (id, episode_id, signals_json, credibility, triage_class, attribution_json, created_at) VALUES ($id, $e, $sig, $c, $k, $a, $ts)`,
					{
						$id: newId("fb"),
						$e: episode.id,
						$sig: JSON.stringify(evaluation.signals),
						$c: evaluation.credibility,
						$k: t.klass,
						$a: JSON.stringify({
							reason: t.reason,
							contrast: t.contrast,
							hypothesis: t.hypothesis,
							unknown: t.unknownFacets,
							cheating: evaluation.cheating,
							firstDeviation: t.firstDeviation,
						}),
						$ts: nowIso(),
					},
				);
				if (evaluation.cheating.length) {
					// Cheating voids the feedback and counts against the executor's method (meta template).
					bumpStats(s, "meta:executor", "default", 0, 1);
					audit(s, {
						actor: "main",
						event: "cheating_detected",
						reason: `${episode.id}: ${evaluation.cheating.join("; ")}`,
					});
				}
				if (evaluation.credibility < MIN_CREDIBILITY) return;
				const w = evaluation.credibility;
				const fp = activeOnly(s, episode.fingerprint);
				for (const u of uses) {
					const tpl = getTemplate(s, u.templateId);
					if (!tpl) continue;
					const key = clusterKey(tpl.spec, fp);
					if (t.klass === "S" || t.klass === "V") {
						bumpStats(s, tpl.id, key, w, 0);
						touched.add(tpl.id);
					} else if (t.klass === "K" && tpl.id === strategy?.id) {
						bumpStats(s, tpl.id, key, 0, w);
						touched.add(tpl.id);
					}
					// B: no in-domain β (agent-core §10.6 #5) — the exception hypothesis gets the evidence below.
				}
				if ((t.klass === "S" || t.klass === "V") && strategy) {
					if (firedException) bumpException(s, strategy.id, firedException, w);
					const key = clusterKey(strategy.spec, fp);
					const same = listCornerstones(s, strategy.id).filter(
						(c) =>
							c.exceptionId === (firedException ?? null) &&
							clusterKey(strategy.spec, activeOnly(s, c.fingerprint)) === key,
					);
					if (same.length < MAX_CORNERSTONES_PER_CLUSTER)
						insertCornerstone(s, {
							templateId: strategy.id,
							exceptionId: firedException ?? null,
							episodeId: episode.id,
							fingerprint: episode.fingerprint,
						});
				}
				if (t.klass === "C") {
					for (const b of m.spec.bindings ?? []) {
						const p = getProvider(s, b.sha256);
						if (p && p.trust === "verified")
							setProviderTrust(s, b.sha256, "candidate", Math.max(0, (p.conformanceScore ?? 1) - 0.25));
					}
				}
			});
			result.episodes.push({
				episodeId: episode.id,
				klass: t.klass,
				credibility: evaluation.credibility,
				reason: t.reason,
			});
			if (evaluation.credibility >= MIN_CREDIBILITY && strategy)
				this.hypotheses(t, strategy.id, episode.id, touched);
		}

		for (const id of touched) {
			const tr = applyLifecycle(s, id);
			if (tr) result.transitions.push(`${id}: ${tr.from} → ${tr.to}`);
		}
		s.run("UPDATE intents SET learned_at = $ts WHERE id = $i", { $i: intentId, $ts: nowIso() });
		audit(s, {
			actor: "main",
			event: "learned",
			reason: `${intentId}: ${result.episodes.map((e) => `${e.episodeId}=${e.klass}`).join(", ") || "no executor episodes"}`,
		});
		return result;
	}

	/** B → except hypothesis; U with a new facet → facet.propose; K → revise hypothesis. */
	private hypotheses(t: Triage, strategyId: string, episodeId: string, touched: Set<string>): void {
		const s = this.deps.store;
		const base = getTemplate(s, strategyId);
		if (!base) return;
		if (t.klass === "B" && t.contrast) {
			const when = t.contrast.facets.map((f) =>
				f.values.length === 1
					? { facet: f.facet, op: "eq" as const, value: f.values[0] }
					: { facet: f.facet, op: "in" as const, values: f.values },
			);
			// Placeholder action until the curator decides it; the kernel fixes the condition.
			const payload = {
				exception: {
					id: `ex-${when
						.map((w) => `${w.facet}-${w.value ?? w.values?.join("-")}`)
						.join("-")
						.replace(/[^a-z0-9-]+/gi, "-")
						.toLowerCase()}`,
					when,
					action: "exclude" as const,
					because: "pending curator",
					source: "experience" as const,
				},
			};
			this.accumulate(
				{ op: "except", target: strategyId, payload },
				episodeId,
				base.status === "stable" ? THRESHOLDS.boundary + THRESHOLDS.stableExtra : THRESHOLDS.boundary,
			);
			touched.add(strategyId);
		}
		if (t.klass === "U" && t.hypothesis) {
			const values = [...new Set([t.hypothesis.failureValue, t.hypothesis.cornerstoneValue])];
			// The facet enters the vocabulary as proposed; a hypothesis is not an observation (no conf).
			proposeFacet(s, t.hypothesis.facet, values, { hypothesis: episodeId });
			const payload = {
				facet: t.hypothesis.facet,
				values,
				failure_value: t.hypothesis.failureValue,
				cornerstone_value: t.hypothesis.cornerstoneValue,
			};
			this.accumulate({ op: "facet.propose", target: strategyId, payload }, episodeId, Number.POSITIVE_INFINITY);
		}
		if (t.klass === "K") {
			const payload = {
				path: "slots.oracle.text",
				value: base.spec.slots.oracle?.text ?? "",
				reason: "pending curator",
			};
			this.accumulate(
				{ op: "revise", target: strategyId, payload },
				episodeId,
				THRESHOLDS.content + (base.status === "stable" ? THRESHOLDS.stableExtra : 0),
			);
		}
	}

	/** Adds evidence to the suspended hypothesis; at the threshold a curator turns it into a delta. */
	private accumulate(
		p: { op: "except" | "facet.propose" | "revise"; target: string; payload: Record<string, unknown> },
		episodeId: string,
		threshold: number,
	): void {
		const s = this.deps.store;
		const key = hypothesisKey(p);
		const open = listDeltas(s, { hypothesisKey: key }).find(
			(d) => d.status === "suspended" || d.status === "pending",
		);
		const evidence = [...new Set([...(open?.evidence ?? []), episodeId])];
		if (open)
			s.run("UPDATE deltas SET evidence_json = $e, decided_at = $ts WHERE id = $id", {
				$id: open.id,
				$e: JSON.stringify(evidence),
				$ts: nowIso(),
			});
		let id = open?.id;
		if (!open) {
			id = newId("d");
			s.run(
				`INSERT INTO deltas (id, op, target, target_version, hypothesis_key, payload_json, evidence_json, status, proposed_by, created_at)
				 VALUES ($id, $op, $t, NULL, $k, $p, $e, 'suspended', 'learner', $ts)`,
				{
					$id: id,
					$op: p.op,
					$t: p.target,
					$k: key,
					$p: JSON.stringify(p.payload),
					$e: JSON.stringify(evidence),
					$ts: nowIso(),
				},
			);
		}
		audit(s, {
			actor: "main",
			event: "hypothesis",
			decision: "suspended",
			reason: `${id} ${p.op} ${p.target}: evidence ${evidence.length}/${Number.isFinite(threshold) ? threshold : "probe"}`,
		});
		if (evidence.length >= threshold && id) this.deps.dispatchDeltaCurator(id);
	}

	private async hypothesize(
		episodeId: string,
		strategyId: string,
		env: Envelope | null,
	): Promise<Triage["hypothesis"] | undefined> {
		const s = this.deps.store;
		const ep = s.get<{ fingerprint_json: string }>("SELECT fingerprint_json FROM episodes WHERE id = $e", {
			$e: episodeId,
		});
		if (!ep) return undefined;
		const complete = await this.deps.complete?.();
		if (!complete) return undefined;
		const r = await proposeFacetHypothesis(complete, {
			failure: JSON.parse(ep.fingerprint_json),
			cornerstones: listCornerstones(s, strategyId)
				.filter((c) => c.exceptionId === null)
				.map((c) => c.fingerprint),
			deviations: (env?.deviations ?? []).map(
				(d) =>
					`@${d.at}: expected ${d.expected}; observed ${d.observed}${d.agent_hypothesis ? ` (${d.agent_hypothesis})` : ""}`,
			),
			knownFacets: listFacets(s, "active").map((f) => f.name),
		});
		audit(s, {
			actor: "main",
			event: "attribution",
			decision: r.hypothesis ? "hypothesis" : "abstain",
			reason: `${episodeId}: ${r.judges.map((j) => j?.facet ?? "none").join(" vs ")}`,
		});
		return r.hypothesis;
	}

	/**
	 * A proposed facet becomes active once it has a high-confidence observation, at least two
	 * distinct values, and a reason to exist (a hypothesis or a probe asked for it).
	 */
	activateFacets(): string[] {
		const s = this.deps.store;
		const activated: string[] = [];
		const hypothesised = new Set(
			listDeltas(s, { status: "suspended" })
				.filter((d) => d.op === "facet.propose")
				.map((d) => (d.payload as { facet: string }).facet),
		);
		for (const f of listFacets(s, "proposed")) {
			if (!hypothesised.has(f.name)) continue;
			const obs = (f.evidence as Array<{ values?: string[]; conf?: number }>).filter(
				(e) => typeof e.conf === "number" && Array.isArray(e.values),
			);
			const values = new Set(obs.flatMap((e) => e.values as string[]));
			if (!obs.some((e) => (e.conf as number) >= FACET_ACTIVATION_CONF) || values.size < 2) continue;
			s.tx(() => {
				activateFacet(s, f.name);
				for (const d of listDeltas(s, { status: "suspended" }).filter(
					(x) => x.op === "facet.propose" && (x.payload as { facet: string }).facet === f.name,
				)) {
					s.run("UPDATE deltas SET status = 'committed', decided_at = $ts WHERE id = $id", {
						$id: d.id,
						$ts: nowIso(),
					});
				}
				audit(s, {
					actor: "main",
					event: "facet_activated",
					reason: `${f.name}: values ${[...values].join(", ")} from ${obs.length} observation(s)`,
				});
			});
			activated.push(f.name);
		}
		return activated;
	}
}

/**
 * Facets a dispatch asks the mission to observe afresh: open facet hypotheses on its templates and
 * the facets of open exception hypotheses (the SUT model may be stale on exactly these).
 */
export function probesFor(s: Store, templateIds: readonly string[]): string[] {
	const facets = listDeltas(s, { status: "suspended" })
		.filter((d) => templateIds.includes(d.target))
		.flatMap((d) => {
			if (d.op === "facet.propose") return [(d.payload as { facet: string }).facet];
			if (d.op === "except")
				return ((d.payload as { exception: { when: Array<{ facet: string }> } }).exception.when ?? []).map(
					(w) => w.facet,
				);
			return [];
		});
	return [...new Set(facets)];
}
