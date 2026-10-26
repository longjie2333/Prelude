/**
 * The `feedback` table (plan §6, M3-4): one row per episode, written by the learning pipeline and
 * read by triage, the gate and the template lifecycle. `episode_id` is the pipeline's idempotency key.
 */
import type { Store } from "../store/db.ts";
import { newId, nowIso } from "../util.ts";
import type { TriageClass } from "./triage.ts";

export function insertFeedback(
	s: Store,
	f: { episodeId: string; signals: unknown; credibility: number; triageClass: TriageClass; attribution: unknown },
): void {
	s.run(
		`INSERT INTO feedback (id, episode_id, signals_json, credibility, triage_class, attribution_json, created_at)
		 VALUES ($id, $e, $sig, $c, $k, $a, $ts)`,
		{
			$id: newId("fb"),
			$e: f.episodeId,
			$sig: JSON.stringify(f.signals),
			$c: f.credibility,
			$k: f.triageClass,
			$a: JSON.stringify(f.attribution),
			$ts: nowIso(),
		},
	);
}

export function hasFeedback(s: Store, episodeId: string): boolean {
	return !!s.get("SELECT 1 FROM feedback WHERE episode_id = $e", { $e: episodeId });
}

/** An earlier failure nobody could explain (K or U) that still carried weight. */
export function isUnresolvedFailure(s: Store, episodeId: string): boolean {
	return !!s.get("SELECT 1 FROM feedback WHERE episode_id = $e AND triage_class IN ('K', 'U') AND credibility > 0", {
		$e: episodeId,
	});
}

/** Episodes whose feedback was triaged into one of `classes`. */
export function feedbackEpisodeIds(s: Store, classes: readonly TriageClass[]): string[] {
	const params = Object.fromEntries(classes.map((c, i) => [`$c${i}`, c]));
	return s
		.all<{ episode_id: string }>(
			`SELECT episode_id FROM feedback WHERE triage_class IN (${Object.keys(params).join(", ")})`,
			params,
		)
		.map((r) => r.episode_id);
}

/** Applied or cited uses of a template whose episode was a credible success (S or V, credibility ≥ 0.5). */
export function positiveTemplateUses(s: Store, templateId: string): Array<{ episodeId: string; intentId: string }> {
	return s
		.all<{ episode_id: string; intent_id: string }>(
			`SELECT u.episode_id, e.intent_id FROM template_uses u JOIN episodes e ON e.id = u.episode_id
			 JOIN feedback f ON f.episode_id = u.episode_id
			 WHERE u.template_id = $t AND u.role IN ('applied', 'cited') AND f.triage_class IN ('S', 'V') AND f.credibility >= 0.5`,
			{ $t: templateId },
		)
		.map((r) => ({ episodeId: r.episode_id, intentId: r.intent_id }));
}
