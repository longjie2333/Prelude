/**
 * Test mode (plan M1-3).
 * Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/plan-mode/index.ts:
 * toggle via /test, --test, and Ctrl+Alt+T; swap the active tool set and restore it on exit;
 * persist the toggle with appendEntry; inject a prompt section; filter stale test-mode messages
 * outside test mode; show running missions in the status bar.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, type ExtensionFactory, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Box, Key, Text } from "@earendil-works/pi-tui";
import { sweepOrphanEvidence } from "./harness/evidence.ts";
import { canonicalPath } from "./kernel/paths.ts";
import type { PolicyContext } from "./kernel/policy.ts";
import { policyExtension } from "./kernel/policy-extension.ts";
import { loadScope } from "./kernel/scope.ts";
import { MISSION_DONE, Orchestrator, type OrchestratorOptions } from "./orchestrator/orchestrator.ts";
import questionnaire from "./orchestrator/questionnaire.ts";
import { createIntentRecordTool, createMissionDispatchTool, createMissionStatusTool, createReportFinalizeTool } from "./orchestrator/tools.ts";
import { resolvePaths, type TestmodePaths } from "./paths.ts";
import { openStore, type Store } from "./store/db.ts";
import type { MissionRow } from "./store/repos.ts";

const STATE_ENTRY = "testmode-state";
const CUSTOM_PREFIX = "testmode-";

/** Active tools of the main session in test mode (plan §7, I-6: no bash/edit/write). */
export const TESTMODE_TOOLS = ["read", "grep", "find", "ls", "questionnaire", "intent_record", "mission_dispatch", "mission_status", "report_finalize"];

export const TESTMODE_SECTION = `<testmode>
Test mode is active. You are the orchestrator of a testing agent. You do five things only: understand the test intent, analyze the situation, plan missions, dispatch them, and summarize results. You never execute tests yourself; you have no shell and cannot write files.

1. Parse the request into an Intent IR and record it with intent_record. If an ambiguity would change the risk tier or the scope (target environment, whether destructive operations are allowed, which assets), ask with questionnaire first; record every other default you choose as an assumption.
2. Dispatch missions with mission_dispatch: an executor to test, a scout first when the SUT is unknown. Give each mission concrete targets and the context it needs (docs, reset endpoint, hypotheses). The kernel computes risk tiers; you cannot set them.
3. After mission_dispatch, end your turn immediately. Do not poll. A message wakes you when results arrive.
4. When woken, decide whether follow-up missions are needed; otherwise call report_finalize. Only claims marked confirmed by the independent verifier are findings. State assumptions and gaps plainly.
</testmode>`;

interface PersistedState {
	enabled: boolean;
	toolsBefore?: string[];
}

export interface TestmodeOptions {
	/** Overrides `getAgentDir()` (tests). */
	agentDir?: string;
	/** Model runtime for missions; defaults to `ModelRuntime.create` on the agent dir. */
	modelRuntime?: () => Promise<ModelRuntime>;
	orchestrator?: Partial<Omit<OrchestratorOptions, "paths" | "store" | "agentDir" | "modelRuntime">>;
	/** Observe the orchestrator once created (tests). */
	onOrchestrator?: (o: Orchestrator) => void;
}

export function createTestmodeExtension(options: TestmodeOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let enabled = false;
		let toolsBefore: string[] | undefined;
		let ctxRef: ExtensionContext | undefined;
		let paths: TestmodePaths | undefined;
		let store: Store | undefined;
		let orchestrator: Orchestrator | undefined;
		let runtime: Promise<ModelRuntime> | undefined;
		const agentDir = () => options.agentDir ?? getAgentDir();

		const ensurePaths = (cwd: string) => (paths ??= resolvePaths(cwd, agentDir()));

		const ensureOrchestrator = (ctx: ExtensionContext): Orchestrator => {
			if (orchestrator) return orchestrator;
			const p = ensurePaths(ctx.cwd);
			store ??= openStore(p.projectDb, p.globalDb);
			sweepOrphanEvidence(store, p.evidenceDir);
			orchestrator = new Orchestrator({
				paths: p,
				agentDir: agentDir(),
				store,
				modelRuntime:
					options.modelRuntime ??
					(() => (runtime ??= ModelRuntime.create({ authPath: join(agentDir(), "auth.json"), modelsPath: join(agentDir(), "models.json") }))),
				...options.orchestrator,
			});
			orchestrator.recoverOnStartup();
			options.onOrchestrator?.(orchestrator);
			return orchestrator;
		};

		const attach = (ctx: ExtensionContext) => {
			const o = ensureOrchestrator(ctx);
			o.attachMain({
				notify: (content, details) => {
					if (!enabled) return false; // delivered on re-entry: outside test mode the message would be filtered out
					try {
						pi.sendMessage({ customType: MISSION_DONE, content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
						setTimeout(() => updateStatus(), 0);
						return true;
					} catch {
						return false;
					}
				},
				ui: ctx.hasUI ? { select: (title, opts) => ctx.ui.select(title, opts), confirm: (t, m) => ctx.ui.confirm(t, m) } : undefined,
			});
			return o;
		};

		const updateStatus = () => {
			const ctx = ctxRef;
			if (!ctx) return;
			try {
				if (!enabled) return ctx.ui.setStatus("testmode", undefined);
				const n = orchestrator?.runningCount() ?? 0;
				ctx.ui.setStatus("testmode", ctx.ui.theme.fg(n > 0 ? "accent" : "warning", n > 0 ? `🧪 test · ${n} running` : "🧪 test"));
			} catch {
				// stale context after session replacement
			}
		};

		const persist = () => pi.appendEntry<PersistedState>(STATE_ENTRY, { enabled, toolsBefore });

		const offerParked = async (ctx: ExtensionContext, o: Orchestrator, parked: MissionRow[]) => {
			if (parked.length === 0) return;
			if (!ctx.hasUI) {
				ctx.ui.notify(`${parked.length} mission(s) need a decision: ${parked.map((m) => `${m.id} (${m.status})`).join(", ")}. Run /test-missions.`, "warning");
				return;
			}
			for (const m of parked) {
				const label = `${m.role} ${m.id} — ${m.status}${m.interruptReason ? ` (${m.interruptReason})` : ""}${m.error ? `: ${m.error}` : ""}\n${m.objective}`;
				const choice = await ctx.ui.select(label, ["Resume", "Re-dispatch", "Abandon", "Decide later"]);
				if (choice === "Resume") {
					let r = await o.resumeMission(m.id);
					if (r.kind === "needs_confirmation") {
						const ok = await ctx.ui.confirm(
							"Unknown side effects",
							`${r.tools.join(", ")} was interrupted mid-execution; its effect is unknown. Reset the environment, then continue?`,
						);
						if (ok) r = await o.resumeMission(m.id, true);
					}
					ctx.ui.notify(`${m.id}: ${r.kind}${"reason" in r ? ` — ${r.reason}` : ""}`, r.kind === "failed" ? "error" : "info");
				} else if (choice === "Re-dispatch") {
					ctx.ui.notify(`${m.id} re-dispatched as ${o.redispatch(m.id)}`, "info");
				} else if (choice === "Abandon") {
					o.abandon(m.id);
				}
			}
			updateStatus();
		};

		const setEnabled = async (ctx: ExtensionContext, value: boolean, opts: { persist: boolean }) => {
			enabled = value;
			if (enabled) {
				if (toolsBefore === undefined) toolsBefore = pi.getActiveTools();
				pi.setActiveTools(TESTMODE_TOOLS);
				const o = attach(ctx);
				updateStatus();
				if (opts.persist) persist();
				await offerParked(ctx, o, o.parkedMissions());
				o.flushNotifications();
			} else {
				pi.setActiveTools(toolsBefore ?? ["read", "bash", "edit", "write"]);
				toolsBefore = undefined;
				updateStatus();
				if (opts.persist) persist();
			}
		};

		const toggle = async (ctx: ExtensionContext) => {
			ctxRef = ctx;
			await setEnabled(ctx, !enabled, { persist: true });
			ctx.ui.notify(enabled ? "Test mode on: the main session plans and dispatches; missions run the tests." : "Test mode off.", "info");
		};

		// ---------------------------------------------------------------- registration

		const host = {
			orchestrator: () => {
				if (!orchestrator) throw new Error("test mode is not active; run /test");
				return orchestrator;
			},
			paths: () => {
				if (!paths) throw new Error("test mode is not active; run /test");
				return paths;
			},
		};
		for (const tool of [createIntentRecordTool(host), createMissionDispatchTool(host), createMissionStatusTool(host), createReportFinalizeTool(host)]) {
			pi.registerTool(tool);
		}
		questionnaire(pi);

		policyExtension({
			store: () => store,
			actor: () => "main",
			approve: async (req) => {
				if (orchestrator) return orchestrator.approve(req);
				return { approved: false, reason: "no approval channel outside test mode" };
			},
			context: (): PolicyContext => {
				const cwd = ctxRef?.cwd ?? process.cwd();
				const p = ensurePaths(cwd);
				return {
					mode: enabled ? "testmode-main" : "normal",
					cwd,
					home: process.env.HOME || process.env.USERPROFILE || "",
					testmodeDir: p.dir,
					scopeFile: p.scopeFile,
					globalDir: p.globalDir,
					agentDir: agentDir(),
					extensionDir: p.extensionDir,
					runsDir: p.runsDir,
					scope: loadScope(p.scopeFile).scope,
					frozen: new Set(store ? orchestratorFrozen(store, cwd) : []),
				};
			},
		})(pi);

		pi.registerFlag("test", { description: "Start in test mode", type: "boolean", default: false });

		pi.registerCommand("test", {
			description: "Toggle test mode (intent → missions → verified report)",
			handler: async (_args, ctx) => toggle(ctx),
		});

		pi.registerCommand("test-missions", {
			description: "Resume, re-dispatch, or abandon interrupted and blocked missions",
			handler: async (_args, ctx) => {
				ctxRef = ctx;
				const o = attach(ctx);
				const parked = o.parkedMissions();
				if (parked.length === 0) return ctx.ui.notify("No interrupted or blocked missions.", "info");
				await offerParked(ctx, o, parked);
			},
		});

		pi.registerShortcut(Key.ctrlAlt("t"), { description: "Toggle test mode", handler: async (ctx) => toggle(ctx) });

		pi.registerMessageRenderer(MISSION_DONE, (message, { outputPad }, theme) => {
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			const text = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			box.addChild(new Text(theme.fg("accent", text), 0, 0));
			return box;
		});

		// ---------------------------------------------------------------- lifecycle

		pi.on("session_start", async (_event, ctx) => {
			ctxRef = ctx;
			ensurePaths(ctx.cwd);
			const entry = ctx.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY)
				.pop() as { data?: PersistedState } | undefined;
			const wanted = entry?.data?.enabled ?? pi.getFlag("test") === true;
			toolsBefore = entry?.data?.toolsBefore;
			if (wanted) await setEnabled(ctx, true, { persist: !entry });
			else updateStatus();
		});

		pi.on("session_shutdown", async () => {
			const o = orchestrator;
			orchestrator = undefined;
			ctxRef = undefined;
			if (o) await o.shutdown();
			store?.close();
			store = undefined;
		});

		pi.on("before_agent_start", (event) => {
			if (enabled) event.systemPromptOptions.sections.testmode = TESTMODE_SECTION;
		});

		pi.on("agent_settled", () => updateStatus());
		pi.on("tool_execution_end", (event) => {
			if (event.toolName === "mission_dispatch") updateStatus();
		});

		pi.on("context", (event) => {
			if (enabled) return undefined;
			return {
				messages: event.messages.filter((m) => !((m as { customType?: string }).customType ?? "").startsWith(CUSTOM_PREFIX)),
			};
		});
	};
}

function orchestratorFrozen(store: Store, cwd: string): string[] {
	return store.all<{ path: string }>("SELECT path FROM frozen_artifacts").map((r) => canonicalPath(r.path, cwd));
}
