/**
 * Knowledge repositories (plan §6, M2). Global-layer rows live in the attached `g` schema,
 * project-layer rows in `main`; reads merge both with the project layer taking precedence.
 */
import type { Store } from "../store/db.ts";
import { nowIso } from "../util.ts";
import type { Fingerprint, Predicate, TemplateSpec, TemplateStatus } from "./schema.ts";
import { SEED_FACETS, SEED_TEMPLATES } from "./seeds/index.ts";

export type Layer = "global" | "project";
export type Schema = "main" | "g";

export const schemaOf = (layer: Layer): Schema => (layer === "global" ? "g" : "main");
export const layerOfId = (id: string): Layer => (id.startsWith("tpl://global/") ? "global" : "project");

export interface TemplateRecord {
	id: string;
	layer: Layer;
	type: string;
	status: TemplateStatus;
	version: number;
	spec: TemplateSpec;
	body: string;
	seed: boolean;
	createdAt: string;
}

// ---------------------------------------------------------------- seeding

/** Idempotent: inserts seed facets and templates that are missing from the global layer. */
export function seedKnowledge(s: Store): number {
	let added = 0;
	s.tx(() => {
		for (const f of SEED_FACETS) {
			s.run(
				`INSERT INTO g.facets (name, type, values_json, status, created_at) VALUES ($n, $t, $v, 'active', $ts)
				 ON CONFLICT(name) DO NOTHING`,
				{ $n: f.name, $t: f.type, $v: JSON.stringify(f.values), $ts: nowIso() },
			);
		}
		for (const t of SEED_TEMPLATES) {
			if (getTemplate(s, t.spec.id)) continue;
			insertTemplate(s, t.spec, t.body, { status: "candidate", seed: true, changelog: "seed" });
			added++;
		}
	});
	return added;
}

// ---------------------------------------------------------------- templates

function facetPairs(p: Predicate): Array<[string, string]> {
	if (p.op === "ne" || p.op === "not_in" || p.op === "exists") return [];
	const values = p.values ?? (p.value !== undefined ? [p.value] : []);
	return values.map((v) => [p.facet, v.replace(/\/\*$/, "")]);
}

function indexTemplate(s: Store, schema: Schema, spec: TemplateSpec): void {
	s.run(`DELETE FROM ${schema}.templates_fts WHERE template_id = $id`, { $id: spec.id });
	s.run(
		`INSERT INTO ${schema}.templates_fts (template_id, title, summary, intent_patterns) VALUES ($id, $t, $s, $p)`,
		{
			$id: spec.id,
			$t: spec.card.title,
			$s: spec.card.summary,
			$p: spec.intent_patterns.join(" | "),
		},
	);
	s.run(`DELETE FROM ${schema}.template_facets WHERE template_id = $id`, { $id: spec.id });
	const pairs = [
		...spec.applicability.hard.flatMap(facetPairs),
		...spec.applicability.soft.flatMap((x) => facetPairs(x.when)),
	];
	for (const [facet, value] of pairs) {
		s.run(`INSERT OR IGNORE INTO ${schema}.template_facets (template_id, facet, value) VALUES ($id, $f, $v)`, {
			$id: spec.id,
			$f: facet,
			$v: value,
		});
	}
}

export function insertTemplate(
	s: Store,
	spec: TemplateSpec,
	body: string,
	opts: { status: TemplateStatus; seed?: boolean; changelog: string; delta?: string },
): TemplateRecord {
	const layer = layerOfId(spec.id);
	const schema = schemaOf(layer);
	const ts = nowIso();
	s.tx(() => {
		s.run(
			`INSERT INTO ${schema}.templates (id, layer, type, status, head_version, seed, created_at) VALUES ($id, $l, $t, $st, 1, $seed, $ts)`,
			{ $id: spec.id, $l: layer, $t: spec.type, $st: opts.status, $seed: opts.seed ?? false, $ts: ts },
		);
		s.run(
			`INSERT INTO ${schema}.template_versions (template_id, version, spec_json, body_md, changelog, created_by_delta, created_at)
			 VALUES ($id, 1, $spec, $body, $log, $d, $ts)`,
			{
				$id: spec.id,
				$spec: JSON.stringify(spec),
				$body: body,
				$log: opts.changelog,
				$d: opts.delta ?? null,
				$ts: ts,
			},
		);
		indexTemplate(s, schema, spec);
		for (const c of spec.composes ?? []) addEdge(s, layer, spec.id, c.ref, "composes", { slot: c.slot });
		if (spec.specializes) addEdge(s, layer, spec.id, spec.specializes, "specializes");
		for (const c of spec.capabilities_required)
			addEdge(s, layer, spec.id, c.cap, "requires", { constraint: c.constraint });
	});
	return getTemplate(s, spec.id) as TemplateRecord;
}

/** Writes a new head version (used by M3 deltas). */
export function addTemplateVersion(
	s: Store,
	id: string,
	spec: TemplateSpec,
	body: string,
	changelog: string,
	delta?: string,
	expectedHead?: number,
): number {
	const schema = schemaOf(layerOfId(id));
	return s.tx(() => {
		const head = s.get<{ head_version: number }>(`SELECT head_version FROM ${schema}.templates WHERE id = $id`, {
			$id: id,
		});
		if (!head) throw new Error(`unknown template ${id}`);
		if (expectedHead !== undefined && head.head_version !== expectedHead)
			throw new Error(`template ${id} moved to v${head.head_version} (expected v${expectedHead})`);
		const v = head.head_version + 1;
		s.run(
			`INSERT INTO ${schema}.template_versions (template_id, version, spec_json, body_md, changelog, created_by_delta, created_at)
			 VALUES ($id, $v, $spec, $body, $log, $d, $ts)`,
			{
				$id: id,
				$v: v,
				$spec: JSON.stringify(spec),
				$body: body,
				$log: changelog,
				$d: delta ?? null,
				$ts: nowIso(),
			},
		);
		s.run(`UPDATE ${schema}.templates SET head_version = $v WHERE id = $id`, { $id: id, $v: v });
		indexTemplate(s, schema, spec);
		return v;
	});
}

export function setTemplateStatus(s: Store, id: string, status: TemplateStatus): void {
	s.run(`UPDATE ${schemaOf(layerOfId(id))}.templates SET status = $st WHERE id = $id`, { $id: id, $st: status });
}

function toRecord(r: Record<string, unknown>): TemplateRecord {
	return {
		id: r.id as string,
		layer: r.layer as Layer,
		type: r.type as string,
		status: r.status as TemplateStatus,
		version: Number(r.head_version),
		spec: JSON.parse(r.spec_json as string),
		body: r.body_md as string,
		seed: Boolean(r.seed),
		createdAt: r.created_at as string,
	};
}

const SELECT_HEAD = (schema: Schema) =>
	`SELECT t.*, v.spec_json, v.body_md FROM ${schema}.templates t JOIN ${schema}.template_versions v ON v.template_id = t.id AND v.version = t.head_version`;

export function getTemplate(s: Store, id: string, version?: number): TemplateRecord | undefined {
	const schema = schemaOf(layerOfId(id));
	if (version !== undefined) {
		const r = s.get<Record<string, unknown>>(
			`SELECT t.*, v.spec_json, v.body_md, v.version AS head_version FROM ${schema}.templates t JOIN ${schema}.template_versions v ON v.template_id = t.id WHERE t.id = $id AND v.version = $v`,
			{ $id: id, $v: version },
		);
		return r ? toRecord(r) : undefined;
	}
	const r = s.get<Record<string, unknown>>(`${SELECT_HEAD(schema)} WHERE t.id = $id`, { $id: id });
	return r ? toRecord(r) : undefined;
}

export function listTemplates(s: Store, where: { ids?: string[] } = {}): TemplateRecord[] {
	const out: TemplateRecord[] = [];
	for (const schema of ["main", "g"] as const) {
		const rows = s.all<Record<string, unknown>>(`${SELECT_HEAD(schema)} ORDER BY t.created_at, t.id`);
		for (const r of rows) if (!where.ids || where.ids.includes(r.id as string)) out.push(toRecord(r));
	}
	return out;
}

/** Version changelog of a template, oldest first, up to `upTo` (inclusive). */
export function templateHistory(
	s: Store,
	id: string,
	upTo: number,
): Array<{ version: number; changelog: string; createdAt: string }> {
	return s
		.all<{ version: number; changelog: string; created_at: string }>(
			`SELECT version, changelog, created_at FROM ${schemaOf(layerOfId(id))}.template_versions
			 WHERE template_id = $id AND version <= $v ORDER BY version`,
			{ $id: id, $v: upTo },
		)
		.map((r) => ({ version: r.version, changelog: r.changelog, createdAt: r.created_at }));
}

/** Template ids whose title/summary/patterns relate to `query` (FTS trigram + short-pattern containment). */
export function textRecall(s: Store, query: string): Map<string, number> {
	const hits = new Map<string, number>();
	const q = query.toLowerCase();
	const add = (id: string, w: number) => hits.set(id, (hits.get(id) ?? 0) + w);
	const terms = [...new Set(q.split(/[\s,.;:!?，。；：！？、()（）"'`]+/).filter((t) => t.length >= 3))].slice(0, 12);
	for (const schema of ["main", "g"] as const) {
		if (terms.length > 0) {
			const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
			try {
				for (const r of s.all<{ template_id: string }>(
					`SELECT template_id FROM ${schema}.templates_fts WHERE templates_fts MATCH $m`,
					{ $m: match },
				))
					add(r.template_id, 1);
			} catch {
				// malformed match expression: fall back to the pattern scan below
			}
		}
		// Intent patterns are short phrases (often 2 CJK characters, below trigram length): test containment.
		for (const r of s.all<{ template_id: string; intent_patterns: string }>(
			`SELECT template_id, intent_patterns FROM ${schema}.templates_fts`,
		)) {
			const patterns = r.intent_patterns
				.toLowerCase()
				.split("|")
				.flatMap((p) => p.split(/\s+/))
				.map((p) => p.trim())
				.filter((p) => p.length >= 2);
			const n = patterns.filter((p) => q.includes(p)).length;
			if (n > 0) add(r.template_id, n);
		}
	}
	return hits;
}

/** Template ids indexed under any (facet, value) of the fingerprint. */
export function facetRecall(s: Store, fp: Fingerprint): Set<string> {
	const ids = new Set<string>();
	for (const [facet, v] of Object.entries(fp)) {
		for (const value of v.values) {
			for (const schema of ["main", "g"] as const) {
				for (const r of s.all<{ template_id: string }>(
					`SELECT template_id FROM ${schema}.template_facets WHERE facet = $f AND value = $v`,
					{ $f: facet, $v: value },
				))
					ids.add(r.template_id);
			}
		}
	}
	return ids;
}

// ---------------------------------------------------------------- graph

export type EdgeKind =
	| "specializes"
	| "composes"
	| "refers"
	| "alternative_to"
	| "precedes"
	| "conflicts_with"
	| "redirects_to"
	| "derived_from"
	| "overrides"
	| "requires"
	| "implemented_by";

export function addEdge(
	s: Store,
	layer: Layer,
	src: string,
	dst: string,
	kind: EdgeKind,
	attrs: Record<string, unknown> = {},
): void {
	s.run(`INSERT OR REPLACE INTO ${schemaOf(layer)}.edges (src, dst, kind, attrs_json) VALUES ($s, $d, $k, $a)`, {
		$s: src,
		$d: dst,
		$k: kind,
		$a: JSON.stringify(attrs),
	});
}

export function edges(
	s: Store,
	where: { src?: string; dst?: string; kind?: EdgeKind },
): Array<{ src: string; dst: string; kind: EdgeKind; attrs: Record<string, unknown> }> {
	const out: Array<{ src: string; dst: string; kind: EdgeKind; attrs: Record<string, unknown> }> = [];
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.src) clauses.push("src = $s"), (params.$s = where.src);
	if (where.dst) clauses.push("dst = $d"), (params.$d = where.dst);
	if (where.kind) clauses.push("kind = $k"), (params.$k = where.kind);
	for (const schema of ["main", "g"] as const) {
		for (const r of s.all<Record<string, string>>(
			`SELECT * FROM ${schema}.edges ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
			params,
		)) {
			out.push({ src: r.src, dst: r.dst, kind: r.kind as EdgeKind, attrs: JSON.parse(r.attrs_json) });
		}
	}
	return out;
}

// ---------------------------------------------------------------- facets

export interface FacetRow {
	name: string;
	type: string;
	values: string[];
	status: "active" | "proposed";
	evidence: unknown[];
}

export function listFacets(s: Store, status?: "active" | "proposed"): FacetRow[] {
	return s
		.all<Record<string, string>>(
			`SELECT * FROM g.facets ${status ? "WHERE status = $st" : ""} ORDER BY name`,
			status ? { $st: status } : {},
		)
		.map((r) => ({
			name: r.name,
			type: r.type,
			values: JSON.parse(r.values_json),
			status: r.status as FacetRow["status"],
			evidence: JSON.parse(r.evidence_json),
		}));
}

/** Records a facet that is not in the vocabulary as `proposed` (plan M2-2); returns true if new. */
export function proposeFacet(s: Store, name: string, values: string[], evidence: unknown): boolean {
	const existing = s.get<{ evidence_json: string; values_json: string; status: string }>(
		"SELECT * FROM g.facets WHERE name = $n",
		{ $n: name },
	);
	if (existing) {
		if (existing.status === "proposed") {
			const ev = [...JSON.parse(existing.evidence_json), evidence];
			const vals = [...new Set([...JSON.parse(existing.values_json), ...values])];
			s.run("UPDATE g.facets SET evidence_json = $e, values_json = $v WHERE name = $n", {
				$n: name,
				$e: JSON.stringify(ev),
				$v: JSON.stringify(vals),
			});
		}
		return false;
	}
	s.run(
		`INSERT INTO g.facets (name, type, values_json, status, evidence_json, created_at) VALUES ($n, 'enum', $v, 'proposed', $e, $ts)`,
		{
			$n: name,
			$v: JSON.stringify(values),
			$e: JSON.stringify([evidence]),
			$ts: nowIso(),
		},
	);
	return true;
}

export function activateFacet(s: Store, name: string): void {
	s.run("UPDATE g.facets SET status = 'active' WHERE name = $n", { $n: name });
}

// ---------------------------------------------------------------- capabilities and providers

export type Trust = "quarantined" | "candidate" | "verified" | "pinned";

export interface ProviderRow {
	sha256: string;
	capId: string;
	layer: Layer;
	kind: "skill" | "mcp" | "cli";
	name: string;
	version: string;
	location: { path?: string; server?: string; config?: unknown; toolDefsSha?: string };
	trust: Trust;
	conformanceScore: number | null;
	provenance: Record<string, unknown>;
}

export function ensureCapability(s: Store, id: string, semantics: string, io: unknown = {}): void {
	s.run(
		`INSERT INTO g.capabilities (id, io_schema_json, semantics, created_at) VALUES ($id, $io, $sem, $ts) ON CONFLICT(id) DO NOTHING`,
		{
			$id: id,
			$io: JSON.stringify(io),
			$sem: semantics,
			$ts: nowIso(),
		},
	);
}

export function getCapability(s: Store, id: string): { id: string; semantics: string; io: unknown } | undefined {
	const r = s.get<Record<string, string>>("SELECT * FROM g.capabilities WHERE id = $id", { $id: id });
	return r ? { id: r.id, semantics: r.semantics, io: JSON.parse(r.io_schema_json) } : undefined;
}

export function insertProvider(
	s: Store,
	p: Omit<ProviderRow, "conformanceScore"> & { conformanceScore?: number | null },
): void {
	s.run(
		`INSERT INTO ${schemaOf(p.layer)}.providers (sha256, cap_id, layer, kind, name, version, path_or_config_json, trust, conformance_score, provenance_json, created_at)
		 VALUES ($h, $c, $l, $k, $n, $v, $loc, $t, $score, $prov, $ts) ON CONFLICT(sha256) DO NOTHING`,
		{
			$h: p.sha256,
			$c: p.capId,
			$l: p.layer,
			$k: p.kind,
			$n: p.name,
			$v: p.version,
			$loc: JSON.stringify(p.location),
			$t: p.trust,
			$score: p.conformanceScore ?? null,
			$prov: JSON.stringify(p.provenance),
			$ts: nowIso(),
		},
	);
}

function toProvider(r: Record<string, unknown>): ProviderRow {
	return {
		sha256: r.sha256 as string,
		capId: r.cap_id as string,
		layer: r.layer as Layer,
		kind: r.kind as ProviderRow["kind"],
		name: r.name as string,
		version: r.version as string,
		location: JSON.parse(r.path_or_config_json as string),
		trust: r.trust as Trust,
		conformanceScore: (r.conformance_score as number) ?? null,
		provenance: JSON.parse((r.provenance_json as string) || "{}"),
	};
}

export function listProviders(s: Store, where: { capId?: string; trust?: Trust[] } = {}): ProviderRow[] {
	const out: ProviderRow[] = [];
	for (const schema of ["main", "g"] as const) {
		for (const r of s.all<Record<string, unknown>>(
			`SELECT * FROM ${schema}.providers ${where.capId ? "WHERE cap_id = $c" : ""} ORDER BY created_at`,
			where.capId ? { $c: where.capId } : {},
		)) {
			const p = toProvider(r);
			if (!where.trust || where.trust.includes(p.trust)) out.push(p);
		}
	}
	return out;
}

export function getProvider(s: Store, sha: string): ProviderRow | undefined {
	return listProviders(s).find((p) => p.sha256 === sha);
}

export function setProviderTrust(s: Store, sha: string, trust: Trust, score?: number): void {
	for (const schema of ["main", "g"] as const) {
		s.run(
			`UPDATE ${schema}.providers SET trust = $t, conformance_score = COALESCE($score, conformance_score), verified_at = CASE WHEN $t = 'verified' THEN $ts ELSE verified_at END WHERE sha256 = $h`,
			{ $h: sha, $t: trust, $score: score ?? null, $ts: nowIso() },
		);
	}
}

// ---------------------------------------------------------------- experience (project layer only)

export interface EpisodeRow {
	id: string;
	missionId: string;
	intentId: string;
	sutKey: string | null;
	fingerprint: Fingerprint;
	plan: { templates: Array<{ id: string; version: number }>; capabilities: string[]; role: string };
	deviations: unknown[];
	outcome: string;
	createdAt: string;
}

function toEpisode(r: Record<string, string>): EpisodeRow {
	return {
		id: r.id,
		missionId: r.mission_id,
		intentId: r.intent_id,
		sutKey: r.sut_key ?? null,
		fingerprint: JSON.parse(r.fingerprint_json),
		plan: JSON.parse(r.plan_json),
		deviations: JSON.parse(r.deviations_json),
		outcome: r.outcome,
		createdAt: r.created_at,
	};
}

export function insertEpisode(s: Store, e: Omit<EpisodeRow, "createdAt">): void {
	s.run(
		`INSERT INTO episodes (id, mission_id, intent_id, sut_key, fingerprint_json, plan_json, deviations_json, outcome, created_at)
		 VALUES ($id, $m, $i, $k, $fp, $plan, $dev, $o, $ts) ON CONFLICT(mission_id) DO NOTHING`,
		{
			$id: e.id,
			$m: e.missionId,
			$i: e.intentId,
			$k: e.sutKey,
			$fp: JSON.stringify(e.fingerprint),
			$plan: JSON.stringify(e.plan),
			$dev: JSON.stringify(e.deviations),
			$o: e.outcome,
			$ts: nowIso(),
		},
	);
}

export function getEpisodeByMission(s: Store, missionId: string): EpisodeRow | undefined {
	const r = s.get<Record<string, string>>("SELECT * FROM episodes WHERE mission_id = $m", { $m: missionId });
	return r ? toEpisode(r) : undefined;
}

export function getEpisode(s: Store, id: string): EpisodeRow | undefined {
	const r = s.get<Record<string, string>>("SELECT * FROM episodes WHERE id = $id", { $id: id });
	return r ? toEpisode(r) : undefined;
}

export function listEpisodes(s: Store, where: { intentId?: string; sutKey?: string } = {}): EpisodeRow[] {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.intentId) clauses.push("intent_id = $i"), (params.$i = where.intentId);
	if (where.sutKey) clauses.push("sut_key = $k"), (params.$k = where.sutKey);
	return s
		.all<Record<string, string>>(
			`SELECT * FROM episodes ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`,
			params,
		)
		.map(toEpisode);
}

export function insertTemplateUse(
	s: Store,
	e: {
		episodeId: string;
		templateId: string;
		version: number;
		role: "applied" | "cited" | "retrieved_unused";
		slot?: string;
	},
): void {
	s.run(
		`INSERT OR IGNORE INTO template_uses (episode_id, template_id, version, role, slot) VALUES ($e, $t, $v, $r, $s)`,
		{
			$e: e.episodeId,
			$t: e.templateId,
			$v: e.version,
			$r: e.role,
			$s: e.slot ?? null,
		},
	);
}

export function listTemplateUses(
	s: Store,
	where: { episodeId?: string; templateId?: string } = {},
): Array<{ episodeId: string; templateId: string; version: number; role: string }> {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.episodeId) clauses.push("episode_id = $e"), (params.$e = where.episodeId);
	if (where.templateId) clauses.push("template_id = $t"), (params.$t = where.templateId);
	return s
		.all<Record<string, unknown>>(
			`SELECT * FROM template_uses ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
			params,
		)
		.map((r) => ({
			episodeId: r.episode_id as string,
			templateId: r.template_id as string,
			version: Number(r.version),
			role: r.role as string,
		}));
}

export function insertCornerstone(
	s: Store,
	e: { templateId: string; exceptionId?: string | null; episodeId: string; fingerprint: Fingerprint },
): void {
	s.run(
		`INSERT OR IGNORE INTO cornerstones (template_id, exception_id, episode_id, fingerprint_json) VALUES ($t, $x, $e, $fp)`,
		{
			$t: e.templateId,
			$x: e.exceptionId ?? null,
			$e: e.episodeId,
			$fp: JSON.stringify(e.fingerprint),
		},
	);
}

export function listCornerstones(
	s: Store,
	templateId: string,
): Array<{ exceptionId: string | null; episodeId: string; fingerprint: Fingerprint }> {
	return s
		.all<Record<string, string>>("SELECT * FROM cornerstones WHERE template_id = $t ORDER BY episode_id", {
			$t: templateId,
		})
		.map((r) => ({
			exceptionId: r.exception_id ?? null,
			episodeId: r.episode_id,
			fingerprint: JSON.parse(r.fingerprint_json),
		}));
}

// ---------------------------------------------------------------- capability gaps

export interface GapRow {
	id: string;
	requestedBy: string;
	capId: string;
	spec: { semantics: string; io?: unknown; constraints?: unknown; acceptance_hints?: string[] };
	status: "open" | "acquiring" | "resolved" | "failed";
	toolsmithMissionId: string | null;
	providerSha: string | null;
}

export function insertGap(s: Store, g: Omit<GapRow, "status" | "toolsmithMissionId" | "providerSha">): void {
	s.run(
		`INSERT INTO capability_gaps (id, requested_by, cap_id, spec_json, status, created_at) VALUES ($id, $m, $c, $spec, 'open', $ts)`,
		{
			$id: g.id,
			$m: g.requestedBy,
			$c: g.capId,
			$spec: JSON.stringify(g.spec),
			$ts: nowIso(),
		},
	);
}

export function updateGap(
	s: Store,
	id: string,
	patch: { status?: GapRow["status"]; toolsmithMissionId?: string; providerSha?: string },
): void {
	s.run(
		`UPDATE capability_gaps SET status = COALESCE($st, status), toolsmith_mission_id = COALESCE($tm, toolsmith_mission_id),
		 provider_sha = COALESCE($p, provider_sha), resolved_at = CASE WHEN $st IN ('resolved', 'failed') THEN $ts ELSE resolved_at END WHERE id = $id`,
		{
			$id: id,
			$st: patch.status ?? null,
			$tm: patch.toolsmithMissionId ?? null,
			$p: patch.providerSha ?? null,
			$ts: nowIso(),
		},
	);
}

export function listGaps(
	s: Store,
	where: { requestedBy?: string; toolsmithMissionId?: string; capId?: string } = {},
): GapRow[] {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.requestedBy) clauses.push("requested_by = $m"), (params.$m = where.requestedBy);
	if (where.toolsmithMissionId) clauses.push("toolsmith_mission_id = $t"), (params.$t = where.toolsmithMissionId);
	if (where.capId) clauses.push("cap_id = $c"), (params.$c = where.capId);
	return s
		.all<Record<string, string>>(
			`SELECT * FROM capability_gaps ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at`,
			params,
		)
		.map((r) => ({
			id: r.id,
			requestedBy: r.requested_by,
			capId: r.cap_id,
			spec: JSON.parse(r.spec_json),
			status: r.status as GapRow["status"],
			toolsmithMissionId: r.toolsmith_mission_id ?? null,
			providerSha: r.provider_sha ?? null,
		}));
}

// ---------------------------------------------------------------- retrievals

export function insertRetrieval(
	s: Store,
	e: { id: string; intentId: string; query: string; fingerprint: Fingerprint; hitLevel: string; cards: unknown[] },
): void {
	s.run(
		`INSERT INTO retrievals (id, intent_id, query, fingerprint_json, hit_level, cards_json, created_at) VALUES ($id, $i, $q, $fp, $h, $c, $ts)`,
		{
			$id: e.id,
			$i: e.intentId,
			$q: e.query,
			$fp: JSON.stringify(e.fingerprint),
			$h: e.hitLevel,
			$c: JSON.stringify(e.cards),
			$ts: nowIso(),
		},
	);
	s.run("UPDATE intents SET hit_level = $h WHERE id = $i", { $i: e.intentId, $h: e.hitLevel });
}

export function listRetrievals(
	s: Store,
	intentId: string,
): Array<{ hitLevel: string; cards: Array<{ id: string; version: number }> }> {
	return s
		.all<Record<string, string>>("SELECT * FROM retrievals WHERE intent_id = $i ORDER BY created_at", {
			$i: intentId,
		})
		.map((r) => ({ hitLevel: r.hit_level, cards: JSON.parse(r.cards_json) }));
}
