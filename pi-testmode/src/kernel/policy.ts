/**
 * Policy gate rules (plan M1-6), adapted from
 * @earendil-works/pi-coding-agent@1.4.0 examples/extensions/permission-gate.ts and protected-paths.ts.
 *
 * `evaluateToolCall` is a pure function: given the call and the policy context it returns a
 * decision. The extension in `policy-extension.ts` applies it (approval, audit, journal).
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import type { EffectClass, RiskTier } from "../types.ts";
import { RISK_ORDER } from "../types.ts";
import { analyzeCommand } from "./command.ts";
import { canonicalPath, isInside } from "./paths.ts";
import { isEgressAllowed, type Scope } from "./scope.ts";

export type PolicyMode = "normal" | "testmode-main" | "mission";

export interface PolicyContext {
	mode: PolicyMode;
	cwd: string;
	home: string;
	/** `<root>/.pi/testmode` */
	testmodeDir: string;
	scopeFile: string;
	globalDir: string;
	agentDir: string;
	extensionDir: string;
	runsDir: string;
	missionId?: string;
	/** The mission's run directory, the only place a mission may write. */
	runDir?: string;
	missionTier?: RiskTier;
	scope?: Scope;
	/** Canonical paths of frozen artifacts. */
	frozen: ReadonlySet<string>;
	/** Tool annotations, e.g. from MCP servers. */
	annotations?: ToolAnnotations;
}

export interface PolicyDecision {
	action: "allow" | "block" | "ask";
	tier: RiskTier;
	effect: EffectClass;
	reason: string;
	/** Key for approvals; approval reuse is keyed on it. */
	subject?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Tools of this package, classified by contract (their writes go through controlled DB code). */
const TESTMODE_TOOLS: Record<string, { effect: EffectClass; tier: RiskTier }> = {
	intent_record: { effect: "idempotent", tier: "R0" },
	questionnaire: { effect: "read_only", tier: "R0" },
	mission_dispatch: { effect: "idempotent", tier: "R0" },
	mission_status: { effect: "read_only", tier: "R0" },
	report_finalize: { effect: "idempotent", tier: "R0" },
	knowledge_search: { effect: "read_only", tier: "R0" },
	mission_submit: { effect: "idempotent", tier: "R0" },
	artifact_freeze: { effect: "idempotent", tier: "R0" },
	capability_request: { effect: "idempotent", tier: "R0" },
	template_propose: { effect: "idempotent", tier: "R0" },
	delta_propose: { effect: "idempotent", tier: "R0" },
	skill_validate: { effect: "read_only", tier: "R0" },
	provider_register: { effect: "idempotent", tier: "R0" },
};

const DB_FILE = /\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i;

function block(reason: string, tier: RiskTier = "R0", effect: EffectClass = "side_effecting"): PolicyDecision {
	return { action: "block", tier, effect, reason };
}

function higher(a: RiskTier, b: RiskTier): boolean {
	return RISK_ORDER.indexOf(a) > RISK_ORDER.indexOf(b);
}

function sensitiveReadPaths(ctx: PolicyContext): string[] {
	return [
		join(ctx.home, ".ssh"),
		join(ctx.home, ".aws"),
		join(ctx.home, ".gnupg"),
		join(ctx.home, ".config", "gcloud"),
		join(ctx.agentDir, "auth.json"),
	].map((p) => canonicalPath(p, ctx.cwd, ctx.home));
}

function readDenial(ctx: PolicyContext, rawPath: string | undefined): string | undefined {
	const p = canonicalPath(rawPath || ".", ctx.cwd, ctx.home);
	if (sensitiveReadPaths(ctx).some((s) => isInside(p, s))) return `reading ${rawPath} is denied (credentials)`;
	if (ctx.mode !== "normal" && DB_FILE.test(p)) return "knowledge databases are read through testmode tools only";
	if (ctx.mode === "mission" && ctx.runDir) {
		const runs = canonicalPath(ctx.runsDir, ctx.cwd, ctx.home);
		const own = canonicalPath(ctx.runDir, ctx.cwd, ctx.home);
		if (isInside(p, runs) && !isInside(p, own) && basename(p) === "session.jsonl") {
			return "missions may not read another mission's conversation (context isolation)";
		}
	}
	return undefined;
}

/**
 * Why an agent may not write `rawPath`, or undefined when it may. `allowTemp` lets missions'
 * shell commands use the system temp directory; protected paths stay protected there too.
 */
export function writeDenial(ctx: PolicyContext, rawPath: string, allowTemp = false): string | undefined {
	const p = canonicalPath(rawPath, ctx.cwd, ctx.home);
	const c = (x: string) => canonicalPath(x, ctx.cwd, ctx.home);
	if (p === c(ctx.scopeFile)) return "scope.json is maintained by humans only";
	if (DB_FILE.test(p)) return "database files are written by testmode code only";
	if (isInside(p, c(ctx.extensionDir))) return "the pi-testmode extension directory is read-only for agents";
	if (ctx.frozen.has(p)) return `${rawPath} is a frozen test artifact`;
	if (isInside(p, c(ctx.globalDir))) return "the global testmode layer is written by testmode code only";

	if (ctx.mode === "normal") {
		return isInside(p, c(ctx.testmodeDir)) ? "testmode runtime data is written by testmode code only" : undefined;
	}
	if (ctx.mode === "testmode-main") return "in test mode the main session does not write files; dispatch a mission";
	if (!ctx.runDir) return "mission has no run directory";
	if (isInside(p, c(ctx.runDir))) return undefined;
	if (allowTemp && isInside(p, c(tmpdir())) && !isInside(p, c(ctx.cwd))) return undefined;
	return `missions may only write inside their run directory (${ctx.runDir})`;
}

function evaluateShell(command: string, ctx: PolicyContext, toolName: string): PolicyDecision {
	const a = analyzeCommand(command);
	if (a.dangerous) return block(`dangerous command blocked: ${a.dangerous}`, "R4");

	for (const target of a.writeTargets) {
		const denial = writeDenial(ctx, target, true);
		if (denial) return block(`${toolName} write to ${target} blocked: ${denial}`);
	}
	// Best effort: a command that names protected files and mutates something is refused outright.
	const mentionsProtected = /scope\.json|\.db\b|\.sqlite\b/i.test(command);
	if (mentionsProtected && (a.writeTargets.length > 0 || /\b(rm|mv|cp|sed\s+-i|sqlite3|truncate|Remove-Item|Set-Content|del)\b/i.test(command))) {
		return block("commands that modify scope.json or knowledge databases are blocked");
	}

	if (ctx.mode === "normal") return { action: "allow", tier: "R2", effect: a.readOnly ? "read_only" : "side_effecting", reason: "normal mode" };
	if (ctx.mode === "testmode-main") return block("in test mode the main session does not run commands; dispatch a mission");

	for (const host of a.hosts) {
		if (!isEgressAllowed(ctx.scope, host)) {
			return {
				action: "ask",
				tier: "R4",
				effect: "side_effecting",
				reason: `${host} is not in the authorization scope or egress allowlist`,
				subject: `host:${host}`,
			};
		}
	}
	if (a.installs.length > 0) {
		return {
			action: "ask",
			tier: "R2",
			effect: "side_effecting",
			reason: `first use of an external dependency: ${a.installs[0]}`,
			subject: `dep:${a.installs[0]}`,
		};
	}

	let effect: EffectClass;
	let tier: RiskTier;
	if (a.readOnly) {
		effect = "read_only";
		tier = a.hosts.length > 0 ? "R1" : "R0";
	} else if (a.mutatingHttp) {
		effect = "side_effecting";
		tier = "R3";
	} else {
		// Writes confined to the run directory are idempotent; anything else is unknown.
		effect = a.writeTargets.length > 0 && a.hosts.length === 0 ? "idempotent" : "side_effecting";
		tier = "R2";
	}
	if (ctx.missionTier && higher(tier, ctx.missionTier)) {
		return {
			action: "ask",
			tier,
			effect,
			reason: `operation needs ${tier} but the mission was authorized at ${ctx.missionTier}`,
			subject: `escalate:${ctx.missionId}:${tier}`,
		};
	}
	return { action: "allow", tier, effect, reason: "within mission authorization" };
}

function evaluateByAnnotations(toolName: string, ann: ToolAnnotations | undefined, ctx: PolicyContext): PolicyDecision {
	// Missing hints take the MCP defaults: not read-only, possibly destructive, possibly open-world.
	let effect: EffectClass;
	let tier: RiskTier;
	if (ann?.readOnlyHint === true) {
		effect = "read_only";
		tier = "R1";
	} else if (ann?.destructiveHint === true) {
		effect = "side_effecting";
		tier = "R4";
	} else if (ann?.openWorldHint === false && ann?.idempotentHint === true) {
		effect = "idempotent";
		tier = "R2";
	} else {
		effect = "side_effecting";
		tier = "R3";
	}
	if (ctx.mode === "testmode-main" && effect !== "read_only") {
		return block(`in test mode the main session only uses read-only tools; ${toolName} is not read-only`, tier, effect);
	}
	if (ctx.mode === "mission" && ctx.missionTier && higher(tier, ctx.missionTier)) {
		return { action: "ask", tier, effect, reason: `${toolName} needs ${tier}; mission authorized at ${ctx.missionTier}`, subject: `tool:${toolName}` };
	}
	if (tier === "R4" && ctx.mode === "mission") {
		return { action: "ask", tier, effect, reason: `${toolName} is marked destructive`, subject: `tool:${toolName}` };
	}
	return { action: "allow", tier, effect, reason: "annotation-based" };
}

export function evaluateToolCall(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): PolicyDecision {
	if (READ_TOOLS.has(toolName)) {
		const denial = readDenial(ctx, input.path as string | undefined);
		if (denial) return block(denial, "R0", "read_only");
		return { action: "allow", tier: "R0", effect: "read_only", reason: "read-only tool" };
	}

	if (WRITE_TOOLS.has(toolName)) {
		const path = input.path;
		if (typeof path !== "string" || !path) return block(`${toolName} without a path`);
		const denial = writeDenial(ctx, path);
		if (denial) return block(denial);
		return { action: "allow", tier: "R0", effect: "idempotent", reason: ctx.mode === "mission" ? "write inside run directory" : "normal mode" };
	}

	if (SHELL_TOOLS.has(toolName)) {
		const command = input.command;
		if (typeof command !== "string") return block(`${toolName} without a command`);
		return evaluateShell(command, ctx, toolName);
	}

	if (toolName === "test_run") {
		const command = input.command;
		if (typeof command !== "string") return block("test_run without a command");
		if (ctx.mode !== "mission") return block("test_run only runs inside missions");
		const d = evaluateShell(command, ctx, toolName);
		if (d.action === "block" || d.subject?.startsWith("host:") || d.subject?.startsWith("dep:")) return d;
		// Decision I-10: test_run against the mission's exclusive test environment is idempotent by contract.
		return { ...d, action: "allow", effect: "idempotent", reason: "test_run in the mission's test environment" };
	}

	const own = TESTMODE_TOOLS[toolName];
	if (own) return { action: "allow", ...own, reason: "testmode tool" };

	if (toolName === "tool_search") {
		return { action: "allow", tier: "R0", effect: "read_only", reason: "loader tool" };
	}
	if (toolName === "codemode") {
		// Nested calls are gated and journaled individually; the script itself is unknown, so a crash
		// inside it is treated as side-effecting.
		return { action: "allow", tier: "R0", effect: "side_effecting", reason: "codemode script; nested calls gated individually" };
	}

	if (ctx.mode === "normal") return { action: "allow", tier: "R2", effect: "side_effecting", reason: "normal mode" };
	return evaluateByAnnotations(toolName, ctx.annotations, ctx);
}
