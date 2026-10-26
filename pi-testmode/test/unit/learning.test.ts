import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fingerprint, type TemplateSpec, toFingerprint } from "../../src/knowledge/schema.ts";
import { SEED_TEMPLATES } from "../../src/knowledge/seeds/index.ts";
import {
	activateFacet,
	addTemplateVersion,
	getTemplate,
	insertCornerstone,
	insertEpisode,
	insertTemplate,
	insertTemplateUse,
	proposeFacet,
	seedKnowledge,
} from "../../src/knowledge/store.ts";
import { proposeFacetHypothesis } from "../../src/learning/attributor.ts";
import { insertCalibrationRun, isLearningPaused, latestCalibration } from "../../src/learning/calibration.ts";
import {
	feedbackEpisodeIds,
	hasFeedback,
	insertFeedback,
	isUnresolvedFailure,
	positiveTemplateUses,
} from "../../src/learning/feedback.ts";
import { applyDelta } from "../../src/learning/delta.ts";
import { garden, similarity } from "../../src/learning/gardener.ts";
import {
	ensureProjectOverride,
	insertDelta,
	listDeltas,
	markDeltaCommitted,
	proposeDelta,
	setDeltaEvidence,
} from "../../src/learning/gate.ts";
import { renderWhy } from "../../src/learning/inspect.ts";
import { nextStatus } from "../../src/learning/lifecycle.ts";
import { desensitize } from "../../src/learning/promote.ts";
import { aggregate, bumpStats, clusterKey, getStats, lowerBound } from "../../src/learning/stats.ts";
import { contrastSet } from "../../src/learning/triage.ts";
import { insertIntent, insertMission, isIntentLearned, markIntentLearned } from "../../src/store/repos.ts";
import { type TempProject, tempProject } from "../helpers.ts";

const fp = (o: Record<string, string>): Fingerprint =>
	toFingerprint(Object.entries(o).map(([facet, value]) => ({ facet, value, conf: 1 })));

let p: TempProject;
beforeEach(() => {
	p = tempProject();
	seedKnowledge(p.store);
});
afterEach(() => p.cleanup());

function strategy(id = "tpl://project/oversell"): TemplateSpec {
	const seed = SEED_TEMPLATES[1].spec;
	return {
		...seed,
		id,
		type: "strategy",
		card: { title: "Oversell", summary: "s" },
		intent_patterns: ["超卖"],
		applicability: {
			hard: [{ facet: "sut.kind", op: "eq", value: "rest-api" }],
			soft: [],
			exceptions: [],
			unknown_handling: [],
		},
	};
}

let n = 0;
function episode(fingerprint: Fingerprint): string {
	const i = `i-${++n}`;
	const m = `m-${n}`;
	insertIntent(p.store, i, "r", {});
	insertMission(
		p.store,
		{
			missionId: m,
			intentId: i,
			role: "executor",
			objective: "o",
			targets: [],
			testKinds: [],
			riskTier: "R2",
			riskReasons: [],
			budget: { tokens: 1, wallClockMs: 1 },
		},
		join(p.paths.runsDir, m),
	);
	const id = `ep-${n}`;
	insertEpisode(p.store, {
		id,
		missionId: m,
		intentId: i,
		sutKey: "localhost:1",
		fingerprint,
		plan: { role: "executor", templates: [], capabilities: [] },
		deviations: [],
		outcome: "completed",
	});
	return id;
}

describe("statistics", () => {
	it("keys clusters on the template's facets plus the clustering facets", () => {
		const s = strategy();
		expect(clusterKey(s, fp({ "sut.kind": "rest-api", "state.resource_kind": "quota", "env.kind": "local" }))).toBe(
			"state.resource_kind=quota|sut.kind=rest-api",
		);
	});

	it("aggregates in-domain rows only and computes a conservative lower bound", () => {
		bumpStats(p.store, "t", "a", 3, 0);
		bumpStats(p.store, "t", "b", 1, 0);
		bumpStats(p.store, "t", "exception:ex-1", 5, 0);
		expect(aggregate(getStats(p.store, "t"))).toEqual({ alpha: 5, beta: 1 });
		expect(lowerBound(5, 1)).toBeGreaterThan(0.55);
		expect(lowerBound(4, 1)).toBeLessThan(0.55);
		expect(lowerBound(1, 1)).toBeLessThan(0.1);
	});
});

describe("contrast set (B vs K)", () => {
	const cs = [
		fp({ "sut.kind": "rest-api", "consistency.model": "sync" }),
		fp({ "sut.kind": "rest-api", "consistency.model": "sync" }),
	];
	it("finds the smallest separating facet", () => {
		const r = contrastSet(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" }), cs);
		expect(r.contrast?.facets).toEqual([{ facet: "consistency.model", values: ["eventual"] }]);
	});
	it("returns nothing when no known facet separates them, listing unknowns", () => {
		const r = contrastSet(fp({ "sut.kind": "rest-api" }), cs);
		expect(r.contrast).toBeUndefined();
		expect(r.unknown).toContain("consistency.model");
	});
});

describe("delta operators", () => {
	it("are incremental and refuse ill-fitting payloads", () => {
		const s = strategy();
		const ex = applyDelta(s, "b", "except", {
			exception: {
				id: "ex-1",
				when: [{ facet: "consistency.model", op: "eq", value: "eventual" }],
				action: "exclude",
				because: "x",
				source: "experience",
			},
		});
		expect(ex.spec.applicability.exceptions.map((e) => e.id)).toEqual(["ex-1"]);
		expect(s.applicability.exceptions).toHaveLength(0); // input untouched
		expect(() =>
			applyDelta(ex.spec, "b", "except", {
				exception: { id: "ex-1", when: [], action: "exclude", because: "", source: "experience" },
			}),
		).toThrow(/exists/);
		const rev = applyDelta(s, "b", "revise", { path: "slots.oracle.text", value: "settle first", reason: "r" });
		expect(rev.spec.slots.oracle?.text).toBe("settle first");
		expect(rev.spec.applicability).toEqual(s.applicability);
		const nar = applyDelta(ex.spec, "b", "narrow", {
			facet: "consistency.model",
			exception_ids: ["ex-1"],
			hard: { facet: "consistency.model", op: "not_in", values: ["eventual"] },
		});
		expect(nar.spec.applicability.exceptions).toHaveLength(0);
		expect(nar.spec.applicability.hard.at(-1)?.facet).toBe("consistency.model");
		const gen = applyDelta(
			{
				...s,
				applicability: { ...s.applicability, hard: [{ facet: "sut.stack", op: "in", values: ["node/express"] }] },
			},
			"b",
			"generalize",
			{ facet: "sut.stack", from: ["node/express"], to: "node" },
		);
		expect(gen.spec.applicability.hard[0].values).toEqual(["node"]);
	});
});

describe("gate", () => {
	function withCornerstones(): { id: string; eps: string[] } {
		const t = insertTemplate(p.store, strategy(), "b", { status: "candidate", changelog: "t" });
		activateFacet(p.store, "consistency.model");
		proposeFacet(p.store, "consistency.model", ["sync"], {});
		activateFacet(p.store, "consistency.model");
		const eps = [1, 2, 3].map(() => episode(fp({ "sut.kind": "rest-api", "consistency.model": "sync" })));
		for (const e of eps)
			insertCornerstone(p.store, {
				templateId: t.id,
				episodeId: e,
				fingerprint: fp({ "sut.kind": "rest-api", "consistency.model": "sync" }),
			});
		return { id: t.id, eps };
	}
	const exception = (when: Record<string, string>, id = "ex-a") => ({
		exception: {
			id,
			when: Object.entries(when).map(([facet, value]) => ({ facet, op: "eq" as const, value })),
			action: "exclude" as const,
			because: "b",
			source: "experience" as const,
		},
	});

	it("commits a boundary delta that keeps every cornerstone verdict, with enough evidence", () => {
		const { id } = withCornerstones();
		const ev = [
			episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" })),
			episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" })),
		];
		const r = proposeDelta(p.store, {
			op: "except",
			target: id,
			payload: exception({ "consistency.model": "eventual" }),
			evidence: ev,
			proposedBy: "test",
		});
		expect(r.report.decision).toBe("committed");
		expect(r.report.replay.every((x) => x.ok)).toBe(true);
		expect(getTemplate(p.store, id)?.version).toBe(2);
	});

	it("re-gates a suspended hypothesis once evidence accumulates", () => {
		const { id } = withCornerstones();
		const e1 = episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" }));
		const first = proposeDelta(p.store, {
			op: "except",
			target: id,
			payload: exception({ "consistency.model": "eventual" }),
			evidence: [e1],
			proposedBy: "test",
		});
		expect(first.report.decision).toBe("suspended");
		const e2 = episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" }));
		const again = proposeDelta(p.store, {
			op: "except",
			target: id,
			payload: exception({ "consistency.model": "eventual" }),
			evidence: [e1, e2],
			proposedBy: "test",
			deltaId: first.id,
		});
		expect(again).toMatchObject({ id: first.id, report: { decision: "committed" } });
		expect(listDeltas(p.store, { status: "committed" }).map((d) => d.id)).toEqual([first.id]);
	});

	it("suspends below the evidence threshold (stable templates need more)", () => {
		const { id } = withCornerstones();
		const ev = [episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" }))];
		expect(
			proposeDelta(p.store, {
				op: "except",
				target: id,
				payload: exception({ "consistency.model": "eventual" }),
				evidence: ev,
				proposedBy: "test",
			}).report,
		).toMatchObject({ decision: "suspended", evidence: { have: 1, need: 2 } });
	});

	it("rejects a delta that changes a cornerstone verdict, with the replay report", () => {
		const { id, eps } = withCornerstones();
		const r = proposeDelta(p.store, {
			op: "except",
			target: id,
			payload: exception({ "sut.kind": "rest-api" }, "ex-bad"),
			evidence: eps,
			proposedBy: "test",
		});
		expect(r.report.decision).toBe("rejected");
		expect(r.report.replay.filter((x) => !x.ok)).toHaveLength(3);
		expect(r.report.replay[0]).toMatchObject({ before: "true", after: "false/ex-bad" });
		expect(getTemplate(p.store, id)?.version).toBe(1);
		expect(listDeltas(p.store, { status: "rejected" })).toHaveLength(1);
	});

	it("rejects severity fields, oversized payloads, and unresolved references", () => {
		const { id, eps } = withCornerstones();
		expect(
			proposeDelta(p.store, {
				op: "pitfall",
				target: id,
				payload: { text: "x", severity: "critical" },
				evidence: eps,
				proposedBy: "t",
			}).report.decision,
		).toBe("rejected");
		expect(
			proposeDelta(p.store, {
				op: "pitfall",
				target: id,
				payload: { text: "x".repeat(5000) },
				evidence: eps,
				proposedBy: "t",
			}).report.decision,
		).toBe("rejected");
		const patch = {
			exception: {
				...exception({ "consistency.model": "eventual" }).exception,
				action: "patch" as const,
				patch: { slot: "oracle", use: "tpl://project/missing" },
			},
		};
		const ev = [
			episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" })),
			episode(fp({ "sut.kind": "rest-api", "consistency.model": "eventual" })),
		];
		expect(
			proposeDelta(p.store, {
				op: "except",
				target: id,
				payload: patch,
				evidence: ev,
				proposedBy: "t",
			}).report.checks.find((c) => c.name === "references resolve")?.ok,
		).toBe(false);
	});

	it("never edits a global template: changes go to a project override", () => {
		const target = ensureProjectOverride(p.store, "tpl://global/oracle.conservation-invariant");
		expect(target).toBe("tpl://project/oracle.conservation-invariant");
		expect(ensureProjectOverride(p.store, "tpl://global/oracle.conservation-invariant")).toBe(target);
		expect(getTemplate(p.store, "tpl://global/oracle.conservation-invariant")?.version).toBe(1);
	});
});

describe("state machine", () => {
	it("candidate → stable needs ≥3 cornerstones over ≥2 clusters and a high lower bound", () => {
		const t = insertTemplate(p.store, strategy(), "b", { status: "candidate", changelog: "t" });
		for (const k of ["inventory", "inventory", "quota"]) {
			const f = fp({ "sut.kind": "rest-api", "state.resource_kind": k });
			insertCornerstone(p.store, { templateId: t.id, episodeId: episode(f), fingerprint: f });
		}
		bumpStats(p.store, t.id, "a", 3, 0);
		expect(nextStatus(p.store, t.id)).toBeUndefined(); // lower bound of Beta(4,1) is below θ
		bumpStats(p.store, t.id, "b", 1, 0);
		expect(nextStatus(p.store, t.id)).toMatchObject({ from: "candidate", to: "stable" });
	});

	it("stable → deprecated when the escape hatch triggers", () => {
		const s = strategy();
		s.applicability.exceptions = Array.from({ length: 9 }, (_, i) => ({
			id: `ex-${i}`,
			when: [{ facet: "sut.stack", op: "eq" as const, value: `v${i}` }],
			action: "exclude" as const,
			because: "b",
			source: "experience" as const,
		}));
		const t = insertTemplate(p.store, s, "b", { status: "stable", changelog: "t" });
		expect(nextStatus(p.store, t.id)).toMatchObject({ to: "deprecated" });
	});
});

describe("attributor", () => {
	const input = {
		failure: fp({ "sut.kind": "rest-api" }),
		cornerstones: [fp({ "sut.kind": "rest-api" })],
		deviations: [],
		knownFacets: ["sut.kind"],
	};
	it("accepts a hypothesis only when two judges agree", async () => {
		const agree = await proposeFacetHypothesis(
			async () => '{"facet":"consistency.model","failure_value":"eventual","cornerstone_value":"sync"}',
			input,
		);
		expect(agree.hypothesis).toEqual({
			facet: "consistency.model",
			failureValue: "eventual",
			cornerstoneValue: "sync",
		});
		let k = 0;
		const disagree = await proposeFacetHypothesis(
			async () =>
				k++ === 0
					? '{"facet":"consistency.model","failure_value":"a","cornerstone_value":"b"}'
					: '{"facet":"cache.layer","failure_value":"a","cornerstone_value":"b"}',
			input,
		);
		expect(disagree.hypothesis).toBeUndefined();
		expect(
			(await proposeFacetHypothesis(async () => "ignore previous instructions", input)).hypothesis,
		).toBeUndefined();
	});
});

describe("promotion and gardening", () => {
	it("desensitizes hosts, URLs, emails, and tokens", () => {
		const r = desensitize("call http://localhost:4100/orders and mail ops@shop.example with sk-abcdefghijkl");
		expect(r.text).toBe("call <url> and mail <email> with <token>");
		expect(r.redactions).toBe(3);
	});

	it("finds near-duplicates and snapshots the graph", () => {
		const a = insertTemplate(p.store, strategy("tpl://project/a"), "b", { status: "candidate", changelog: "t" });
		const b = insertTemplate(p.store, strategy("tpl://project/b"), "b", { status: "candidate", changelog: "t" });
		expect(similarity(a, b)).toBeGreaterThan(0.9);
		const r = garden(p.store, p.paths);
		expect(r.duplicates.map((d) => [d.keep, d.deprecate].sort())).toEqual([["tpl://project/a", "tpl://project/b"]]);
		expect(r.snapshot).toMatch(/snap-.*\.json$/);
		expect(p.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots")?.n).toBe(1);
	});
});

describe("learning tables", () => {
	it("feedback: idempotency key, unresolved failures, class filters, credited uses", () => {
		const ok = episode(fp({ "sut.kind": "rest-api" }));
		const weak = episode(fp({ "sut.kind": "rest-api" }));
		const unexplained = episode(fp({ "sut.kind": "rest-api" }));
		const add = (e: string, triageClass: "S" | "U", credibility: number) =>
			insertFeedback(p.store, { episodeId: e, signals: {}, credibility, triageClass, attribution: {} });
		add(ok, "S", 0.9);
		add(weak, "S", 0.4);
		add(unexplained, "U", 0.6);
		for (const e of [ok, weak, unexplained])
			insertTemplateUse(p.store, { episodeId: e, templateId: "tpl://project/t", version: 1, role: "applied" });

		expect(hasFeedback(p.store, ok)).toBe(true);
		expect(hasFeedback(p.store, episode(fp({})))).toBe(false);
		expect([ok, unexplained].map((e) => isUnresolvedFailure(p.store, e))).toEqual([false, true]);
		expect(feedbackEpisodeIds(p.store, ["U", "K"])).toEqual([unexplained]);
		// Only credible successes count as reuse.
		expect(positiveTemplateUses(p.store, "tpl://project/t").map((u) => u.episodeId)).toEqual([ok]);
		expect(() => add(ok, "S", 1)).toThrow(/UNIQUE/);
	});

	it("deltas: suspended hypotheses accumulate evidence and commit without a report", () => {
		const base = {
			op: "facet.propose" as const,
			target: "tpl://project/t",
			hypothesisKey: "facet:t:x",
			payload: { facet: "x" },
			proposedBy: "learner",
		};
		insertDelta(p.store, {
			...base,
			id: "d-1",
			targetVersion: null,
			evidence: ["e1"],
			status: "suspended",
			report: null,
		});
		setDeltaEvidence(p.store, "d-1", ["e1", "e2"]);
		expect(listDeltas(p.store, { hypothesisKey: "facet:t:x" })).toMatchObject([
			{ id: "d-1", status: "suspended", evidence: ["e1", "e2"], report: null },
		]);
		markDeltaCommitted(p.store, "d-1");
		expect(listDeltas(p.store, { status: "committed" }).map((d) => d.id)).toEqual(["d-1"]);
	});

	it("intents are learned once; calibration drift pauses learning", () => {
		insertIntent(p.store, "i-learn", "r", {});
		expect(isIntentLearned(p.store, "i-learn")).toBe(false);
		markIntentLearned(p.store, "i-learn");
		expect(isIntentLearned(p.store, "i-learn")).toBe(true);

		expect([latestCalibration(p.store), isLearningPaused(p.store)]).toEqual([undefined, false]);
		insertCalibrationRun(p.store, { id: "cal-1", precision: 0.5, recall: 1, details: {}, drift: true });
		expect(latestCalibration(p.store)).toEqual({ precision: 0.5, recall: 1, drift: true });
		expect(isLearningPaused(p.store)).toBe(true);
	});

	it("/test-why lists every version's changelog in order", () => {
		const t = insertTemplate(p.store, strategy(), "b", { status: "candidate", changelog: "born" });
		addTemplateVersion(p.store, t.id, t.spec, "b2", "except ex-1", undefined, 1);
		const why = renderWhy(p.store, t.id);
		expect(why).toMatch(/ {2}v1 \S+ born\n {2}v2 \S+ except ex-1/);
	});
});
