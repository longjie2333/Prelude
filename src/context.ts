/**
 * Per-session Prelude state shared by the mode, the tools and the gate: which project, whether a
 * test is running, the current run, approvals given in this session, and the model runtime for
 * review sub-sessions.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendAudit, type AuditEvent } from "./audit.ts";
import { gateExtension, summarizeInput } from "./guard/extension.ts";
import type { Ask, GateContext } from "./guard/gate.ts";
import { addScopeTarget, loadScope } from "./guard/scope.ts";
import { CANARY_DIR, EXTENSION_DIR, globalPaths, type ProjectPaths, projectPaths } from "./paths.ts";
import { readConfig } from "./kb/config.ts";
import { Kb } from "./kb/sync.ts";
import { Run } from "./run.ts";

export interface PreludeOptions {
	/** Overrides the home directory for `~/.prelude/` and credential paths (tests). */
	home?: string;
	/** Overrides `getAgentDir()` (tests). */
	agentDir?: string;
	/** Model runtime for review sub-sessions; defaults to one on the agent dir. */
	modelRuntime?: () => Promise<ModelRuntime>;
	/** Reruns per finding and per-run timeout (plan M1-7: 3 runs, 120 s). */
	rerun?: { runs?: number; timeoutMs?: number };
}

export class Prelude {
	readonly options: PreludeOptions;
	enabled = false;
	runId: string | undefined;
	ctx: ExtensionContext | undefined;
	/** Approvals given in dialogs during this session, by `Ask.subject`. */
	readonly approved = new Set<string>();
	private runtime: Promise<ModelRuntime> | undefined;
	private kbInstance: Kb | undefined;

	constructor(options: PreludeOptions = {}) {
		this.options = options;
	}

	get home(): string {
		return this.options.home ?? homedir();
	}

	/**
	 * Parent of `.prelude/` (config, knowledge base). `PRELUDE_HOME` moves it without moving
	 * `home`, so a test run cannot touch the user's real knowledge base while the credential
	 * paths the gate protects stay where they are.
	 */
	get preludeHome(): string {
		return this.options.home ?? process.env.PRELUDE_HOME ?? homedir();
	}

	get agentDir(): string {
		return this.options.agentDir ?? getAgentDir();
	}

	get cwd(): string {
		if (!this.ctx) throw new Error("Prelude has no session yet");
		return this.ctx.cwd;
	}

	get project(): ProjectPaths {
		return projectPaths(this.cwd);
	}

	isInitialized(): boolean {
		return existsSync(this.project.projectFile);
	}

	/** The current run; throws outside test mode so tools fail with a clear message. */
	run(): Run {
		if (!this.enabled || !this.runId) throw new Error("no Prelude test is running; start one with /test <goal>");
		return new Run(this.project, this.runId);
	}

	/** The knowledge base from `~/.prelude/config.json`, or undefined before /prelude-init set it up. */
	kb(): Kb | undefined {
		if (this.kbInstance) return this.kbInstance;
		const config = readConfig(this.preludeHome)?.kb;
		if (!config || !existsSync(join(config.dir, ".git"))) return undefined;
		this.kbInstance = new Kb(config, (e) => this.audit(e), this.preludeHome);
		return this.kbInstance;
	}

	setKb(kb: Kb): void {
		this.kbInstance = kb;
	}

	requireKb(): Kb {
		const kb = this.kb();
		if (!kb) throw new Error("no knowledge base yet; run /prelude-init");
		return kb;
	}

	gateContext(): GateContext {
		const cwd = this.ctx?.cwd ?? process.cwd();
		const project = projectPaths(cwd);
		return {
			testMode: this.enabled,
			cwd,
			home: this.home,
			project,
			kbDir: this.kb()?.dir ?? globalPaths(this.preludeHome).kbDir,
			agentDir: this.agentDir,
			extensionDir: EXTENSION_DIR,
			canaryDir: CANARY_DIR,
			scope: loadScope(project.scopeFile).scope,
		};
	}

	/** Audit lines go to an initialized project only; a plain coding session gets no `.prelude/`. */
	audit(event: AuditEvent): void {
		const cwd = this.ctx?.cwd ?? process.cwd();
		const p = projectPaths(cwd);
		if (!existsSync(p.projectFile)) return;
		appendAudit(p.auditFile, { ...(this.runId && this.enabled ? { run: this.runId } : {}), ...event });
	}

	/**
	 * Settles asks with the user. Hosts can be added to scope.json from the dialog (D-11); without a
	 * UI nothing new is approved.
	 */
	async resolve(asks: Ask[], tool: string, input: Record<string, unknown>): Promise<string | undefined> {
		for (const ask of asks) {
			if (this.approved.has(ask.subject)) continue;
			const ctx = this.ctx;
			if (!ctx?.hasUI) return `${ask.reason}; no user is present to approve it`;
			const options =
				ask.kind === "host"
					? ["Add to scope.json", "Allow this session", "Block"]
					: ["Allow this session", "Block"];
			const choice = await ctx.ui.select(
				`${ask.kind === "host" ? "Allow host" : "Allow install"} ${ask.subject}?\n\n${summarizeInput(tool, input)}`,
				options,
			);
			if (choice === "Add to scope.json") addScopeTarget(this.project.scopeFile, ask.subject);
			if (choice !== "Add to scope.json" && choice !== "Allow this session") {
				this.audit({ event: "approval", decision: "deny", detail: { subject: ask.subject } });
				return `${ask.reason}; the user declined. Do not retry; note it under 没测什么 in the report`;
			}
			this.approved.add(ask.subject);
			this.audit({ event: "approval", decision: "allow", detail: { subject: ask.subject, choice } });
		}
		return undefined;
	}

	/** The gate for this session and for review sub-sessions (which share approvals but never ask). */
	gate(options: { interactive: boolean } = { interactive: true }) {
		return gateExtension({
			context: () => this.gateContext(),
			resolve: async (asks, tool, input) => {
				if (options.interactive) return this.resolve(asks, tool, input);
				const open = asks.find((a) => !this.approved.has(a.subject));
				return open ? `${open.reason}; reviewers cannot ask for approval` : undefined;
			},
			audit: (e) => this.audit(e),
		});
	}

	modelRuntime(): Promise<ModelRuntime> {
		if (this.options.modelRuntime) return this.options.modelRuntime();
		this.runtime ??= ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
		});
		return this.runtime;
	}

	model(): Model<string> {
		const m = this.ctx?.model;
		if (!m) throw new Error("no model selected; the reviewer uses the session's model");
		return m as Model<string>;
	}
}
