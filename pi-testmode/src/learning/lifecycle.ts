/**
 * Template state machine and escape hatches (agent-core §10.8, plan M3-7):
 *   draft → candidate     reused successfully at least once outside the intent it came from
 *   candidate → stable    ≥3 cornerstones over ≥2 clusters, posterior lower bound ≥ θ, no open K hypothesis
 *   candidate → retired   ≥5 credited uses and posterior mean < 0.3
 *   stable → deprecated   escape hatch: >8 exceptions, known region < ½ of its peak, or the
 *                          in-domain failure rate's lower bound above 0.5 (content review)
 */
import { activeOnly } from "../knowledge/fingerprint.ts";
import { judge } from "../knowledge/applicability.ts";
import { edges, getTemplate, listCornerstones, listEpisodes, setTemplateStatus } from "../knowledge/store.ts";
import type { TemplateStatus } from "../knowledge/schema.ts";
import type { Store } from "../store/db.ts";
import { audit } from "../store/repos.ts";
import { listDeltas } from "./gate.ts";
import { aggregate, clusterKey, getStats, lowerBound, posteriorMean } from "./stats.ts";

export const STABLE_THETA = 0.55;
export const MAX_EXCEPTIONS = 8;

export interface Transition {
	from: TemplateStatus;
	to: TemplateStatus;
	reason: string;
}

function positiveUses(s: Store, templateId: string): Array<{ episodeId: string; intentId: string }> {
	return s
		.all<{ episode_id: string; intent_id: string }>(
			`SELECT u.episode_id, e.intent_id FROM template_uses u JOIN episodes e ON e.id = u.episode_id
			 JOIN feedback f ON f.episode_id = u.episode_id
			 WHERE u.template_id = $t AND u.role IN ('applied', 'cited') AND f.triage_class IN ('S', 'V') AND f.credibility >= 0.5`,
			{ $t: templateId },
		)
		.map((r) => ({ episodeId: r.episode_id, intentId: r.intent_id }));
}

/** How many archived cornerstones the current spec still accepts (the known applicable region). */
function knownRegion(s: Store, templateId: string): { now: number; peak: number } {
	const t = getTemplate(s, templateId);
	if (!t) return { now: 0, peak: 0 };
	const cs = listCornerstones(s, templateId).filter((c) => c.exceptionId === null);
	const now = cs.filter((c) => judge(t.spec.applicability, activeOnly(s, c.fingerprint)).result === "true").length;
	return { now, peak: cs.length };
}

export function nextStatus(s: Store, templateId: string): Transition | undefined {
	const t = getTemplate(s, templateId);
	if (!t || t.seed) return undefined; // seeds evolve through project overrides
	const rows = getStats(s, templateId);
	const { alpha, beta } = aggregate(rows);
	const lb = lowerBound(alpha, beta);
	const origin = edges(s, { src: templateId, kind: "derived_from" })
		.find((e) => e.dst.startsWith("intent:"))
		?.dst.slice("intent:".length);

	if (t.status === "draft") {
		const reuse = positiveUses(s, templateId).filter((u) => u.intentId !== origin);
		if (reuse.length >= 1)
			return { from: "draft", to: "candidate", reason: `reused successfully in ${reuse.length} other intent(s)` };
		return undefined;
	}
	if (t.status === "candidate") {
		const cs = listCornerstones(s, templateId).filter((c) => c.exceptionId === null);
		const clusters = new Set(cs.map((c) => clusterKey(t.spec, activeOnly(s, c.fingerprint))));
		const openK = listDeltas(s, { target: templateId, status: "suspended" }).some((d) => d.op === "revise");
		if (cs.length >= 3 && clusters.size >= 2 && lb >= STABLE_THETA && !openK) {
			return {
				from: "candidate",
				to: "stable",
				reason: `${cs.length} cornerstones over ${clusters.size} clusters, lower bound ${lb.toFixed(2)}`,
			};
		}
		const uses = alpha + beta - 2;
		if (uses >= 5 && posteriorMean(alpha, beta) < 0.3)
			return {
				from: "candidate",
				to: "retired",
				reason: `posterior mean ${posteriorMean(alpha, beta).toFixed(2)} over ${uses} uses`,
			};
		return undefined;
	}
	if (t.status === "stable") {
		if (t.spec.applicability.exceptions.length > MAX_EXCEPTIONS)
			return {
				from: "stable",
				to: "deprecated",
				reason: `escape hatch: ${t.spec.applicability.exceptions.length} exceptions`,
			};
		const region = knownRegion(s, templateId);
		if (region.peak >= 4 && region.now < region.peak / 2)
			return { from: "stable", to: "deprecated", reason: `escape hatch: known region ${region.now}/${region.peak}` };
		const failLb = lowerBound(beta, alpha);
		if (failLb > 0.5)
			return {
				from: "stable",
				to: "deprecated",
				reason: `escape hatch: failure rate lower bound ${failLb.toFixed(2)}`,
			};
	}
	return undefined;
}

export function applyLifecycle(s: Store, templateId: string): Transition | undefined {
	const tr = nextStatus(s, templateId);
	if (!tr) return undefined;
	s.tx(() => {
		setTemplateStatus(s, templateId, tr.to);
		audit(s, {
			actor: "main",
			event: "template_status",
			decision: tr.to,
			reason: `${templateId}: ${tr.from} → ${tr.to} (${tr.reason})`,
		});
	});
	return tr;
}

/** Episodes credited to a template (for /test-why). */
export function creditedEpisodes(s: Store, templateId: string): string[] {
	return listEpisodes(s, {})
		.filter((e) => e.plan.templates.some((x) => x.id === templateId))
		.map((e) => e.id);
}
