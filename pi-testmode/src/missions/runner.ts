/**
 * Mission runner (plan M1-8, I-1, I-2, I-9): each mission is an in-process SDK session with only
 * its role's tools, the policy gate, and the mission tools. User extensions, skills, prompt
 * templates, and context files never load into a mission.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MCP_SECTION, mcpBindings, mcpGuard, missionMcpExtensions, toolPrefix } from "../capabilities/mcp-bind.ts";
import { quarantineProvider, verifyBinding } from "../capabilities/registry.ts";
import { createCapabilityRequestTool, createProviderRegisterTool, createSkillValidateTool } from "../capabilities/tools.ts";
import { type CapabilityRequest, createArtifactFreezeTool, createMissionSubmitTool, createTestRunTool, type MissionToolHost } from "../harness/tools.ts";
import { renderTemplatesSection } from "../knowledge/render.ts";
import { getCapability, getTemplate, listFacets } from "../knowledge/store.ts";
import { createTemplateProposeTool } from "../learning/curator.ts";
import { createDeltaProposeTool } from "../learning/delta-tool.ts";
import type { ApprovalOutcome, ApprovalRequest } from "../kernel/approvals.ts";
import { BudgetTracker } from "../kernel/budget.ts";
import { canonicalPath } from "../kernel/paths.ts";
import type { PolicyContext } from "../kernel/policy.ts";
import { policyExtension } from "../kernel/policy-extension.ts";
import { loadScope } from "../kernel/scope.ts";
import type { TestmodePaths } from "../paths.ts";
import { isolationLevel, missionSandboxExtension, sandboxConfigFor } from "../sandbox/index.ts";
import type { Store } from "../store/db.ts";
import { audit, getMission, listFrozen, type MissionRow, updateMission, voidUnfinishedTestRuns } from "../store/repos.ts";
import type { Cost, MissionStatus } from "../types.ts";
import { errorMessage, nowIso } from "../util.ts";
import type { Envelope } from "./envelope.ts";
import { applyResolutions, recoveryNote, resolveOrphans } from "./recovery.ts";
import { loadRole, renderMissionSpec, roleTools } from "./roles.ts";

export const MAX_RESUMES = 2;

async function waitForTools<T>(get: () => T[], timeoutMs: number): Promise<T[]> {
	const start = Date.now();
	for (;;) {
		const found = get();
		if (found.length > 0 || Date.now() - start > timeoutMs) return found;
		await new Promise((r) => setTimeout(r, 50));
	}
}

const NL = String.fromCharCode(10);
const lines = (xs: readonly string[]) => xs.filter(Boolean).join(NL);

export type AbortReason = "shutdown" | "user" | "budget";

export type ResumeResult =
	| { kind: "resumed" }
	| { kind: "restarted"; reason: string }
	| { kind: "finalized"; status: MissionStatus }
	| { kind: "needs_confirmation"; tools: string[] }
	| { kind: "failed"; reason: string };

/** Plan I-9: the orchestrator depends only on this interface. */
export interface MissionRunner {
	start(missionId: string): void;
	resume(missionId: string, opts?: { confirmUnknownSideEffects?: boolean }): Promise<ResumeResult>;
	abort(missionId: string, reason: AbortReason): Promise<void>;
	abortAll(reason: AbortReason): Promise<void>;
	status(missionId: string): MissionStatus | undefined;
	isActive(missionId: string): boolean;
	activeCount(): number;
	/** Whether the most recent mission ran inside the OS sandbox. */
	isolation(): string;
}

export interface RunnerHooks {
	approve(req: ApprovalRequest): Promise<ApprovalOutcome>;
	/** Called after the mission's final state is committed. */
	onMissionEnd(missionId: string): void;
	requestCapability?(missionId: string, req: CapabilityRequest): { message: string; gapId?: string };
}

export interface SdkRunnerOptions {
	paths: TestmodePaths;
	agentDir: string;
	store: Store;
	modelRuntime: () => Promise<ModelRuntime>;
	/** Fallback model when a spec names none (or names one the runtime lacks). */
	defaultModel?: () => Model<any> | undefined;
	hooks: RunnerHooks;
	concurrency?: number;
	heartbeatMs?: number;
	/** Settings overrides for mission sessions (tests disable retries). */
	settings?: Record<string, unknown>;
	/** Disable the OS sandbox even where supported. */
	noSandbox?: boolean;
}

interface Active {
	session?: AgentSession;
	abortReason?: AbortReason;
	envelope?: Envelope;
	done: Promise<void>;
}

interface Pending {
	missionId: string;
	resume?: { sm: SessionManager; note: string };
}

const NETWORK_ERROR = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|overloaded|503|502|504/i;

export class SdkMissionRunner implements MissionRunner {
	private readonly active = new Map<string, Active>();
	private readonly pending: Pending[] = [];
	private sandboxUsed = false;

	private readonly opts: SdkRunnerOptions;

	constructor(opts: SdkRunnerOptions) {
		this.opts = opts;
	}

	isolation(): string {
		return isolationLevel(this.sandboxUsed);
	}

	activeCount(): number {
		return this.active.size;
	}

	isActive(missionId: string): boolean {
		return this.active.has(missionId) || this.pending.some((p) => p.missionId === missionId);
	}

	status(missionId: string): MissionStatus | undefined {
		return getMission(this.opts.store, missionId)?.status;
	}

	start(missionId: string): void {
		this.pending.push({ missionId });
		this.drain();
	}

	async resume(missionId: string, opts: { confirmUnknownSideEffects?: boolean } = {}): Promise<ResumeResult> {
		const { store } = this.opts;
		const m = getMission(store, missionId);
		if (!m) return { kind: "failed", reason: `unknown mission ${missionId}` };
		if (this.isActive(missionId)) return { kind: "failed", reason: "mission is already running" };
		if (!["interrupted", "blocked", "aborted", "queued"].includes(m.status)) {
			return { kind: "failed", reason: `mission is ${m.status}; only interrupted, blocked, or aborted missions resume` };
		}
		const voided = voidUnfinishedTestRuns(store, missionId);

		// Crashed after mission_submit but before finalizing: the envelope is already durable.
		if (m.envelope) {
			const status = this.statusFromEnvelope(m.envelope as Envelope);
			this.finalize(m, status, { envelope: m.envelope as Envelope, cost: m.cost, error: null });
			return { kind: "finalized", status };
		}

		if (m.resumeCount >= MAX_RESUMES) {
			this.finalize(m, "failed", { cost: m.cost, error: `resumed ${m.resumeCount} times; giving up (M1-14 4d)` });
			return { kind: "failed", reason: "resume limit reached" };
		}

		// Crashed before the first assistant reply: nothing was persisted, re-run the same spec.
		if (!m.sessionPath || !existsSync(m.sessionPath)) {
			store.tx(() => {
				updateMission(store, missionId, { status: "queued", interruptReason: null, resumeCount: m.resumeCount + 1, ownerPid: null, notifiedAt: null });
				audit(store, { actor: "main", event: "mission_restart", reason: `${missionId}: session not persisted yet` });
			});
			this.pending.push({ missionId });
			this.drain();
			return { kind: "restarted", reason: "session was not persisted before the interruption; re-running the same spec" };
		}

		const sm = SessionManager.open(m.sessionPath, m.runDir, this.opts.paths.root);
		const resolutions = resolveOrphans(sm, store, missionId, this.opts.paths.evidenceDir);
		const unknown = resolutions.filter((r) => r.kind === "unknown_side_effect");
		if (unknown.length > 0 && !opts.confirmUnknownSideEffects) {
			store.tx(() => {
				updateMission(store, missionId, { status: "blocked", error: `side effects with unknown outcome: ${unknown.map((u) => u.call.toolName).join(", ")}` });
				audit(store, { actor: "main", event: "mission_blocked", reason: `${missionId}: unknown side effects, needs confirmation` });
			});
			return { kind: "needs_confirmation", tools: unknown.map((u) => u.call.toolName) };
		}
		applyResolutions(sm, resolutions);
		const note = recoveryNote(resolutions, voided, m.interruptReason ?? m.status);
		store.tx(() => {
			updateMission(store, missionId, { status: "queued", interruptReason: null, error: null, resumeCount: m.resumeCount + 1, ownerPid: null, notifiedAt: null });
			audit(store, { actor: "main", event: "mission_resume", reason: `${missionId}: ${resolutions.map((r) => `${r.call.toolName}=${r.kind}`).join(", ") || "no orphans"}` });
		});
		this.pending.push({ missionId, resume: { sm, note } });
		this.drain();
		return { kind: "resumed" };
	}

	async abort(missionId: string, reason: AbortReason): Promise<void> {
		const idx = this.pending.findIndex((p) => p.missionId === missionId);
		if (idx >= 0) {
			this.pending.splice(idx, 1);
			const m = getMission(this.opts.store, missionId);
			if (m) this.finalize(m, "aborted", { cost: m.cost, error: `aborted before start (${reason})`, interruptReason: reason === "shutdown" ? "shutdown" : null });
			return;
		}
		const a = this.active.get(missionId);
		if (!a) return;
		a.abortReason ??= reason;
		await a.session?.abort().catch(() => undefined);
		await a.done;
	}

	async abortAll(reason: AbortReason): Promise<void> {
		for (const p of [...this.pending]) await this.abort(p.missionId, reason);
		await Promise.all([...this.active.keys()].map((id) => this.abort(id, reason)));
	}

	private drain(): void {
		const limit = this.opts.concurrency ?? 3;
		while (this.active.size < limit && this.pending.length > 0) {
			const next = this.pending.shift() as Pending;
			let resolveDone!: () => void;
			const entry: Active = { done: new Promise((r) => (resolveDone = r)) };
			this.active.set(next.missionId, entry);
			void this.execute(next, entry)
				.catch((err) => {
					const m = getMission(this.opts.store, next.missionId);
					if (m && !["completed", "partial", "failed", "aborted", "blocked"].includes(m.status)) {
						this.finalize(m, "failed", { cost: m.cost, error: `runner error: ${errorMessage(err)}` });
					}
				})
				.finally(() => {
					this.active.delete(next.missionId);
					resolveDone();
					this.drain();
				});
		}
	}

	private policyContext(m: MissionRow): PolicyContext {
		const { paths } = this.opts;
		const scope = loadScope(paths.scopeFile).scope;
		return {
			mode: "mission",
			cwd: paths.root,
			home: process.env.HOME || process.env.USERPROFILE || "",
			testmodeDir: paths.dir,
			scopeFile: paths.scopeFile,
			globalDir: paths.globalDir,
			agentDir: this.opts.agentDir,
			extensionDir: paths.extensionDir,
			runsDir: paths.runsDir,
			missionId: m.id,
			runDir: m.runDir,
			missionTier: m.riskTier,
			scope,
			frozen: new Set(listFrozen(this.opts.store).map((f) => canonicalPath(f.path, paths.root))),
		};
	}

	private async execute(next: Pending, entry: Active): Promise<void> {
		const { store, paths } = this.opts;
		const initial = getMission(store, next.missionId);
		if (!initial) return;
		mkdirSync(initial.runDir, { recursive: true });

		const sm = next.resume?.sm ?? SessionManager.create(paths.root, initial.runDir);
		const sessionPath = sm.getSessionFile();
		store.tx(() => {
			updateMission(store, initial.id, {
				status: "running",
				ownerPid: process.pid,
				heartbeatAt: nowIso(),
				startedAt: initial.startedAt ?? nowIso(),
				sessionPath: sessionPath ?? undefined,
			});
			audit(store, { actor: `mission:${initial.id}`, event: next.resume ? "mission_resumed" : "mission_started", reason: `${initial.role} ${initial.riskTier}` });
		});
		const m = getMission(store, initial.id) as MissionRow;

		const role = loadRole(m.role);
		const runtime = await this.opts.modelRuntime();
		const model = (m.spec.model && runtime.getModel(m.spec.model.provider, m.spec.model.id)) || this.opts.defaultModel?.();
		if (!model) {
			this.finalize(m, "failed", { cost: m.cost, error: "no model available for the mission" });
			return;
		}

		// Hash-lock check right before use (M2-6): a changed provider blocks the mission.
		for (const b of m.spec.bindings ?? []) {
			const check = verifyBinding(b);
			if (!check.ok) {
				quarantineProvider(store, b.sha256, `mission:${m.id}`, check.reason);
				this.finalize(m, "failed", { cost: m.cost, error: `provider ${b.name}@${b.sha256.slice(0, 8)} for ${b.capId} blocked: ${check.reason}` });
				return;
			}
		}

		// MCP providers bound to this mission (M2-7); the Toolsmith loads the MCP extension to probe servers.
		const mcpBound = mcpBindings(m.spec.bindings ?? []).map((binding) => ({ binding, semantics: getCapability(store, binding.capId)?.semantics ?? binding.capId }));
		const guard = mcpGuard(mcpBound, (b, now) => quarantineProvider(store, b.sha256, `mission:${m.id}`, `MCP tool definitions changed (${b.mcp?.toolDefsSha.slice(0, 8)} → ${now.slice(0, 8)})`));
		const useMcp = mcpBound.length > 0 || role.tools.includes("provider_register");
		let missionPi: ExtensionAPI | undefined;

		const toolHost: MissionToolHost = {
			store,
			missionId: m.id,
			role: m.role,
			runDir: m.runDir,
			evidenceDir: paths.evidenceDir,
			root: paths.root,
			paths,
			spec: m.spec,
			requestCapability: this.opts.hooks.requestCapability ? (req) => this.opts.hooks.requestCapability?.(m.id, req) ?? { message: "unavailable" } : undefined,
			approve: async (req) => (await this.opts.hooks.approve({ actor: `mission:${m.id}`, missionId: m.id, ...req })).approved,
			probeMcp: async (server, config) => {
				const pi = missionPi;
				if (!pi) throw new Error("mission extension runtime unavailable");
				pi.registerMcpServer(server, { ...(config as object), exposure: "deferred" } as never);
				const prefix = toolPrefix(server);
				try {
					const tools = await waitForTools(() => pi.getAllTools().filter((t) => t.name.startsWith(prefix)), 15_000);
					return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, annotations: t.annotations }));
				} finally {
					pi.unregisterMcpServer(server);
				}
			},
			onSubmit: (env) => {
				entry.envelope = env;
				// Durable before the mission is finalized, so a crash here does not lose the result.
				updateMission(store, m.id, { envelope: env });
			},
		};
		const missionSection = renderMissionSpec(m.spec, m.runDir);
		const extraSections = this.missionSections(m);
		const skillPaths = [...new Set((m.spec.bindings ?? []).filter((b) => b.kind === "skill" && b.path).map((b) => b.path as string))];
		const factories: ExtensionFactory[] = [
			policyExtension({
				store: () => store,
				context: () => this.policyContext(m),
				actor: () => `mission:${m.id}`,
				approve: (req) => this.opts.hooks.approve(req),
				journal: { missionId: m.id, evidenceDir: paths.evidenceDir },
				guard: mcpBound.length ? (pi, toolName) => guard.check(pi, toolName) : undefined,
			}),
			(pi) => {
				missionPi = pi;
				const submit = createMissionSubmitTool(toolHost);
				const tools = [
					createTestRunTool(toolHost),
					createArtifactFreezeTool(toolHost),
					// mission_submit is active in every role, so it carries the MCP description rewrite (extensions.md "Tool exposure").
					mcpBound.length ? { ...submit, prepareLoadout: (l: Parameters<typeof guard.prepareLoadout>[0]) => guard.prepareLoadout(l) } : submit,
					createCapabilityRequestTool(toolHost),
					createSkillValidateTool(toolHost),
					createProviderRegisterTool(toolHost),
					createTemplateProposeTool(toolHost),
					createDeltaProposeTool(toolHost),
				];
				for (const t of tools) if (role.tools.includes(t.name)) pi.registerTool(t);
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.mission = missionSection;
					for (const [k, v] of Object.entries(extraSections)) event.systemPromptOptions.sections[k] = v;
				});
			},
		];
		if (useMcp) {
			factories.push(...missionMcpExtensions(mcpBound, m.runDir), (pi) => {
				// Registered after the MCP extension so these handlers see (and replace) its output.
				pi.on("before_agent_start", (event) => {
					if (mcpBound.length) event.systemPromptOptions.sections[MCP_SECTION] = guard.section();
					else delete event.systemPromptOptions.sections[MCP_SECTION];
				});
				pi.on("tool_result", (event) => {
					if (event.toolName !== "tool_search") return undefined;
					const text = event.content.map((c) => ("text" in c ? c.text : "")).join(NL);
					const rewritten = guard.rewriteSearch(pi, text);
					return rewritten === undefined ? undefined : { content: [{ type: "text", text: rewritten }] };
				});
			});
		}
		if (!this.opts.noSandbox && role.tools.includes("bash")) {
			const sandbox = await missionSandboxExtension(
				paths.root,
				sandboxConfigFor({ scope: loadScope(paths.scopeFile).scope, targets: m.spec.targets, runDir: m.runDir, agentDir: this.opts.agentDir }),
			);
			if (sandbox) {
				factories.push(sandbox);
				this.sandboxUsed = true;
			}
		}

		const loader = new DefaultResourceLoader({
			cwd: paths.root,
			agentDir: this.opts.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			noThemes: true,
			additionalSkillPaths: skillPaths,
			systemPrompt: role.systemPrompt,
			extensionFactories: factories,
		});
		await loader.reload();

		const { session } = await createAgentSession({
			cwd: paths.root,
			agentDir: this.opts.agentDir,
			model,
			modelRuntime: runtime,
			resourceLoader: loader,
			tools: useMcp ? [...roleTools(role), "tool_search"] : roleTools(role),
			sessionManager: sm,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, ...(this.opts.settings ?? {}) }),
		});
		entry.session = session;
		if (entry.abortReason) {
			session.dispose();
			this.finalize(m, entry.abortReason === "budget" ? "partial" : "aborted", {
				cost: m.cost,
				error: `aborted (${entry.abortReason})`,
				interruptReason: entry.abortReason === "shutdown" ? "shutdown" : null,
			});
			return;
		}
		await session.bindExtensions({});

		const budget = new BudgetTracker(m.budget, m.cost);
		let lastError: string | undefined;
		const checkBudget = () => {
			if (entry.abortReason) return;
			if (budget.state() === "exceeded") {
				entry.abortReason = "budget";
				void session.abort();
			} else if (budget.shouldWarn()) {
				void session
					.steer("[testmode] Budget is 80% used. Wrap up now: finish the current check and call mission_submit with what you have.")
					.catch(() => undefined);
			}
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const msg = event.message as { role?: string; usage?: Parameters<BudgetTracker["addUsage"]>[0]; stopReason?: string; errorMessage?: string };
			if (msg.role !== "assistant") return;
			budget.addUsage(msg.usage);
			lastError = msg.stopReason === "error" ? (msg.errorMessage ?? "model error") : undefined;
			updateMission(store, m.id, { cost: budget.snapshot() });
			checkBudget();
		});
		const heartbeat = setInterval(() => {
			try {
				updateMission(store, m.id, { heartbeatAt: nowIso(), cost: budget.snapshot() });
			} catch {
				// store closed during shutdown
			}
			checkBudget();
		}, this.opts.heartbeatMs ?? 10_000);
		heartbeat.unref?.();

		let thrown: string | undefined;
		try {
			const first = next.resume?.note ?? "Begin the mission described in the <mission> section. Finish with mission_submit.";
			await session.prompt(first, { expandPromptTemplates: false });
			if (!entry.envelope && !entry.abortReason && !lastError) {
				await session.prompt("[testmode] You ended without calling mission_submit. Call mission_submit now with your result envelope.", {
					expandPromptTemplates: false,
				});
			}
		} catch (err) {
			thrown = errorMessage(err);
		} finally {
			clearInterval(heartbeat);
			unsubscribe();
		}
		const cost: Cost = budget.snapshot();
		session.dispose();

		if (entry.envelope) {
			this.finalize(m, this.statusFromEnvelope(entry.envelope), { envelope: entry.envelope, cost, error: null });
		} else if (entry.abortReason === "budget") {
			this.finalize(m, "partial", { cost, error: "budget exhausted before mission_submit" });
		} else if (entry.abortReason) {
			this.finalize(m, "aborted", { cost, error: `aborted (${entry.abortReason})`, interruptReason: entry.abortReason === "shutdown" ? "shutdown" : null });
		} else {
			const error = lastError ?? thrown;
			if (error && NETWORK_ERROR.test(error)) {
				// M1-14 §5: retries exhausted. Keep the session; resumable once the network is back.
				store.tx(() => {
					updateMission(store, m.id, { status: "interrupted", interruptReason: "network", cost, error, ownerPid: null });
					audit(store, { actor: `mission:${m.id}`, event: "mission_interrupted", reason: `network: ${error}` });
				});
				this.opts.hooks.onMissionEnd(m.id);
			} else {
				this.finalize(m, "failed", { cost, error: error ?? "ended without mission_submit" });
			}
		}
	}

	/** Role-specific prompt sections: template (D2), facet vocabulary, gap, conformance, curate. */
	private missionSections(m: MissionRow): Record<string, string> {
		const { store } = this.opts;
		const out: Record<string, string> = {};
		const activated = (m.spec.templates ?? []).flatMap((t) => {
			const template = getTemplate(store, t.id, t.version);
			if (!template) return [];
			return [{ template, exception: template.spec.applicability.exceptions.find((x) => x.id === t.exceptionId) }];
		});
		const tpl = renderTemplatesSection(activated, m.spec.bindings ?? [], m.spec.unboundCaps ?? []);
		if (tpl) out.template = tpl;
		if (m.role === "scout") {
			out.facets = lines([
				"<facets>",
				"Report mission_submit.fingerprint with these facet names (conf 0-1, src = how you know). A dimension that matters but is not listed may be reported under a new name; it is recorded as proposed.",
				...listFacets(store, "active").map((f) => `- ${f.name} (${f.type}: ${f.values.join("|")})`),
				"</facets>",
			]);
		}
		const g = m.spec.gap;
		if (g) {
			out.gap = lines([
				"<gap>",
				`gap_id: ${g.gapId}`,
				`capability: ${g.capId}`,
				`semantics: ${g.semantics}`,
				g.io ? `io: ${JSON.stringify(g.io)}` : "",
				...(g.acceptanceHints ?? []).map((h) => `acceptance hint: ${h}`),
				`Build the provider as a Skill under ${join(m.runDir, "quarantine")}/<name>/, run skill_validate, then provider_register.`,
				"</gap>",
			]);
		}
		const c = m.spec.conformance;
		if (c) {
			out.conformance = lines([
				"<conformance>",
				`Candidate provider: skill ${c.providerName} (${c.providerSha.slice(0, 8)}) at ${c.providerPath}`,
				`Capability: ${c.capId} — ${c.semantics}`,
				c.io ? `io: ${JSON.stringify(c.io)}` : "",
				...(c.acceptanceHints ?? []).map((h) => `acceptance hint: ${h}`),
				"Write your own conformance test with known answers (do not reuse the builder's tests), run it with test_run, and submit a pass claim citing passing runs, or a defect claim if the provider is wrong.",
				"</conformance>",
			]);
		}
		const dt = m.spec.deltaTask;
		if (dt) {
			out.delta = lines(["<delta>", `delta_id: ${dt.deltaId}`, `op: ${dt.op}`, `target: ${dt.target}`, `condition: ${dt.condition}`, dt.digest, "</delta>"]);
		}
		const k = m.spec.curate;
		if (k && !dt) {
			out.curate = lines([
				"<curate>",
				k.digest,
				`The kernel fixes the initial boundary (born narrow on this episode's discriminative facets) and the required capabilities (${k.capabilities.join(", ") || "none"}). You supply the method: card, intent_patterns, oracle, procedure (expect = process observations, never oracle values), verdict, body.`,
				"</curate>",
			]);
		}
		return out;
	}

	private statusFromEnvelope(env: Envelope): MissionStatus {
		return env.status === "completed" ? "completed" : env.status;
	}

	private finalize(
		m: MissionRow,
		status: MissionStatus,
		r: { envelope?: Envelope; cost: Cost; error: string | null; interruptReason?: "shutdown" | null },
	): void {
		const { store } = this.opts;
		try {
			store.tx(() => {
				voidUnfinishedTestRuns(store, m.id);
				updateMission(store, m.id, {
					status,
					envelope: r.envelope,
					cost: r.cost,
					error: r.error,
					interruptReason: r.interruptReason ?? null,
					endedAt: nowIso(),
					ownerPid: null,
				});
				audit(store, { actor: `mission:${m.id}`, event: "mission_end", decision: status, reason: r.error ?? undefined });
			});
		} catch {
			return; // store closed (shutdown); the next startup scan reconciles
		}
		this.opts.hooks.onMissionEnd(m.id);
	}
}
