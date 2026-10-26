/**
 * Episodes and template use records (plan M2-9). One episode per scout/executor/verifier mission;
 * `applied`/`cited` are declared in the envelope and checked against what was actually injected.
 */
import { assembleFingerprint, mergeFingerprints, normalizeFingerprint, sutKeyOf } from "../knowledge/fingerprint.ts";
import type { Fingerprint } from "../knowledge/schema.ts";
import {
	getEpisodeByMission,
	getTemplate,
	insertEpisode,
	insertTemplateUse,
	listEpisodes,
	listGaps,
	listRetrievals,
} from "../knowledge/store.ts";
import type { Envelope } from "../missions/envelope.ts";
import type { IntentIR } from "../orchestrator/intent.ts";
import type { Store } from "../store/db.ts";
import { getIntent, listMissions, type MissionRow } from "../store/repos.ts";
import { newId } from "../util.ts";

const EPISODE_ROLES = new Set(["scout", "executor", "verifier"]);

export function recordEpisode(s: Store, m: MissionRow): string | undefined {
	if (!EPISODE_ROLES.has(m.role) || getEpisodeByMission(s, m.id)) return getEpisodeByMission(s, m.id)?.id;
	const intent = getIntent(s, m.intentId);
	const ir = (intent?.ir ?? {}) as Partial<IntentIR>;
	const env = m.envelope as Envelope | null;
	const sutKey = sutKeyOf([...m.spec.targets, ...(ir.sut_refs ?? []).map((r) => r.locator)]);

	// Raw fingerprint: what was known about the SUT (latest scout), what the intent states, and what
	// this mission itself reported (any role may report facets, e.g. when asked to probe one).
	const reported = env?.fingerprint?.length
		? normalizeFingerprint(s, env.fingerprint, { mission: m.id }).raw
		: undefined;
	let fingerprint: Fingerprint;
	if (m.role === "scout") {
		// A scout's observation replaces the previous one; the intent's facets stay authoritative.
		fingerprint = mergeFingerprints(reported, assembleFingerprint(s, { ...ir, sut_refs: [] }).raw);
	} else {
		fingerprint = mergeFingerprints(assembleFingerprint(s, ir).raw, reported);
	}

	const gaps = listGaps(s, { requestedBy: m.id });
	const deviations = [
		...(env?.deviations ?? []),
		...gaps.map((g) => ({
			at: "capability",
			expected: "capability bound by the template",
			observed: `requested ${g.capId}`,
			agent_hypothesis: g.spec.semantics,
		})),
	];
	const id = newId("ep");
	s.tx(() => {
		insertEpisode(s, {
			id,
			missionId: m.id,
			intentId: m.intentId,
			sutKey: sutKey ?? null,
			fingerprint,
			plan: {
				role: m.role,
				templates: (m.spec.templates ?? []).map((t) => ({ id: t.id, version: t.version })),
				capabilities: (m.spec.bindings ?? []).map((b) => b.capId),
			},
			deviations,
			outcome: m.status,
		});
		const injected = new Map((m.spec.templates ?? []).map((t) => [t.id, t.version]));
		const declared = new Map((env?.used_templates ?? []).map((u) => [u.id.replace(/@\d+$/, ""), u.role]));
		for (const [tid, version] of injected) {
			insertTemplateUse(s, {
				episodeId: id,
				templateId: tid,
				version,
				role: declared.get(tid) === "applied" ? "applied" : "cited",
			});
		}
		for (const [tid] of declared) {
			if (injected.has(tid)) continue;
			const t = getTemplate(s, tid);
			if (t) insertTemplateUse(s, { episodeId: id, templateId: tid, version: t.version, role: "cited" });
		}
	});
	return id;
}

/** Retrieved cards that no mission of the intent activated (`retrieved_unused`). */
export function recordRetrievedUnused(s: Store, intentId: string): number {
	const episodes = listEpisodes(s, { intentId });
	const anchor = episodes.find((e) => e.plan.role === "executor") ?? episodes[0];
	if (!anchor) return 0;
	const activated = new Set(listMissions(s, { intentId }).flatMap((m) => (m.spec.templates ?? []).map((t) => t.id)));
	let n = 0;
	for (const r of listRetrievals(s, intentId)) {
		for (const c of r.cards) {
			if (activated.has(c.id)) continue;
			insertTemplateUse(s, { episodeId: anchor.id, templateId: c.id, version: c.version, role: "retrieved_unused" });
			n++;
		}
	}
	return n;
}
