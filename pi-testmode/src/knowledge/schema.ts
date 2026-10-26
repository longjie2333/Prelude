/**
 * Template spec (agent-core §7.3) as TypeBox (plan M2-1). Applicability is structured predicates
 * over fingerprint facets so the judge stays deterministic (§7.4); all facet values are strings
 * (booleans as "true"/"false") to avoid unions some providers reject.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const TEMPLATE_TYPES = [
	"strategy",
	"technique",
	"oracle",
	"environment",
	"perception",
	"capability_recipe",
	"meta",
	"pitfall",
] as const;
export const TEMPLATE_STATUSES = ["draft", "candidate", "stable", "deprecated", "retired"] as const;
export const PREDICATE_OPS = ["eq", "ne", "in", "not_in", "contains", "exists", "under"] as const;
export const RISK_TIERS = ["R0", "R1", "R2", "R3", "R4"] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const PredicateSchema = Type.Object({
	facet: Type.String({ description: "Facet name, e.g. state.shared_resource" }),
	op: StringEnum(PREDICATE_OPS),
	value: Type.Optional(Type.String()),
	values: Type.Optional(Type.Array(Type.String())),
});
export type Predicate = Static<typeof PredicateSchema>;

export const ExceptionSchema = Type.Object({
	id: Type.String(),
	when: Type.Array(PredicateSchema, { minItems: 1, description: "All must hold for the exception to fire" }),
	action: StringEnum(["exclude", "patch", "redirect", "require_probe"] as const),
	patch: Type.Optional(Type.Object({ slot: Type.String(), use: Type.String(), note: Type.Optional(Type.String()) })),
	redirect: Type.Optional(Type.String()),
	probe: Type.Optional(Type.String()),
	because: Type.String(),
	source: StringEnum(["experience", "policy", "seed"] as const),
	evidence: Type.Optional(Type.Object({ support: Type.Number(), contradict: Type.Number() })),
});
export type TemplateException = Static<typeof ExceptionSchema>;

export const ApplicabilitySchema = Type.Object({
	hard: Type.Array(PredicateSchema),
	soft: Type.Array(Type.Object({ when: PredicateSchema, weight: Type.Number() })),
	exceptions: Type.Array(ExceptionSchema),
	unknown_handling: Type.Array(Type.Object({ facet: Type.String(), probe: Type.String() })),
});
export type Applicability = Static<typeof ApplicabilitySchema>;

const SlotRef = Type.Object({
	ref: Type.Optional(Type.String({ description: "tpl://… of a slot-level template" })),
	text: Type.Optional(Type.String()),
	cap: Type.Optional(Type.String()),
	strength: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
});

export const TemplateSpecSchema = Type.Object({
	id: Type.String({ pattern: "^tpl://(global|project)/[a-z0-9][a-z0-9._-]*$" }),
	type: StringEnum(TEMPLATE_TYPES),
	card: Type.Object({ title: Type.String({ maxLength: 80 }), summary: Type.String({ maxLength: 240 }) }),
	intent_patterns: Type.Array(Type.String()),
	applicability: ApplicabilitySchema,
	io: Type.Object({ inputs: Type.Array(Type.String()), outputs: Type.Array(Type.String()) }),
	slots: Type.Object({
		model: Type.Optional(SlotRef),
		hypothesis: Type.Optional(Type.String()),
		stimulus: Type.Optional(Type.Object({ generator: Type.Optional(SlotRef), actuator: Type.Optional(SlotRef) })),
		oracle: Type.Optional(SlotRef),
		observation: Type.Optional(Type.Array(Type.String())),
		environment: Type.Optional(SlotRef),
		adequacy: Type.Optional(
			Type.Object({ exploration: Type.Optional(Type.String()), effectiveness: Type.Optional(Type.String()) }),
		),
	}),
	verdict: Type.Object({ fail_when: Type.String(), pass_when: Type.String(), inconclusive_when: Type.String() }),
	control: Type.Object({ max_repair_iterations: Type.Number(), stop_when: Type.Array(Type.String()) }),
	parameters: Type.Array(
		Type.Object({ name: Type.String(), type: Type.String(), default: Type.Optional(Type.String()) }),
	),
	procedure: Type.Array(Type.Object({ step: Type.Number(), do: Type.String(), expect: Type.String() })),
	capabilities_required: Type.Array(
		Type.Object({ cap: Type.String({ pattern: "^cap:[a-z0-9.-]+$" }), constraint: Type.Optional(Type.String()) }),
	),
	evidence_contract: Type.Object({
		required: Type.Array(Type.String()),
		reproducibility_min: Type.Optional(Type.Number()),
	}),
	risk_tier_floor: StringEnum(RISK_TIERS),
	pitfalls: Type.Array(Type.String()),
	recovery: Type.Array(Type.Object({ when: Type.String(), do: Type.String() })),
	composes: Type.Optional(Type.Array(Type.Object({ slot: Type.String(), ref: Type.String() }))),
	specializes: Type.Optional(Type.String()),
});
export type TemplateSpec = Static<typeof TemplateSpecSchema>;

/** Situation fingerprint entry (agent-core §6.3). */
export const FingerprintEntrySchema = Type.Object({
	facet: Type.String(),
	value: Type.Optional(Type.String()),
	values: Type.Optional(Type.Array(Type.String())),
	conf: Type.Number({ minimum: 0, maximum: 1 }),
	src: Type.Optional(Type.String()),
});
export type FingerprintEntry = Static<typeof FingerprintEntrySchema>;

/** Facet name → value(s). `unknown` is represented by absence. */
export type Fingerprint = Record<string, { values: string[]; conf: number; src?: string }>;

export function toFingerprint(entries: readonly FingerprintEntry[]): Fingerprint {
	const fp: Fingerprint = {};
	for (const e of entries) {
		const values = e.values ?? (e.value !== undefined ? [e.value] : []);
		if (values.length === 0 || values.every((v) => v === "unknown")) continue;
		fp[e.facet] = { values, conf: e.conf, src: e.src };
	}
	return fp;
}

export function fingerprintEntries(fp: Fingerprint): FingerprintEntry[] {
	return Object.entries(fp).map(([facet, v]) => ({ facet, values: v.values, conf: v.conf, src: v.src }));
}
