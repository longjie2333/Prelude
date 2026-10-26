/**
 * D2 disclosure (plan M2-5): the activated template body, its procedure with `expect` for
 * deviation detection, and the names of bound capabilities — rendered into a mission's
 * `template` prompt section. Capability bodies (D3) stay in their Skill files.
 */
import type { CapabilityBinding } from "../capabilities/registry.ts";
import type { TemplateException } from "./schema.ts";
import type { TemplateRecord } from "./store.ts";

export interface ActivatedTemplate {
	template: TemplateRecord;
	/** Exception that fired for this mission's fingerprint (patch/require_probe). */
	exception?: TemplateException;
	params?: Record<string, string>;
}

function fill(text: string, params: Record<string, string>): string {
	return text.replace(/\{\{\s*p\.([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => params[k] ?? m);
}

export function renderTemplate(a: ActivatedTemplate): string {
	const { spec, body, version } = a.template;
	const params = {
		...Object.fromEntries(
			spec.parameters.filter((p) => p.default !== undefined).map((p) => [p.name, p.default as string]),
		),
		...a.params,
	};
	const out: string[] = [
		`## ${spec.card.title} (${spec.id}@${version}, ${spec.type}, ${a.template.status})`,
		spec.card.summary,
	];
	const s = spec.slots;
	if (s.hypothesis) out.push(`Hypothesis: ${s.hypothesis}`);
	if (s.stimulus?.generator)
		out.push(
			`Stimulus: ${s.stimulus.generator.text ?? s.stimulus.generator.ref ?? ""}${s.stimulus.actuator?.cap ? ` via ${s.stimulus.actuator.cap}` : ""}`,
		);
	if (s.oracle) out.push(`Oracle (${s.oracle.strength ?? "?"}): ${s.oracle.text ?? s.oracle.ref ?? ""}`);
	if (s.observation?.length) out.push(`Observe: ${s.observation.join(", ")}`);
	if (spec.procedure.length) {
		out.push("Procedure (report any step whose observation differs from `expect` as a deviation):");
		for (const p of spec.procedure)
			out.push(`  ${p.step}. ${fill(p.do, params)} — expect: ${fill(p.expect, params)}`);
	}
	out.push(
		`Verdict: fail when ${spec.verdict.fail_when}; pass when ${spec.verdict.pass_when}; inconclusive when ${spec.verdict.inconclusive_when}.`,
	);
	if (spec.evidence_contract.required.length)
		out.push(`Required evidence: ${spec.evidence_contract.required.join(", ")}`);
	if (spec.pitfalls.length) out.push(`Pitfalls: ${spec.pitfalls.join("; ")}`);
	for (const r of spec.recovery) out.push(`If ${r.when}: ${r.do}`);
	if (a.exception) {
		const ex = a.exception;
		const what =
			ex.action === "patch" && ex.patch
				? `replace the ${ex.patch.slot} with "${ex.patch.use}"${ex.patch.note ? ` (${ex.patch.note})` : ""}`
				: ex.action === "require_probe"
					? `run the probe ${ex.probe ?? ""} first`
					: ex.action;
		out.push(`EXCEPTION ${ex.id} applies here: ${what}. Because: ${ex.because}`);
	}
	if (Object.keys(params).length)
		out.push(
			`Parameters: ${Object.entries(params)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")}`,
		);
	out.push("", fill(body, params));
	return out.join("\n");
}

export function renderTemplatesSection(
	templates: readonly ActivatedTemplate[],
	bindings: readonly CapabilityBinding[],
	unbound: readonly string[],
): string | undefined {
	if (templates.length === 0 && bindings.length === 0 && unbound.length === 0) return undefined;
	const out = ["<template>"];
	for (const t of templates) out.push(renderTemplate(t), "");
	if (bindings.length || unbound.length) {
		out.push("Bound capabilities (read the skill's SKILL.md before first use):");
		for (const b of bindings) out.push(`  - ${b.capId} → skill ${b.name}@${b.version} (${b.sha256.slice(0, 8)})`);
		for (const u of unbound) out.push(`  - ${u} → NOT AVAILABLE; work around it or use capability_request`);
	}
	if (templates.length)
		out.push(
			"List the templates you followed in mission_submit.used_templates (applied, or cited if you only borrowed from them).",
		);
	out.push("</template>");
	return out.join("\n");
}
