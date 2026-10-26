/**
 * Curator: from exploration to template (agent-core §10.10, plan M2-8). The model proposes the
 * method; code fixes the parts that must not be learned freely:
 * - the initial boundary is the cornerstone fingerprint's discriminative facets ("born narrow"),
 * - capabilities come from what the missions actually bound,
 * - the template is a project-layer `draft`, and its cornerstone must satisfy it.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { MissionToolHost } from "../harness/tools.ts";
import { judge } from "../knowledge/applicability.ts";
import {
	type Fingerprint,
	type Predicate,
	PredicateSchema,
	TEMPLATE_TYPES,
	type TemplateSpec,
	TemplateSpecSchema,
} from "../knowledge/schema.ts";
import { addEdge, getEpisode, getTemplate, insertCornerstone, insertTemplate } from "../knowledge/store.ts";
import { audit } from "../store/repos.ts";
import { bumpStats, clusterKey } from "./stats.ts";
import type { RiskTier } from "../types.ts";
import { textResult } from "../util.ts";
import { Value } from "typebox/value";

/**
 * Facets that describe *what* the SUT is; the boundary is born on these (not env, goal, or the
 * resource kind, which only splits statistics into clusters). `consistency.model` counts once it
 * has been discovered and activated (M3).
 */
export const DISCRIMINATIVE_FACETS = [
	"sut.kind",
	"interface.protocol",
	"state.shared_resource",
	"sut.stack",
	"spec.format",
	"interface.pagination",
	"consistency.model",
] as const;
const HIERARCHICAL = new Set(["interface.protocol", "sut.stack"]);

export interface CurateInput {
	episodeIds: string[];
	fingerprint: Fingerprint;
	capabilities: string[];
	riskFloor: RiskTier;
	evidenceKinds: string[];
	/** Human-readable digest of the episode for the curator prompt. */
	digest: string;
}

export function deriveHardBoundary(fp: Fingerprint, minConf = 0.5): Predicate[] {
	const out: Predicate[] = [];
	for (const facet of DISCRIMINATIVE_FACETS) {
		const v = fp[facet];
		if (!v || v.conf < minConf || v.values.length === 0) continue;
		if (v.values.length === 1)
			out.push(
				HIERARCHICAL.has(facet) ? { facet, op: "in", values: v.values } : { facet, op: "eq", value: v.values[0] },
			);
		else out.push({ facet, op: "contains", values: v.values });
	}
	return out;
}

export const TemplateDraftSchema = Type.Object({
	name: Type.String({
		pattern: "^[a-z0-9][a-z0-9._-]*$",
		description: "Dotted name, e.g. concurrency.resource-contention.invariant",
	}),
	type: StringEnum(TEMPLATE_TYPES),
	card: Type.Object({ title: Type.String({ maxLength: 80 }), summary: Type.String({ maxLength: 240 }) }),
	intent_patterns: Type.Array(Type.String(), {
		minItems: 1,
		description: "Short phrases users say for this kind of test (any language)",
	}),
	hypothesis: Type.Optional(Type.String()),
	stimulus: Type.Optional(Type.String()),
	oracle: Type.Object({ text: Type.String(), strength: StringEnum(["low", "medium", "high"] as const) }),
	observation: Type.Optional(Type.Array(Type.String())),
	procedure: Type.Array(
		Type.Object({
			do: Type.String(),
			expect: Type.String({ description: "Expected *process* observation, never an oracle value" }),
		}),
		{ minItems: 1 },
	),
	verdict: Type.Object({ fail_when: Type.String(), pass_when: Type.String(), inconclusive_when: Type.String() }),
	soft: Type.Optional(Type.Array(Type.Object({ when: PredicateSchema, weight: Type.Number() }))),
	hard_extra: Type.Optional(
		Type.Array(PredicateSchema, { description: "Extra hard conditions; each must hold for the cornerstone" }),
	),
	composes: Type.Optional(Type.Array(Type.Object({ slot: Type.String(), ref: Type.String() }))),
	parameters: Type.Optional(
		Type.Array(Type.Object({ name: Type.String(), type: Type.String(), default: Type.Optional(Type.String()) })),
	),
	pitfalls: Type.Optional(Type.Array(Type.String())),
	recovery: Type.Optional(Type.Array(Type.Object({ when: Type.String(), do: Type.String() }))),
	body: Type.String({ maxLength: 8000, description: "Why this works, key judgement points, common variants" }),
});
export type TemplateDraft = Static<typeof TemplateDraftSchema>;

export function buildSpec(draft: TemplateDraft, curate: CurateInput): { spec: TemplateSpec; rejected: string[] } {
	const rejected: string[] = [];
	const hard = deriveHardBoundary(curate.fingerprint);
	for (const p of draft.hard_extra ?? []) {
		const r = judge({ hard: [p], soft: [], exceptions: [], unknown_handling: [] }, curate.fingerprint).result;
		if (r === "true" && !hard.some((h) => h.facet === p.facet)) hard.push(p);
		else if (r !== "true")
			rejected.push(`hard_extra ${p.facet} ${p.op} does not hold for the cornerstone (${r}); dropped`);
	}
	const required = ["run_log", ...curate.evidenceKinds];
	const spec: TemplateSpec = {
		id: `tpl://project/${draft.name}`,
		type: draft.type,
		card: draft.card,
		intent_patterns: draft.intent_patterns,
		applicability: { hard, soft: draft.soft ?? [], exceptions: [], unknown_handling: [] },
		io: { inputs: [], outputs: [] },
		slots: {
			hypothesis: draft.hypothesis,
			stimulus: draft.stimulus ? { generator: { text: draft.stimulus } } : undefined,
			oracle: {
				text: draft.oracle.text,
				strength: draft.oracle.strength,
				ref: draft.composes?.find((c) => c.slot === "oracle")?.ref,
			},
			observation: draft.observation,
		},
		verdict: draft.verdict,
		control: { max_repair_iterations: 3, stop_when: ["verdict_reached", "budget_exhausted"] },
		parameters: draft.parameters ?? [],
		procedure: draft.procedure.map((p, i) => ({ step: i + 1, do: p.do, expect: p.expect })),
		capabilities_required: [...new Set(curate.capabilities)].map((cap) => ({ cap })),
		evidence_contract: { required: [...new Set(required)] },
		risk_tier_floor: curate.riskFloor,
		pitfalls: draft.pitfalls ?? [],
		recovery: draft.recovery ?? [],
		composes: draft.composes,
	};
	return { spec, rejected };
}

export function createTemplateProposeTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "template_propose",
		label: "Propose Template",
		description:
			"Propose a draft template distilled from the episode. Its initial applicability boundary and required capabilities are derived from the episode by the kernel; you supply the method.",
		promptSnippet: "Propose a draft template distilled from the episode",
		parameters: TemplateDraftSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const curate = host.spec.curate;
			if (!curate) throw new Error("template_propose is only available to curator missions");
			const { spec, rejected } = buildSpec(params, curate);
			if (!Value.Check(TemplateSpecSchema, spec)) {
				const first = [...Value.Errors(TemplateSpecSchema, spec)][0];
				throw new Error(`draft does not form a valid template: ${first?.instancePath} ${first?.message}`);
			}
			if (getTemplate(host.store, spec.id))
				throw new Error(`${spec.id} already exists; refine existing templates through deltas, not new drafts`);
			for (const c of spec.composes ?? [])
				if (!getTemplate(host.store, c.ref)) throw new Error(`composes ref ${c.ref} does not exist`);
			if (judge(spec.applicability, curate.fingerprint).result !== "true")
				throw new Error("the draft's boundary excludes its own cornerstone episode");

			const { store } = host;
			store.tx(() => {
				insertTemplate(store, spec, params.body, {
					status: "draft",
					changelog: `drafted by ${host.missionId} from intent ${host.spec.intentId}`,
				});
				addEdge(store, "project", spec.id, `intent:${host.spec.intentId}`, "derived_from", {
					mission: host.missionId,
				});
				// The founding episode is the template's first success (weak prior plus one).
				bumpStats(store, spec.id, clusterKey(spec, curate.fingerprint), 1, 0);
				// Cornerstones keep the raw fingerprint, so facets activated later can still tell them apart.
				for (const episodeId of curate.episodeIds) {
					insertCornerstone(store, {
						templateId: spec.id,
						episodeId,
						fingerprint: getEpisode(store, episodeId)?.fingerprint ?? curate.fingerprint,
					});
				}
				audit(store, {
					actor: `mission:${host.missionId}`,
					event: "template_propose",
					decision: "draft",
					reason: `${spec.id}: hard=[${spec.applicability.hard.map((h) => h.facet).join(", ")}]`,
				});
			});
			const note = rejected.length ? `\n${rejected.join("\n")}` : "";
			return textResult(
				`Draft ${spec.id}@1 recorded (boundary: ${spec.applicability.hard.map((h) => `${h.facet} ${h.op} ${h.value ?? h.values?.join("|")}`).join(" ∧ ") || "none"}).${note}`,
				{ id: spec.id },
			);
		},
	});
}
