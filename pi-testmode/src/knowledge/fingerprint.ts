/**
 * Situation fingerprints (agent-core §6.3, plan M2-2). Only `active` facets take part in
 * judging; facets outside the vocabulary are recorded as `proposed` and kept out.
 */
import type { IntentIR } from "../orchestrator/intent.ts";
import { parseHost } from "../kernel/scope.ts";
import type { Store } from "../store/db.ts";
import { type Fingerprint, type FingerprintEntry, toFingerprint } from "./schema.ts";
import { listEpisodes, listFacets, proposeFacet } from "./store.ts";

const SUT_KIND: Record<string, string> = { api: "rest-api", web: "web-ui", cli: "cli", library: "library", service: "service" };
/** Facets describing the request rather than the SUT; never inherited from earlier episodes. */
const INTENT_FACETS = new Set(["goal.kind", "quality.attribute", "env.kind", "state.resource_kind"]);

function envKind(env: string | undefined): string | undefined {
	if (!env) return undefined;
	const e = env.trim().toLowerCase();
	if (/^(prod|production|live)$/.test(e)) return "production";
	if (/^(local|localhost|loopback)$/.test(e)) return "local";
	if (/^(dev|development|test)$/.test(e)) return "dev";
	if (/^(stage|staging|preprod|uat)$/.test(e)) return "staging";
	return e;
}

/** Facets the intent alone determines (conf 1, src intent). */
export function fromIntent(ir: Partial<IntentIR>): Fingerprint {
	const entries: FingerprintEntry[] = [];
	const push = (facet: string, v: string | string[] | undefined) => {
		if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
		entries.push(Array.isArray(v) ? { facet, values: v, conf: 1, src: "intent" } : { facet, value: v, conf: 1, src: "intent" });
	};
	push("goal.kind", ir.goal?.kind);
	push("quality.attribute", ir.goal?.quality_attributes);
	push("env.kind", envKind(ir.constraints?.environment));
	const ref = ir.sut_refs?.[0];
	if (ref) {
		push("sut.kind", SUT_KIND[ref.kind]);
		if (/^https?:\/\//i.test(ref.locator) || ref.kind === "api" || ref.kind === "web") push("interface.protocol", ref.kind === "web" ? "http/html" : "http/json");
	}
	if (ir.sut_refs?.some((r) => /openapi|swagger/i.test(r.locator))) {
		push("spec.format", "openapi");
		push("oracle.availability", ["spec"]);
	}
	return toFingerprint(entries);
}

/** Stable key for "the same SUT": `host:port` of the first URL locator, else the locator itself. */
export function sutKeyOf(locators: readonly string[]): string | undefined {
	for (const l of locators) {
		if (!/^https?:\/\//i.test(l)) continue;
		const h = parseHost(l);
		if (h) return h.port ? `${h.host}:${h.port}` : h.host;
	}
	return locators[0];
}

/**
 * Splits a reported fingerprint into its active part (used for judging) and the raw report.
 * Facets outside the vocabulary are recorded as proposed with their observation as evidence.
 * Episodes keep the raw report so a facet activated later can still tell old cases apart.
 */
export function normalizeFingerprint(
	s: Store,
	entries: readonly FingerprintEntry[],
	evidence: Record<string, unknown>,
): { fingerprint: Fingerprint; raw: Fingerprint; proposed: string[] } {
	const active = new Set(listFacets(s, "active").map((f) => f.name));
	const kept: FingerprintEntry[] = [];
	const proposed: string[] = [];
	for (const e of entries) {
		if (active.has(e.facet)) kept.push(e);
		else {
			const values = e.values ?? (e.value !== undefined ? [e.value] : []);
			if (proposeFacet(s, e.facet, values, { ...evidence, values, conf: e.conf })) proposed.push(e.facet);
		}
	}
	return { fingerprint: toFingerprint(kept), raw: toFingerprint(entries), proposed };
}

/** The part of a fingerprint over active facets. */
export function activeOnly(s: Store, fp: Fingerprint): Fingerprint {
	const active = new Set(listFacets(s, "active").map((f) => f.name));
	return Object.fromEntries(Object.entries(fp).filter(([k]) => active.has(k)));
}

/** Later sources override earlier ones facet by facet. */
export function mergeFingerprints(...fps: Array<Fingerprint | undefined>): Fingerprint {
	return Object.assign({}, ...fps.filter(Boolean));
}

/**
 * The fingerprint used to judge templates for an intent: the latest scout observation of the
 * same SUT, overridden by what the intent states, overridden by explicit facets.
 */
export function assembleFingerprint(
	s: Store,
	ir: Partial<IntentIR>,
	explicit: readonly FingerprintEntry[] = [],
): { fingerprint: Fingerprint; raw: Fingerprint; sutKey?: string } {
	const sutKey = sutKeyOf((ir.sut_refs ?? []).map((r) => r.locator));
	// The SUT model is the latest observation of the same SUT: a scout's, or a mission that was
	// asked to probe a facet (each episode stores the merged, cumulative view).
	const observed = sutKey
		? listEpisodes(s, { sutKey })
				.filter((e) => e.plan.role === "scout" || e.plan.role === "executor")
				.at(-1)?.fingerprint
		: undefined;
	// Intent-scoped facets (goal, quality) come from the intent, not from the SUT's history.
	const sutOnly = observed ? Object.fromEntries(Object.entries(observed).filter(([k]) => !INTENT_FACETS.has(k))) : undefined;
	const raw = mergeFingerprints(sutOnly, fromIntent(ir), toFingerprint(explicit));
	return { fingerprint: activeOnly(s, raw), raw, sutKey };
}
