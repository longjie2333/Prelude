/**
 * Gate (agent-core §10.8, plan M3-6). All checks are kernel code:
 * 1 schema + graph invariants (§8.7), 2 cornerstone replay through the same `judge` (verdicts
 * must not change), 3 evidence thresholds (boundary ≥2, content ≥3, +1 for stable templates),
 * 4 counter-example search for `generalize`, 5 severity never raises priority, 7 size limit.
 * Deltas on the same template are serialized by the store transaction and a head-version lock.
 */
import { Value } from "typebox/value";
import { activeOnly } from "../knowledge/fingerprint.ts";
import { judge } from "../knowledge/applicability.ts";
import { type TemplateSpec, TemplateSpecSchema } from "../knowledge/schema.ts";
import {
	addEdge,
	addTemplateVersion,
	edges,
	getEpisode,
	getTemplate,
	insertCornerstone,
	insertTemplate,
	layerOfId,
	listCornerstones,
	setTemplateStatus,
	type TemplateRecord,
} from "../knowledge/store.ts";
import type { Store } from "../store/db.ts";
import { audit } from "../store/repos.ts";
import { newId, nowIso, stableStringify } from "../util.ts";
import { type Applied, applyDelta, CHANGES_APPLICABILITY, type DeltaOp, OP_KIND, PayloadSchemas } from "./delta.ts";

export const THRESHOLDS = { boundary: 2, content: 3, stableExtra: 1 } as const;
export const MAX_PAYLOAD_BYTES = 4096;

export interface ReplayRow {
	episodeId: string;
	exceptionId: string | null;
	before: string;
	after: string;
	ok: boolean;
}

export interface GateReport {
	op: DeltaOp;
	target: string;
	baseVersion: number;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	replay: ReplayRow[];
	evidence: { have: number; need: number };
	decision: "committed" | "suspended" | "rejected";
}

export interface DeltaProposal {
	op: DeltaOp;
	target: string;
	payload: Record<string, unknown>;
	evidence: string[];
	proposedBy: string;
	/** Groups observations of one hypothesis (e.g. `except:<tpl>:consistency.model=eventual`). */
	hypothesisKey?: string;
	/** Existing suspended delta to re-gate with accumulated evidence. */
	deltaId?: string;
}

/** Project deltas never edit a global template: they go to a project-layer override (§8.5). */
export function ensureProjectOverride(s: Store, target: string): string {
	if (layerOfId(target) === "project") return target;
	const existing = edges(s, { dst: target, kind: "overrides" }).find((e) => e.src.startsWith("tpl://project/"));
	if (existing) return existing.src;
	const t = getTemplate(s, target);
	if (!t) throw new Error(`unknown template ${target}`);
	const id = `tpl://project/${target.slice("tpl://global/".length)}`;
	s.tx(() => {
		insertTemplate(s, { ...t.spec, id }, t.body, {
			status: t.status,
			changelog: `project override of ${target}@${t.version}`,
		});
		addEdge(s, "project", id, target, "overrides");
		for (const c of listCornerstones(s, target))
			insertCornerstone(s, {
				templateId: id,
				exceptionId: c.exceptionId,
				episodeId: c.episodeId,
				fingerprint: c.fingerprint,
			});
	});
	return id;
}

function graphOk(s: Store, spec: TemplateSpec, extra: Applied["edges"] = []): string | undefined {
	for (const kind of ["specializes", "composes"] as const) {
		const out = new Map<string, string[]>();
		for (const e of edges(s, { kind })) out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
		for (const e of extra.filter((x) => x.kind === kind)) out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
		if (kind === "composes")
			out.set(
				spec.id,
				(spec.composes ?? []).map((c) => c.ref),
			);
		if (kind === "specializes" && spec.specializes) out.set(spec.id, [spec.specializes]);
		const seen = new Set<string>();
		const stack = new Set<string>();
		const dfs = (n: string): boolean => {
			if (stack.has(n)) return true;
			if (seen.has(n)) return false;
			seen.add(n);
			stack.add(n);
			const cyc = (out.get(n) ?? []).some(dfs);
			stack.delete(n);
			return cyc;
		};
		if ([...out.keys()].some(dfs)) return `${kind} would form a cycle`;
	}
	return undefined;
}

function refsOk(s: Store, spec: TemplateSpec): string | undefined {
	const refs = [
		...(spec.composes ?? []).map((c) => c.ref),
		...spec.applicability.exceptions.flatMap((e) => [
			e.redirect,
			e.patch?.use?.startsWith("tpl://") ? e.patch.use : undefined,
		]),
	].filter((r): r is string => !!r);
	const missing = refs.filter((r) => !getTemplate(s, r));
	return missing.length ? `unresolved references: ${missing.join(", ")}` : undefined;
}

export function gate(s: Store, p: DeltaProposal, base: TemplateRecord): { report: GateReport; applied?: Applied } {
	const checks: GateReport["checks"] = [];
	const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
	const report: GateReport = {
		op: p.op,
		target: base.id,
		baseVersion: base.version,
		checks,
		replay: [],
		evidence: { have: 0, need: 0 },
		decision: "rejected",
	};

	const payloadOk = Value.Check(PayloadSchemas[p.op], p.payload);
	check(
		"payload schema",
		payloadOk,
		payloadOk ? "" : `${[...Value.Errors(PayloadSchemas[p.op], p.payload)][0]?.message ?? "invalid"}`,
	);
	const size = Buffer.byteLength(stableStringify(p.payload));
	check("size limit", size <= MAX_PAYLOAD_BYTES, `${size} bytes`);
	check(
		"no severity boost",
		!("severity" in p.payload) && !("priority" in p.payload),
		"severity/priority fields are not accepted",
	);
	if (!checks.every((c) => c.ok)) return { report };

	let applied: Applied;
	try {
		applied = applyDelta(base.spec, base.body, p.op, p.payload);
	} catch (err) {
		check("applies", false, (err as Error).message);
		return { report };
	}
	const schemaOk = Value.Check(TemplateSpecSchema, applied.spec);
	check(
		"template schema",
		schemaOk,
		schemaOk ? "" : `${[...Value.Errors(TemplateSpecSchema, applied.spec)][0]?.instancePath ?? ""}`,
	);
	const refs = refsOk(s, applied.spec);
	check("references resolve", !refs, refs ?? "");
	const cyc = graphOk(s, applied.spec, applied.edges);
	check("graph invariants", !cyc, cyc ?? "");

	// Cornerstone replay: every archived cornerstone keeps its verdict (and exception) under the new spec.
	if (CHANGES_APPLICABILITY.has(p.op) || p.op === "specialize") {
		for (const c of listCornerstones(s, base.id)) {
			const fp = activeOnly(s, c.fingerprint);
			const before = judge(base.spec.applicability, fp);
			const after = judge(applied.spec.applicability, fp);
			const same =
				before.result === after.result && (before.exception?.id ?? null) === (after.exception?.id ?? null);
			report.replay.push({
				episodeId: c.episodeId,
				exceptionId: c.exceptionId,
				before: `${before.result}${before.exception ? `/${before.exception.id}` : ""}`,
				after: `${after.result}${after.exception ? `/${after.exception.id}` : ""}`,
				ok: same,
			});
		}
		const changed = report.replay.filter((r) => !r.ok);
		check(
			"cornerstone replay",
			changed.length === 0,
			changed.length ? `${changed.length} cornerstone verdict(s) would change` : `${report.replay.length} unchanged`,
		);
	}

	// The new exception must actually fire on the episodes it is built from (first-match order).
	if (p.op === "except") {
		const exId = (p.payload as { exception: { id: string } }).exception.id;
		const misses = p.evidence.filter((id) => {
			const ep = getEpisode(s, id);
			return !ep || judge(applied.spec.applicability, activeOnly(s, ep.fingerprint)).exception?.id !== exId;
		});
		check(
			"exception fires on its evidence",
			misses.length === 0,
			misses.length ? `does not fire on ${misses.join(", ")}` : "",
		);
	}

	if (p.op === "generalize") {
		const counter = s
			.all<{ episode_id: string }>("SELECT episode_id FROM feedback WHERE triage_class IN ('B', 'K')")
			.map((r) => getEpisode(s, r.episode_id))
			.filter((ep) => ep?.plan.templates.some((t) => t.id === base.id))
			.filter(
				(ep) =>
					ep &&
					judge(applied.spec.applicability, activeOnly(s, ep.fingerprint)).result === "true" &&
					judge(base.spec.applicability, activeOnly(s, ep.fingerprint)).result !== "true",
			);
		check(
			"counter-example search",
			counter.length === 0,
			counter.length ? `${counter.length} failing episode(s) fall in the widened region` : "",
		);
	}

	if (!checks.every((c) => c.ok)) return { report, applied };

	const kind = OP_KIND[p.op];
	const need = kind === "none" ? 0 : THRESHOLDS[kind] + (base.status === "stable" ? THRESHOLDS.stableExtra : 0);
	const have = new Set(p.evidence).size;
	report.evidence = { have, need };
	report.decision = have >= need ? "committed" : "suspended";
	return { report, applied };
}

export function hypothesisKey(p: Pick<DeltaProposal, "op" | "target" | "payload">): string {
	if (p.op === "except")
		return `except:${p.target}:${stableStringify((p.payload as { exception: { when: unknown } }).exception.when)}`;
	if (p.op === "facet.propose") return `facet:${p.target}:${(p.payload as { facet: string }).facet}`;
	return `${p.op}:${p.target}:${stableStringify(p.payload)}`;
}

/** Gate a proposal and record the outcome; commits create a new template version. */
export function proposeDelta(s: Store, p: DeltaProposal): { id: string; report: GateReport; version?: number } {
	return s.tx(() => {
		const target = ensureProjectOverride(s, p.target);
		const base = getTemplate(s, target);
		if (!base) throw new Error(`unknown template ${target}`);
		const proposal = { ...p, target };
		const { report, applied } = gate(s, proposal, base);
		const key = p.hypothesisKey ?? hypothesisKey(proposal);
		const id = p.deltaId ?? newId("d");
		const row = {
			$id: id,
			$op: p.op,
			$t: target,
			$v: base.version,
			$k: key,
			$p: JSON.stringify(p.payload),
			$e: JSON.stringify([...new Set(p.evidence)]),
			$st: report.decision,
			$g: JSON.stringify(report),
			$by: p.proposedBy,
			$ts: nowIso(),
		};
		if (p.deltaId) {
			// node:sqlite rejects named parameters a statement does not use.
			const { $op: _op, $k: _k, $by: _by, ...update } = row;
			s.run(
				`UPDATE deltas SET payload_json = $p, evidence_json = $e, status = $st, gate_report_json = $g, target = $t, target_version = $v, decided_at = $ts WHERE id = $id`,
				update,
			);
		} else {
			s.run(
				`INSERT INTO deltas (id, op, target, target_version, hypothesis_key, payload_json, evidence_json, status, gate_report_json, proposed_by, created_at, decided_at)
				 VALUES ($id, $op, $t, $v, $k, $p, $e, $st, $g, $by, $ts, $ts)`,
				row,
			);
		}
		let version: number | undefined;
		if (report.decision === "committed" && applied) {
			if (p.op !== "reinforce" && p.op !== "rebind" && p.op !== "facet.propose") {
				version = addTemplateVersion(
					s,
					target,
					applied.spec,
					applied.body ?? base.body,
					`${p.op} (${id})`,
					id,
					base.version,
				);
			}
			if (p.op === "except") {
				const exId = (p.payload as { exception: { id: string } }).exception.id;
				for (const epId of p.evidence) {
					const ep = getEpisode(s, epId);
					if (ep)
						insertCornerstone(s, {
							templateId: target,
							exceptionId: exId,
							episodeId: epId,
							fingerprint: ep.fingerprint,
						});
				}
			}
			for (const e of applied.edges ?? []) addEdge(s, "project", e.src, e.dst, e.kind);
			if (applied.status) setTemplateStatus(s, target, applied.status);
		}
		audit(s, {
			actor: (p.proposedBy.startsWith("mission:") ? p.proposedBy : "main") as `mission:${string}` | "main",
			event: "delta",
			decision: report.decision,
			reason: `${id} ${p.op} ${target}@${base.version}: ${
				report.checks
					.filter((c) => !c.ok)
					.map((c) => `${c.name} — ${c.detail}`)
					.join("; ") || `evidence ${report.evidence.have}/${report.evidence.need}`
			}`,
		});
		return { id, report, version };
	});
}

export function listDeltas(
	s: Store,
	where: { target?: string; status?: string; hypothesisKey?: string } = {},
): Array<{
	id: string;
	op: DeltaOp;
	target: string;
	hypothesisKey: string | null;
	payload: Record<string, unknown>;
	evidence: string[];
	status: string;
	report: GateReport | null;
	proposedBy: string;
}> {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	if (where.target) clauses.push("target = $t"), (params.$t = where.target);
	if (where.status) clauses.push("status = $s"), (params.$s = where.status);
	if (where.hypothesisKey) clauses.push("hypothesis_key = $k"), (params.$k = where.hypothesisKey);
	return s
		.all<Record<string, string>>(
			`SELECT * FROM deltas ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`,
			params,
		)
		.map((r) => ({
			id: r.id,
			op: r.op as DeltaOp,
			target: r.target,
			hypothesisKey: r.hypothesis_key ?? null,
			payload: JSON.parse(r.payload_json),
			evidence: JSON.parse(r.evidence_json),
			status: r.status,
			report: r.gate_report_json ? JSON.parse(r.gate_report_json) : null,
			proposedBy: r.proposed_by,
		}));
}
