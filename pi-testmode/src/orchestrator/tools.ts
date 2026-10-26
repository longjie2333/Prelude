/** Main-session tools in test mode (plan §7). All are registered inactive; test mode activates them. */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { TEST_KINDS } from "../kernel/scope.ts";
import { assembleFingerprint } from "../knowledge/fingerprint.ts";
import { renderCards, searchTemplates } from "../knowledge/retrieval.ts";
import { FingerprintEntrySchema } from "../knowledge/schema.ts";
import { insertRetrieval } from "../knowledge/store.ts";
import type { TestmodePaths } from "../paths.ts";
import { audit, closeIntent, getIntent, getMission, insertIntent, listMissions } from "../store/repos.ts";
import { newId, textResult } from "../util.ts";
import { type IntentIR, IntentIRSchema, intentProblems } from "./intent.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { buildReport } from "./report.ts";

export interface MainToolHost {
	orchestrator(): Orchestrator;
	paths(): TestmodePaths;
}

export function createIntentRecordTool(host: MainToolHost): ToolDefinition {
	return defineTool({
		name: "intent_record",
		label: "Record Intent",
		description:
			"Record the parsed test intent (Intent IR). Returns the intent_id used by mission_dispatch and report_finalize.",
		promptSnippet: "Record the parsed test intent (Intent IR) and get an intent_id",
		promptGuidelines: [
			"Use intent_record once per user test request, before mission_dispatch. Put defaults you chose into assumptions; they appear in the report.",
		],
		parameters: IntentIRSchema,
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			if (!Value.Check(IntentIRSchema, params)) throw new Error("Intent IR does not match the schema");
			const problems = intentProblems(params);
			if (problems.length) throw new Error(`Intent not recorded:\n- ${problems.join("\n- ")}`);
			const o = host.orchestrator();
			const id = newId("i");
			o.store.tx(() => {
				insertIntent(o.store, id, params.raw, params);
				audit(o.store, { actor: "main", event: "intent_record", reason: `${id}: ${params.goal.kind}` });
			});
			return textResult(`intent_id: ${id}`, { intentId: id });
		},
	});
}

const DispatchParams = Type.Object({
	intent_id: Type.String(),
	missions: Type.Array(
		Type.Object({
			role: StringEnum(["scout", "executor"] as const, {
				description:
					"scout = read-only reconnaissance; executor = run tests. Verifiers are dispatched automatically.",
			}),
			objective: Type.String({ description: "One concrete objective" }),
			targets: Type.Array(Type.String(), {
				description: "Hosts or URLs the mission may touch, e.g. http://localhost:4100",
			}),
			test_kinds: Type.Array(StringEnum(TEST_KINDS), {
				description: "Operations needed: functional, load, security-check, destructive",
			}),
			context: Type.Optional(
				Type.String({ description: "What the mission needs to know: SUT docs, reset endpoint, hypotheses" }),
			),
			budget: Type.Optional(
				Type.Object(
					{ tokens: Type.Optional(Type.Number()), wall_clock_s: Type.Optional(Type.Number()) },
					{
						description:
							"Usually omit. Tokens are new tokens (context growth plus output, not the resent context); values below half the role default are raised to it.",
					},
				),
			),
			template_ids: Type.Optional(
				Type.Array(Type.String(), {
					description: "Template ids from knowledge_search cards to activate in this mission",
				}),
			),
			capabilities: Type.Optional(
				Type.Array(Type.String(), { description: "Extra capability ids to bind (cap:…)" }),
			),
		}),
		{ minItems: 1 },
	),
});

export function createMissionDispatchTool(host: MainToolHost): ToolDefinition {
	return defineTool({
		name: "mission_dispatch",
		label: "Dispatch Missions",
		description:
			"Start one or more missions in the background and return immediately. The kernel computes each mission's risk tier from its targets and operations. Results arrive later as a message; you do not wait or poll.",
		promptSnippet: "Start missions in the background; results arrive later as a message",
		promptGuidelines: [
			"After mission_dispatch, end your turn; do not call mission_status in a loop.",
			"Use mission_dispatch with role executor to run tests and role scout to learn an unknown SUT first; mission_dispatch adds verifiers automatically.",
		],
		parameters: DispatchParams,
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = host.orchestrator();
			const outcomes = await o.dispatch(
				params.intent_id,
				params.missions.map((m) => ({
					role: m.role,
					objective: m.objective,
					targets: m.targets,
					testKinds: m.test_kinds,
					context: m.context,
					budget: m.budget,
					templateIds: m.template_ids,
					capabilities: m.capabilities,
				})),
				ctx.model,
			);
			const started = outcomes.filter((x) => x.ok);
			const lines = outcomes.map((x) =>
				x.ok ? `dispatched ${x.missionId} (${x.role}, ${x.tier})` : `NOT dispatched "${x.objective}": ${x.reason}`,
			);
			if (started.length > 0)
				lines.push("Missions run in the background. End your turn now; you will be woken when results arrive.");
			return textResult(lines.join("\n"), { outcomes }, { terminate: started.length > 0 });
		},
	});
}

export function createMissionStatusTool(host: MainToolHost): ToolDefinition {
	return defineTool({
		name: "mission_status",
		label: "Mission Status",
		description: "Summarize missions of an intent (or one mission). Running missions report back on their own.",
		promptSnippet: "Summarize mission results for an intent",
		parameters: Type.Object({
			intent_id: Type.Optional(Type.String()),
			mission_id: Type.Optional(Type.String()),
		}),
		defaultActive: false,
		async execute(_id, params) {
			const o = host.orchestrator();
			const missions = params.mission_id
				? [getMission(o.store, params.mission_id)].filter((m) => m !== undefined)
				: params.intent_id
					? listMissions(o.store, { intentId: params.intent_id })
					: listMissions(o.store, { statuses: ["queued", "running", "interrupted", "blocked"] });
			if (missions.length === 0) return textResult("No matching missions.", { missions: [] });
			const running = missions.filter((m) => m.status === "queued" || m.status === "running");
			const text = missions.map((m) => o.missionSummary(m)).join("\n");
			const allRunning = running.length === missions.length;
			return textResult(
				allRunning ? `${text}\nStill running; end your turn and wait for the notification.` : text,
				{ missions: missions.map((m) => ({ id: m.id, status: m.status })) },
				{ terminate: allRunning },
			);
		},
	});
}

export function createReportFinalizeTool(host: MainToolHost): ToolDefinition {
	return defineTool({
		name: "report_finalize",
		label: "Finalize Report",
		description:
			"Write the intent's report from recorded mission results and close the intent. Verified defects, unconfirmed claims, assumptions, coverage gaps, isolation level, and cost are filled in from the record; you provide the conclusion.",
		promptSnippet: "Write the report for an intent and close it",
		promptGuidelines: [
			"Use report_finalize once the intent's missions have ended; then give the user a short summary and the report path.",
		],
		parameters: Type.Object({
			intent_id: Type.String(),
			conclusion: Type.String({ description: "Answer to the user's question, grounded in confirmed claims only" }),
			uncovered: Type.Optional(
				Type.Array(Type.String(), { description: "Targets or goals you chose not to cover" }),
			),
			notes: Type.Optional(Type.String()),
			force: Type.Optional(Type.Boolean({ description: "Finalize even though missions are still running" })),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			const o = host.orchestrator();
			const { report: r, curator } = o.finalizeIntent(params.intent_id, {
				conclusion: params.conclusion,
				uncovered: params.uncovered,
				notes: params.notes,
				force: params.force,
			});
			return textResult(
				`Report written: ${r.path}\nconfirmed defects: ${r.confirmedDefects}, confirmed passes: ${r.confirmedPasses}, not confirmed: ${r.unconfirmed}${curator ? `\nA curator (${curator}) distills a draft template in the background.` : ""}`,
				{
					path: r.path,
					confirmedDefects: r.confirmedDefects,
					confirmedPasses: r.confirmedPasses,
					unconfirmed: r.unconfirmed,
				},
			);
		},
	});
}

const GUIDANCE: Record<string, string> = {
	H3: "Dispatch an executor with the top strategy as template_ids.",
	H2: "Dispatch an executor with the top strategy as template_ids; it runs the listed probes first. If the SUT is unknown, dispatch a scout first.",
	H1: "Dispatch a scout to learn the SUT, then an executor; applicable slot templates may be passed as template_ids.",
	H0: "Dispatch a scout to learn the SUT, then an executor; applicable slot templates may be passed as template_ids.",
};

export function createKnowledgeSearchTool(host: MainToolHost): ToolDefinition {
	return defineTool({
		name: "knowledge_search",
		label: "Search Knowledge",
		description:
			"Find test templates that apply to an intent. Returns at most 3 cards and a hit level: H3 exact (stable template applies), H2 adapted (applies, but probe or check first), H1 analogous (only related templates), H0 none.",
		promptSnippet: "Find applicable test templates (≤3 cards) and the hit level for an intent",
		promptGuidelines: [
			"Use knowledge_search after intent_record and before mission_dispatch; pass applicable card ids to mission_dispatch as template_ids.",
		],
		parameters: Type.Object({
			intent_id: Type.String(),
			query: Type.Optional(Type.String({ description: "Search text; defaults to the intent and its hypotheses" })),
			facets: Type.Optional(
				Type.Array(FingerprintEntrySchema, { description: "Facts about the SUT you already know" }),
			),
		}),
		defaultActive: false,
		async execute(_id, params) {
			const o = host.orchestrator();
			const intent = getIntent(o.store, params.intent_id);
			if (!intent) throw new Error(`unknown intent ${params.intent_id}`);
			const ir = intent.ir as IntentIR;
			const query = params.query ?? [intent.raw, ...(ir.goal?.hypotheses ?? [])].join(" ");
			const { fingerprint } = assembleFingerprint(o.store, ir, params.facets ?? []);
			const r = searchTemplates(o.store, query, fingerprint);
			o.store.tx(() => {
				insertRetrieval(o.store, {
					id: newId("rt"),
					intentId: intent.id,
					query,
					fingerprint,
					hitLevel: r.hitLevel,
					cards: r.cards,
				});
				audit(o.store, {
					actor: "main",
					event: "knowledge_search",
					reason: `${intent.id}: ${r.hitLevel} [${r.cards.map((c) => c.id).join(", ")}]`,
				});
			});
			return textResult(`hit level: ${r.hitLevel}\n${renderCards(r)}\n${GUIDANCE[r.hitLevel]}`, {
				hitLevel: r.hitLevel,
				cards: r.cards,
			});
		},
	});
}
