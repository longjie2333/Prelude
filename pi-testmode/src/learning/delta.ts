/**
 * Template deltas (agent-core §10.7, plan M3-5): every knowledge change is a structured increment
 * applied by code. There is no operator that replaces `spec_json` wholesale; `revise` may touch
 * only whitelisted content paths, never applicability.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { ExceptionSchema, PredicateSchema, type TemplateException, type TemplateSpec, type TemplateStatus } from "../knowledge/schema.ts";

export const DELTA_OPS = ["reinforce", "generalize", "except", "narrow", "specialize", "revise", "pitfall", "deprecate", "rebind", "facet.propose"] as const;
export type DeltaOp = (typeof DELTA_OPS)[number];

/** Which evidence threshold applies (gate check 3). */
export const OP_KIND: Record<DeltaOp, "boundary" | "content" | "none"> = {
	reinforce: "none",
	generalize: "boundary",
	except: "boundary",
	narrow: "boundary",
	specialize: "boundary",
	revise: "content",
	pitfall: "content",
	deprecate: "content",
	rebind: "none",
	"facet.propose": "none",
};

/** Ops that change applicability: cornerstone replay must keep every verdict. */
export const CHANGES_APPLICABILITY = new Set<DeltaOp>(["generalize", "except", "narrow"]);

export const REVISABLE_PATHS = [
	"card.summary",
	"slots.hypothesis",
	"slots.oracle.text",
	"slots.stimulus.generator.text",
	"slots.observation",
	"procedure",
	"verdict",
	"recovery",
	"parameters",
	"body",
] as const;

const GeneralizePayload = Type.Object({ facet: Type.String(), from: Type.Array(Type.String()), to: Type.String({ description: "Parent value in the facet hierarchy" }) });
const NarrowPayload = Type.Object({ facet: Type.String(), exception_ids: Type.Array(Type.String(), { minItems: 1 }), hard: PredicateSchema });
const SpecializePayload = Type.Object({ exception_id: Type.String(), child_id: Type.String({ pattern: "^tpl://project/[a-z0-9][a-z0-9._-]*$" }) });
const RevisePayload = Type.Object({ path: StringEnum(REVISABLE_PATHS), value: Type.Unknown(), reason: Type.String() });
const PitfallPayload = Type.Object({ text: Type.String({ maxLength: 400 }) });
const DeprecatePayload = Type.Object({ reason: Type.String(), replaced_by: Type.Optional(Type.String()) });

export const PayloadSchemas: Record<DeltaOp, TSchema> = {
	reinforce: Type.Object({ episode_id: Type.String() }),
	generalize: GeneralizePayload,
	except: Type.Object({ exception: ExceptionSchema }),
	narrow: NarrowPayload,
	specialize: SpecializePayload,
	revise: RevisePayload,
	pitfall: PitfallPayload,
	deprecate: DeprecatePayload,
	rebind: Type.Object({ cap: Type.String(), from_sha: Type.String(), to_sha: Type.String() }),
	"facet.propose": Type.Object({ facet: Type.String(), values: Type.Array(Type.String()), failure_value: Type.String(), cornerstone_value: Type.String() }),
};

export type ExceptPayload = { exception: TemplateException };

export interface Applied {
	spec: TemplateSpec;
	body?: string;
	status?: TemplateStatus;
	edges?: Array<{ src: string; dst: string; kind: "redirects_to" | "specializes" | "derived_from" }>;
}

function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x));
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let cur = obj;
	for (const k of keys.slice(0, -1)) {
		if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
		cur = cur[k] as Record<string, unknown>;
	}
	cur[keys.at(-1) as string] = value;
}

/** Pure: the spec after applying the delta. Throws when the payload does not fit the spec. */
export function applyDelta(spec: TemplateSpec, body: string, op: DeltaOp, payload: Record<string, unknown>): Applied {
	const next = clone(spec);
	const app = next.applicability;
	switch (op) {
		case "reinforce":
		case "rebind":
		case "facet.propose":
			return { spec: next };
		case "generalize": {
			const p = payload as Static<typeof GeneralizePayload>;
			const pred = app.hard.find((h) => h.facet === p.facet);
			if (!pred) throw new Error(`no hard condition on ${p.facet} to generalize`);
			const have = pred.values ?? (pred.value !== undefined ? [pred.value] : []);
			if (!p.from.every((v) => have.includes(v))) throw new Error(`hard condition on ${p.facet} does not list ${p.from.join(", ")}`);
			pred.op = "in";
			pred.values = [...have.filter((v) => !p.from.includes(v)), p.to];
			delete pred.value;
			return { spec: next };
		}
		case "except": {
			const ex = (payload as ExceptPayload).exception;
			if (app.exceptions.some((e) => e.id === ex.id)) throw new Error(`exception ${ex.id} exists`);
			// Appended last: a delta cannot jump the order of existing exceptions (no severity boost).
			app.exceptions.push(ex);
			return { spec: next, edges: ex.action === "redirect" && ex.redirect ? [{ src: spec.id, dst: ex.redirect, kind: "redirects_to" }] : [] };
		}
		case "narrow": {
			const p = payload as Static<typeof NarrowPayload>;
			const folded = new Set(p.exception_ids);
			if (!p.exception_ids.every((id) => app.exceptions.some((e) => e.id === id))) throw new Error("narrow folds unknown exceptions");
			if (p.hard.facet !== p.facet) throw new Error("narrow must fold into a condition on the same facet");
			app.exceptions = app.exceptions.filter((e) => !folded.has(e.id));
			app.hard.push(p.hard);
			return { spec: next };
		}
		case "specialize": {
			const p = payload as Static<typeof SpecializePayload>;
			const ex = app.exceptions.find((e) => e.id === p.exception_id);
			if (!ex) throw new Error(`unknown exception ${p.exception_id}`);
			ex.action = "redirect";
			ex.redirect = p.child_id;
			return { spec: next, edges: [{ src: spec.id, dst: p.child_id, kind: "redirects_to" }, { src: p.child_id, dst: spec.id, kind: "specializes" }] };
		}
		case "revise": {
			const p = payload as Static<typeof RevisePayload>;
			if (p.path === "body") {
				if (typeof p.value !== "string") throw new Error("body must be a string");
				return { spec: next, body: p.value };
			}
			setPath(next as unknown as Record<string, unknown>, p.path, p.value);
			return { spec: next };
		}
		case "pitfall": {
			const p = payload as Static<typeof PitfallPayload>;
			next.pitfalls = [...next.pitfalls, p.text];
			return { spec: next };
		}
		case "deprecate":
		{
			const p = payload as Static<typeof DeprecatePayload>;
			return { spec: next, status: "deprecated", edges: p.replaced_by ? [{ src: spec.id, dst: p.replaced_by, kind: "redirects_to" }] : [] };
		}
	}
	void body;
	throw new Error(`unknown op ${op}`);
}
