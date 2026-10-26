/**
 * Gardener (agent-core §10.9, plan M3-9): offline consolidation. Deterministic parts run here and
 * every change goes through the gate: near-duplicate detection (trigram text + structure), merging
 * duplicates by deprecating the weaker one, folding exceptions on one facet into a hard condition,
 * capacity limits, escape-hatch review, and a JSON snapshot of the whole graph.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	edges,
	listFacets,
	listProviders,
	listTemplates,
	listTemplateUses,
	type TemplateRecord,
} from "../knowledge/store.ts";
import type { TestmodePaths } from "../paths.ts";
import type { Store } from "../store/db.ts";
import { audit } from "../store/repos.ts";
import { newId, nowIso } from "../util.ts";
import { listDeltas, proposeDelta } from "./gate.ts";
import { applyLifecycle } from "./lifecycle.ts";
import { getStats, templateLowerBound } from "./stats.ts";

export const CAPACITY = { project: 50, global: 100 } as const;
export const DUPLICATE_THRESHOLD = 0.75;
export const FOLD_MIN = 3;

function trigrams(text: string): Set<string> {
	const t = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
	const out = new Set<string>();
	for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return a.size + b.size - inter === 0 ? 0 : inter / (a.size + b.size - inter);
}

export function similarity(a: TemplateRecord, b: TemplateRecord): number {
	const text = (t: TemplateRecord) =>
		trigrams([t.spec.card.title, t.spec.card.summary, ...t.spec.intent_patterns].join(" "));
	const facets = (t: TemplateRecord) =>
		new Set(t.spec.applicability.hard.map((h) => `${h.facet}:${h.op}:${h.value ?? h.values?.join("|")}`));
	const structure =
		(a.type === b.type ? 0.4 : 0) +
		0.4 * jaccard(facets(a), facets(b)) +
		(a.spec.slots.oracle?.ref && a.spec.slots.oracle.ref === b.spec.slots.oracle?.ref
			? 0.2
			: a.spec.slots.oracle?.text === b.spec.slots.oracle?.text
				? 0.2
				: 0);
	return 0.5 * jaccard(text(a), text(b)) + 0.5 * structure;
}

export interface GardenReport {
	duplicates: Array<{ keep: string; deprecate: string; similarity: number; decision?: string }>;
	folds: Array<{ template: string; facet: string; exceptions: string[]; decision?: string }>;
	overCapacity: Array<{ layer: string; type: string; count: number; candidates: string[] }>;
	transitions: string[];
	snapshot: string;
}

export function garden(s: Store, paths: TestmodePaths, opts: { apply?: boolean } = {}): GardenReport {
	const live = listTemplates(s).filter((t) => t.status !== "deprecated" && t.status !== "retired" && !t.seed);
	const report: GardenReport = { duplicates: [], folds: [], overCapacity: [], transitions: [], snapshot: "" };

	for (let i = 0; i < live.length; i++) {
		for (let j = i + 1; j < live.length; j++) {
			const sim = similarity(live[i], live[j]);
			if (sim < DUPLICATE_THRESHOLD) continue;
			const [keep, drop] =
				templateLowerBound(s, live[i].id) >= templateLowerBound(s, live[j].id)
					? [live[i], live[j]]
					: [live[j], live[i]];
			const entry: GardenReport["duplicates"][number] = {
				keep: keep.id,
				deprecate: drop.id,
				similarity: Math.round(sim * 100) / 100,
			};
			if (opts.apply) {
				// Evidence: the episodes that used the weaker template (a rarely used duplicate stays suspended).
				const used = [
					...new Set(
						listTemplateUses(s, { templateId: drop.id })
							.filter((u) => u.role !== "retrieved_unused")
							.map((u) => u.episodeId),
					),
				];
				const r = proposeDelta(s, {
					op: "deprecate",
					target: drop.id,
					payload: { reason: `near-duplicate of ${keep.id} (${entry.similarity})`, replaced_by: keep.id },
					evidence: used,
					proposedBy: "gardener",
				});
				entry.decision = r.report.decision;
			}
			report.duplicates.push(entry);
		}
	}

	for (const t of live) {
		const byFacet = new Map<string, string[]>();
		for (const ex of t.spec.applicability.exceptions) {
			if (ex.action !== "exclude" || ex.when.length !== 1 || ex.when[0].op !== "eq" || ex.source === "policy")
				continue;
			byFacet.set(ex.when[0].facet, [...(byFacet.get(ex.when[0].facet) ?? []), ex.id]);
		}
		for (const [facet, ids] of byFacet) {
			if (ids.length < FOLD_MIN) continue;
			const values = t.spec.applicability.exceptions
				.filter((e) => ids.includes(e.id))
				.map((e) => e.when[0].value as string);
			const entry: GardenReport["folds"][number] = { template: t.id, facet, exceptions: ids };
			if (opts.apply) {
				const support = ids.flatMap((id) =>
					listDeltas(s, { target: t.id, status: "committed" })
						.filter((d) => (d.payload as { exception?: { id: string } }).exception?.id === id)
						.flatMap((d) => d.evidence),
				);
				const r = proposeDelta(s, {
					op: "narrow",
					target: t.id,
					payload: { facet, exception_ids: ids, hard: { facet, op: "not_in", values } },
					evidence: [...new Set(support)],
					proposedBy: "gardener",
				});
				entry.decision = r.report.decision;
			}
			report.folds.push(entry);
		}
	}

	for (const layer of ["project", "global"] as const) {
		const byType = new Map<string, TemplateRecord[]>();
		for (const t of live.filter((x) => x.layer === layer)) byType.set(t.type, [...(byType.get(t.type) ?? []), t]);
		for (const [type, ts] of byType) {
			if (ts.length <= CAPACITY[layer]) continue;
			const weakest = [...ts]
				.sort((a, b) => templateLowerBound(s, a.id) - templateLowerBound(s, b.id))
				.slice(0, ts.length - CAPACITY[layer]);
			report.overCapacity.push({ layer, type, count: ts.length, candidates: weakest.map((t) => t.id) });
		}
	}

	if (opts.apply)
		for (const t of live) {
			const tr = applyLifecycle(s, t.id);
			if (tr) report.transitions.push(`${t.id}: ${tr.from} → ${tr.to} (${tr.reason})`);
		}
	report.snapshot = snapshot(s, paths);
	return report;
}

export function insertSnapshot(s: Store, r: { id: string; ts: string; path: string }): void {
	s.run("INSERT INTO snapshots (id, ts, path) VALUES ($id, $ts, $p)", { $id: r.id, $ts: r.ts, $p: r.path });
}

/** Whole-graph snapshot (agent-core §10.9 #6) for rollback and comparison. */
export function snapshot(s: Store, paths: TestmodePaths): string {
	const id = newId("snap");
	const dir = join(paths.dir, "snapshots");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.json`);
	const templates = listTemplates(s);
	const data = {
		id,
		ts: nowIso(),
		templates: templates.map((t) => ({ id: t.id, version: t.version, status: t.status, spec: t.spec, body: t.body })),
		edges: [
			...new Map(
				templates
					.flatMap((t) => [...edges(s, { src: t.id }), ...edges(s, { dst: t.id })])
					.map((e) => [`${e.src}|${e.kind}|${e.dst}`, e]),
			).values(),
		],
		facets: listFacets(s),
		stats: templates.flatMap((t) => getStats(s, t.id)),
		providers: listProviders(s).map((p) => ({
			sha256: p.sha256,
			capId: p.capId,
			kind: p.kind,
			name: p.name,
			trust: p.trust,
		})),
	};
	writeFileSync(path, JSON.stringify(data, null, 1));
	s.tx(() => {
		insertSnapshot(s, { id, ts: data.ts, path });
		audit(s, { actor: "main", event: "snapshot", reason: path });
	});
	return path;
}
