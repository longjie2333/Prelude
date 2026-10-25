/** /test-kb and /test-why (plan M3-10): read-only views of the knowledge base. */
import { activeOnly } from "../knowledge/fingerprint.ts";
import { describePredicate, judge } from "../knowledge/applicability.ts";
import { getTemplate, listCornerstones, listEpisodes, listTemplates } from "../knowledge/store.ts";
import type { Store } from "../store/db.ts";
import { listDeltas } from "./gate.ts";
import { aggregate, exceptionSupport, getStats, lowerBound, posteriorMean } from "./stats.ts";

export function renderKb(s: Store): string {
	const lines = ["Templates (layer · status · version · posterior mean / lower bound · exceptions):"];
	for (const t of listTemplates(s)) {
		const { alpha, beta } = aggregate(getStats(s, t.id));
		const ex = t.spec.applicability.exceptions.map((e) => `${e.id}(+${exceptionSupport(s, t.id, e.id).support})`);
		lines.push(
			`- ${t.id}@${t.version} · ${t.layer} · ${t.status}${t.seed ? " · seed" : ""} · ${posteriorMean(alpha, beta).toFixed(2)}/${lowerBound(alpha, beta).toFixed(2)} · ${ex.join(", ") || "no exceptions"}`,
		);
	}
	const open = listDeltas(s, { status: "suspended" });
	if (open.length) {
		lines.push("", "Open hypotheses:");
		for (const d of open) lines.push(`- ${d.id} ${d.op} on ${d.target}: ${d.evidence.length} observation(s)`);
	}
	return lines.join("\n");
}

export function renderWhy(s: Store, templateId: string): string {
	const t = getTemplate(s, templateId);
	if (!t) return `unknown template ${templateId}`;
	const latest = listEpisodes(s, {}).at(-1);
	const lines = [`${t.id}@${t.version} (${t.status})`, `hard: ${t.spec.applicability.hard.map(describePredicate).join(" ∧ ") || "none"}`];
	for (const e of t.spec.applicability.exceptions) lines.push(`exception ${e.id}: if ${e.when.map(describePredicate).join(" ∧ ")} then ${e.action}${e.patch ? ` ${e.patch.slot}→${e.patch.use}` : ""} — ${e.because}`);
	if (latest) {
		const j = judge(t.spec.applicability, activeOnly(s, latest.fingerprint));
		lines.push("", `Latest fingerprint (${latest.id}): ${j.result}${j.exception ? ` with exception ${j.exception.id}` : ""}`, ...j.reasons.map((r) => `  - ${r}`));
		if (j.unknown.length) lines.push(`  unknown: ${j.unknown.join(", ")}`);
	}
	lines.push("", "Statistics by cluster:");
	for (const r of getStats(s, t.id)) lines.push(`  ${r.clusterKey}: Beta(${r.alpha.toFixed(1)}, ${r.beta.toFixed(1)})`);
	lines.push("", `Cornerstones: ${listCornerstones(s, t.id).map((c) => `${c.episodeId}${c.exceptionId ? `[${c.exceptionId}]` : ""}`).join(", ") || "none"}`);
	lines.push("", "History:");
	for (let v = 1; v <= t.version; v++) {
		const r = s.get<{ changelog: string; created_at: string }>(`SELECT changelog, created_at FROM ${t.layer === "global" ? "g" : "main"}.template_versions WHERE template_id = $t AND version = $v`, { $t: t.id, $v: v });
		if (r) lines.push(`  v${v} ${r.created_at.slice(0, 19)} ${r.changelog}`);
	}
	for (const d of listDeltas(s, { target: t.id })) lines.push(`  delta ${d.id} ${d.op}: ${d.status}`);
	return lines.join("\n");
}
