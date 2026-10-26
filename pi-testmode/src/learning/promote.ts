/**
 * Promotion project → global (agent-core §8.5, plan M3-8, decision I-7). The gate here is code;
 * the final step needs the user's confirmation (/test-promote).
 *
 * "≥2 projects" is approximated by ≥2 distinct SUTs among the cornerstones: one project.db cannot
 * see other projects (organisation layer and cross-project evidence are out of scope, plan §11).
 */
import { activeOnly } from "../knowledge/fingerprint.ts";
import { judge } from "../knowledge/applicability.ts";
import { type TemplateSpec, TemplateSpecSchema } from "../knowledge/schema.ts";
import { addEdge, getEpisode, getTemplate, insertTemplate, listCornerstones } from "../knowledge/store.ts";
import type { Store } from "../store/db.ts";
import { audit } from "../store/repos.ts";
import { Value } from "typebox/value";
import { clusterKey } from "./stats.ts";

// Order matters: specific shapes (email, token, URL) before bare hosts.
const SENSITIVE: Array<[RegExp, string]> = [
	[/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
	[/\b(?:sk|pk|ghp|xox[bp])-[A-Za-z0-9_-]{8,}\b/g, "<token>"],
	[/\bhttps?:\/\/[^\s"'`)]+/gi, "<url>"],
	[/\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{2,5})?\b/gi, "<host>"],
	[/\b[a-z0-9.-]+\.(?:com|net|org|io|internal|local|example|cn)\b(?::\d+)?/gi, "<host>"],
	[/\b[A-Fa-f0-9]{32,}\b/g, "<hex>"],
];

export function desensitize(text: string): { text: string; redactions: number } {
	let n = 0;
	let out = text;
	for (const [re, sub] of SENSITIVE) {
		out = out.replace(re, () => {
			n++;
			return sub;
		});
	}
	return { text: out, redactions: n };
}

export interface PromotionCheck {
	ok: boolean;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	spec?: TemplateSpec;
	body?: string;
	globalId?: string;
}

export function promotionGate(s: Store, templateId: string): PromotionCheck {
	const checks: PromotionCheck["checks"] = [];
	const t = getTemplate(s, templateId);
	if (!t || t.layer !== "project")
		return {
			ok: false,
			checks: [{ name: "project template", ok: false, detail: `${templateId} is not a project template` }],
		};
	const cs = listCornerstones(s, templateId).filter((c) => c.exceptionId === null);
	const suts = new Set(cs.map((c) => getEpisode(s, c.episodeId)?.sutKey).filter(Boolean));
	const clusters = new Set(cs.map((c) => clusterKey(t.spec, activeOnly(s, c.fingerprint))));
	checks.push({ name: "status", ok: t.status === "stable", detail: t.status });
	checks.push({ name: "diversity: ≥2 SUTs (projects)", ok: suts.size >= 2, detail: `${suts.size}` });
	checks.push({ name: "diversity: ≥3 clusters", ok: clusters.size >= 3, detail: `${clusters.size}` });

	const specText = desensitize(JSON.stringify(t.spec));
	const body = desensitize(t.body);
	let spec: TemplateSpec | undefined;
	try {
		spec = { ...(JSON.parse(specText.text) as TemplateSpec), id: t.id.replace("tpl://project/", "tpl://global/") };
	} catch {
		spec = undefined;
	}
	checks.push({
		name: "desensitized",
		ok: !!spec && Value.Check(TemplateSpecSchema, spec),
		detail: `${specText.redactions + body.redactions} redaction(s)`,
	});
	checks.push({ name: "id free in global layer", ok: !!spec && !getTemplate(s, spec.id), detail: spec?.id ?? "" });
	if (spec) {
		const changed = listCornerstones(s, templateId).filter((c) => {
			const fp = activeOnly(s, c.fingerprint);
			const a = judge(t.spec.applicability, fp);
			const b = judge((spec as TemplateSpec).applicability, fp);
			return a.result !== b.result || a.exception?.id !== b.exception?.id;
		});
		checks.push({ name: "cornerstone replay", ok: changed.length === 0, detail: `${changed.length} changed` });
	}
	return { ok: checks.every((c) => c.ok), checks, spec, body: body.text, globalId: spec?.id };
}

/** Copies the template to the global layer as a candidate; the project copy keeps shadowing it. */
export function promote(s: Store, templateId: string, check: PromotionCheck): string {
	if (!check.ok || !check.spec || !check.globalId) throw new Error("promotion gate not passed");
	const spec = check.spec;
	s.tx(() => {
		insertTemplate(s, spec, check.body ?? "", { status: "candidate", changelog: `promoted from ${templateId}` });
		addEdge(s, "global", spec.id, templateId, "derived_from");
		addEdge(s, "project", templateId, spec.id, "overrides");
		audit(s, { actor: "main", event: "promote", decision: "candidate", reason: `${templateId} → ${spec.id}` });
	});
	return spec.id;
}
