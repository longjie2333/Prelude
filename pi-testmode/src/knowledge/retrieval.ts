/**
 * Template retrieval (agent-core §8.6, plan M2-4): recall by text, facets, and graph
 * neighbourhood; judge deterministically; keep the most specific of an inheritance chain;
 * rank; return at most 3 cards and a hit level H0–H3. Relevance only recalls — the judge decides.
 */
import type { Store } from "../store/db.ts";
import { type Judgement, judge, type Tri } from "./applicability.ts";
import type { Fingerprint } from "./schema.ts";
import { templateLowerBound } from "../learning/stats.ts";
import { edges, facetRecall, listTemplates, type TemplateRecord, textRecall } from "./store.ts";

export type HitLevel = "H0" | "H1" | "H2" | "H3";

export interface Card {
	id: string;
	version: number;
	type: string;
	status: string;
	layer: string;
	title: string;
	summary: string;
	applicability: Tri;
	exception?: string;
	probes?: string[];
	score: number;
}

export interface Candidate {
	template: TemplateRecord;
	judgement: Judgement;
	textHits: number;
	/** Posterior lower bound × soft match (plan M3-4). */
	utility: number;
}

export interface SearchResult {
	hitLevel: HitLevel;
	cards: Card[];
	candidates: Candidate[];
}

const STATUS_RANK: Record<string, number> = { stable: 3, candidate: 2, draft: 1 };
const RESULT_RANK: Record<Tri, number> = { true: 2, unknown: 1, false: 0 };
export const MAX_CARDS = 3;

function toCard(c: Candidate): Card {
	const t = c.template;
	return {
		id: t.id,
		version: t.version,
		type: t.type,
		status: t.status,
		layer: t.layer,
		title: t.spec.card.title,
		summary: t.spec.card.summary,
		applicability: c.judgement.result,
		exception: c.judgement.exception?.id,
		probes: c.judgement.probes.length ? c.judgement.probes.map((p) => p.facet) : undefined,
		score: Math.round(c.judgement.score * 100) / 100,
	};
}

/** Intent relevance gates ranking: a template recalled only through a shared facet ranks below relevant ones. */
const relevant = (c: Candidate) => (c.textHits > 0 ? 1 : 0);

export function rank(a: Candidate, b: Candidate): number {
	const strategy = (c: Candidate) => (c.template.type === "strategy" ? 1 : 0);
	return (
		relevant(b) - relevant(a) ||
		strategy(b) - strategy(a) ||
		RESULT_RANK[b.judgement.result] - RESULT_RANK[a.judgement.result] ||
		(STATUS_RANK[b.template.status] ?? 0) - (STATUS_RANK[a.template.status] ?? 0) ||
		b.utility - a.utility ||
		(b.template.layer === "project" ? 1 : 0) - (a.template.layer === "project" ? 1 : 0) ||
		b.textHits - a.textHits
	);
}

export function hitLevel(ranked: readonly Candidate[], relatedStrategy: boolean): HitLevel {
	// Only an intent-relevant strategy can set the hit level; facet overlap alone says nothing about the goal.
	const top = ranked.find((c) => c.template.type === "strategy" && relevant(c));
	if (top) {
		const j = top.judgement;
		if (j.result === "true" && top.template.status === "stable" && !j.exception && j.unknown.length === 0 && j.score >= 0.6) return "H3";
		if (j.result === "true" || j.probes.length > 0) return "H2";
		return "H1";
	}
	return relatedStrategy ? "H1" : "H0";
}

export function searchTemplates(s: Store, query: string, fp: Fingerprint): SearchResult {
	const text = textRecall(s, query);
	const recalled = new Set<string>([...text.keys(), ...facetRecall(s, fp)]);
	for (const id of [...recalled]) {
		for (const e of edges(s, { src: id })) if (e.kind === "specializes" || e.kind === "composes") recalled.add(e.dst);
		for (const e of edges(s, { dst: id })) if (e.kind === "specializes") recalled.add(e.src);
	}
	const templates = listTemplates(s, { ids: [...recalled] }).filter((t) => t.status !== "deprecated" && t.status !== "retired");

	const overridden = new Set(edges(s, { kind: "overrides" }).filter((e) => recalled.has(e.src)).map((e) => e.dst));
	const judged: Candidate[] = templates
		.filter((t) => !overridden.has(t.id))
		.map((t) => {
			const judgement = judge(t.spec.applicability, fp);
			return { template: t, judgement, textHits: text.get(t.id) ?? 0, utility: templateLowerBound(s, t.id) * judgement.score };
		});

	// A strategy that text recall found but the judge rejected still signals an analogous hit.
	const relatedStrategy = judged.some((c) => c.template.type === "strategy" && c.textHits > 0);
	let viable = judged.filter((c) => c.judgement.result !== "false");

	// Most specific first: drop a template when one of its viable descendants is present.
	const viableIds = new Set(viable.map((c) => c.template.id));
	const general = new Set(edges(s, { kind: "specializes" }).filter((e) => viableIds.has(e.src)).map((e) => e.dst));
	viable = viable.filter((c) => !general.has(c.template.id));

	// Templates recalled only through a facet they do not constrain are noise.
	viable = viable.filter((c) => c.textHits > 0 || c.template.spec.applicability.hard.length > 0 || c.judgement.score > 0.5);

	viable.sort(rank);
	return { hitLevel: hitLevel(viable, relatedStrategy), cards: viable.slice(0, MAX_CARDS).map(toCard), candidates: viable };
}

export function renderCards(r: SearchResult): string {
	const lines = r.cards.map((c, i) => {
		const flags = [c.type, c.status, c.applicability === "true" ? "applicable" : "applicability unknown"];
		if (c.exception) flags.push(`exception ${c.exception}`);
		const probes = c.probes ? `\n   probe first: ${c.probes.join(", ")}` : "";
		return `${i + 1}. ${c.id}@${c.version} [${flags.join(", ")}] ${c.title} — ${c.summary}${probes}`;
	});
	return lines.join("\n") || "(no applicable templates)";
}
