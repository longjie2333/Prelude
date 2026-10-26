/**
 * Credit statistics (agent-core §10.6, plan M3-4): Beta(α, β) per template per situation
 * cluster. A cluster is the fingerprint projected onto the facets the template conditions on plus
 * a fixed set of clustering facets. Exception support is kept in the same table under
 * `exception:<id>` keys and never mixes into the template's in-domain statistics.
 */
import type { Fingerprint, TemplateSpec } from "../knowledge/schema.ts";
import type { Store } from "../store/db.ts";
import { nowIso } from "../util.ts";

/** Facets that split statistics even when no condition mentions them (agent-core §6.4 "情境簇"). */
export const CLUSTER_FACETS = ["sut.kind", "sut.stack", "state.resource_kind", "consistency.model"] as const;
export const PRIOR = { alpha: 1, beta: 1 } as const;
export const EXCEPTION_PREFIX = "exception:";
/** One-sided z for the posterior lower bound (≈95%). */
const Z = 1.645;

export function clusterFacets(spec: TemplateSpec): string[] {
	const a = spec.applicability;
	const facets = new Set<string>(CLUSTER_FACETS);
	for (const p of a.hard) facets.add(p.facet);
	for (const s of a.soft) facets.add(s.when.facet);
	for (const e of a.exceptions) for (const p of e.when) facets.add(p.facet);
	return [...facets].sort();
}

export function clusterKey(spec: TemplateSpec, fp: Fingerprint): string {
	return (
		clusterFacets(spec)
			.filter((f) => fp[f])
			.map((f) => `${f}=${[...fp[f].values].sort().join("+")}`)
			.join("|") || "default"
	);
}

export interface StatRow {
	templateId: string;
	clusterKey: string;
	alpha: number;
	beta: number;
}

export function getStats(s: Store, templateId: string): StatRow[] {
	return s
		.all<Record<string, unknown>>("SELECT * FROM template_stats WHERE template_id = $t ORDER BY cluster_key", {
			$t: templateId,
		})
		.map((r) => ({
			templateId: r.template_id as string,
			clusterKey: r.cluster_key as string,
			alpha: Number(r.alpha),
			beta: Number(r.beta),
		}));
}

export function bumpStats(s: Store, templateId: string, cluster: string, dAlpha: number, dBeta: number): void {
	s.run(
		`INSERT INTO template_stats (template_id, cluster_key, alpha, beta, updated_at) VALUES ($t, $c, $a, $b, $ts)
		 ON CONFLICT(template_id, cluster_key) DO UPDATE SET alpha = alpha + $da, beta = beta + $db, updated_at = $ts`,
		{
			$t: templateId,
			$c: cluster,
			$a: PRIOR.alpha + dAlpha,
			$b: PRIOR.beta + dBeta,
			$da: dAlpha,
			$db: dBeta,
			$ts: nowIso(),
		},
	);
}

/** Support/contradiction of one exception (`B` evidence, or successes under it). */
export function bumpException(
	s: Store,
	templateId: string,
	exceptionId: string,
	support: number,
	contradict = 0,
): void {
	bumpStats(s, templateId, `${EXCEPTION_PREFIX}${exceptionId}`, support, contradict);
}

export function exceptionSupport(
	s: Store,
	templateId: string,
	exceptionId: string,
): { support: number; contradict: number } {
	const r = getStats(s, templateId).find((x) => x.clusterKey === `${EXCEPTION_PREFIX}${exceptionId}`);
	return r ? { support: r.alpha - PRIOR.alpha, contradict: r.beta - PRIOR.beta } : { support: 0, contradict: 0 };
}

/** In-domain posterior over all clusters (exception rows excluded). */
export function aggregate(rows: readonly StatRow[]): { alpha: number; beta: number } {
	const inDomain = rows.filter((r) => !r.clusterKey.startsWith(EXCEPTION_PREFIX));
	return {
		alpha: PRIOR.alpha + inDomain.reduce((x, r) => x + (r.alpha - PRIOR.alpha), 0),
		beta: PRIOR.beta + inDomain.reduce((x, r) => x + (r.beta - PRIOR.beta), 0),
	};
}

export function posteriorMean(a: number, b: number): number {
	return a / (a + b);
}

/** Normal-approximation lower bound of Beta(a, b), clipped to [0, 1]. Deterministic and cheap. */
export function lowerBound(a: number, b: number): number {
	const n = a + b;
	const mean = a / n;
	const sd = Math.sqrt((a * b) / (n * n * (n + 1)));
	return Math.max(0, Math.min(1, mean - Z * sd));
}

/** Retrieval score (plan M3-4: Beta lower bound replaces the posterior mean). */
export function templateLowerBound(s: Store, templateId: string): number {
	const { alpha, beta } = aggregate(getStats(s, templateId));
	return lowerBound(alpha, beta);
}
