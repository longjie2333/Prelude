/**
 * Gate rules (plan M1-5, design §9), adapted from pi-testmode src/kernel/policy.ts (commit f5d01c7)
 * and @earendil-works/pi-coding-agent@1.4.0 examples/extensions/permission-gate.ts and
 * protected-paths.ts.
 *
 * `evaluateToolCall` is pure: the call and the context in, a decision out. `extension.ts` applies
 * it (approval dialogs, audit). Protected paths hold in every mode; hosts, installs, dangerous
 * commands and the canary only matter during a test, so normal coding sessions are not slowed.
 */
import { join } from "node:path";
import type { ProjectPaths } from "../paths.ts";
import { analyzeCommand, extractHosts } from "./command.ts";
import { canonicalPath, isInside } from "./paths.ts";
import { isHostAllowed, type Scope } from "./scope.ts";

export interface GateContext {
	testMode: boolean;
	cwd: string;
	home: string;
	project: ProjectPaths;
	kbDir: string;
	agentDir: string;
	extensionDir: string;
	canaryDir: string;
	scope?: Scope;
}

export interface Ask {
	kind: "host" | "install";
	/** `localhost:4100` or `npm:autocannon`; approvals are remembered by it. */
	subject: string;
	reason: string;
}

export type GateDecision = { action: "allow" } | { action: "block"; reason: string } | { action: "ask"; asks: Ask[] };

const ALLOW: GateDecision = { action: "allow" };
const block = (reason: string): GateDecision => ({ action: "block", reason });

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Tools whose effects are Prelude's own code, or that only load or call other (gated) tools. */
const TRUSTED_TOOLS = new Set([
	"test_progress",
	"finding_record",
	"verify_findings",
	"report_finalize",
	"review_verdict",
	"questionnaire",
	"tool_search",
	"codemode",
]);

/** Files only Prelude code writes, named in commands (best effort, for `cd .prelude && ...`). */
const PROTECTED_MENTION =
	/(\.prelude[\\/](scope\.json|audit\.jsonl|project\.json|runs\b|evidence\b|kb\b))|\bscope\.json\b|\baudit\.jsonl\b/i;
const MUTATING =
	/\b(rm|mv|cp|del|move|copy|truncate|tee|ln|chmod|sed\s+-i|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|writeFile\w*|appendFile\w*)\b/i;

function credentialPaths(ctx: GateContext): string[] {
	return [
		join(ctx.home, ".ssh"),
		join(ctx.home, ".aws"),
		join(ctx.home, ".gnupg"),
		join(ctx.home, ".config", "gcloud"),
		join(ctx.home, ".git-credentials"),
		join(ctx.agentDir, "auth.json"),
	];
}

export function readDenial(ctx: GateContext, rawPath: string | undefined): string | undefined {
	const c = (x: string) => canonicalPath(x, ctx.cwd, ctx.home);
	const p = c(rawPath || ".");
	if (credentialPaths(ctx).some((s) => isInside(p, c(s)))) return `${rawPath} holds credentials`;
	if (ctx.testMode && isInside(p, c(ctx.canaryDir)))
		return "the canary is a system under test: test it through its interface, not its source";
	return undefined;
}

/** Why the model may not write `rawPath`, or undefined when it may. */
export function writeDenial(ctx: GateContext, rawPath: string): string | undefined {
	const c = (x: string) => canonicalPath(x, ctx.cwd, ctx.home);
	const p = c(rawPath);
	const P = ctx.project;
	if (p === c(P.scopeFile)) return "scope.json is maintained by the user only";
	if (p === c(P.auditFile)) return "audit.jsonl is written by Prelude only";
	if (p === c(P.projectFile)) return "project.json is written by /prelude-init only";
	if (isInside(p, c(P.runsDir))) return "run state is written by Prelude tools only (finding_record, verify_findings)";
	if (isInside(p, c(P.evidenceDir))) return "evidence is stored by finding_record only";
	if (isInside(p, c(ctx.kbDir))) return "the knowledge base is written through Prelude kb_* tools only";
	// The extension may be the project itself (D-10): its own .prelude/ stays writable.
	if (ctx.testMode && isInside(p, c(ctx.extensionDir)) && !isInside(p, c(P.dir)))
		return "the Prelude extension directory is read-only during a test";
	return undefined;
}

function mentionsCanary(cmd: string, ctx: GateContext): boolean {
	const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
	if (norm(cmd).includes(norm(ctx.canaryDir))) return true;
	if (/\bbugs\.json\b/i.test(cmd)) return true;
	const inExtension = isInside(
		canonicalPath(ctx.cwd, ctx.cwd, ctx.home),
		canonicalPath(ctx.extensionDir, ctx.cwd, ctx.home),
	);
	return inExtension && /(^|[\s"'=/\\])canary[\\/]/i.test(cmd);
}

function scopeAsks(ctx: GateContext, hosts: string[], installs: string[]): Ask[] {
	const asks: Ask[] = [];
	for (const h of hosts) {
		if (!isHostAllowed(ctx.scope, h))
			asks.push({ kind: "host", subject: h, reason: `${h} is not in .prelude/scope.json` });
	}
	for (const i of installs) asks.push({ kind: "install", subject: i, reason: `first install of ${i}` });
	return asks;
}

function evaluateShell(command: string, ctx: GateContext, tool: string): GateDecision {
	const a = analyzeCommand(command);
	if (ctx.testMode && a.dangerous) return block(`dangerous command blocked: ${a.dangerous}`);
	for (const target of a.writeTargets) {
		const denial = writeDenial(ctx, target);
		if (denial) return block(`${tool} writes ${target}: ${denial}`);
	}
	if (PROTECTED_MENTION.test(command) && (a.writeTargets.length > 0 || MUTATING.test(command)))
		return block("commands that modify Prelude-protected files are blocked");
	if (!ctx.testMode) return ALLOW;
	if (mentionsCanary(command, ctx))
		return block("the canary is a system under test: test it through its interface, not its source");
	const asks = scopeAsks(ctx, a.hosts, a.installs);
	return asks.length ? { action: "ask", asks } : ALLOW;
}

export function evaluateToolCall(toolName: string, input: Record<string, unknown>, ctx: GateContext): GateDecision {
	if (READ_TOOLS.has(toolName)) {
		const denial = readDenial(ctx, input.path as string | undefined);
		return denial ? block(denial) : ALLOW;
	}
	if (WRITE_TOOLS.has(toolName)) {
		const path = input.path;
		if (typeof path !== "string" || !path) return block(`${toolName} without a path`);
		const denial = writeDenial(ctx, path);
		return denial ? block(denial) : ALLOW;
	}
	if (SHELL_TOOLS.has(toolName)) {
		const command = input.command;
		if (typeof command !== "string") return block(`${toolName} without a command`);
		return evaluateShell(command, ctx, toolName);
	}
	if (TRUSTED_TOOLS.has(toolName) || !ctx.testMode) return ALLOW;
	// MCP and other extension tools: their semantics are unknown, but a URL they are handed is not.
	const asks = scopeAsks(ctx, extractHosts(JSON.stringify(input)), []);
	return asks.length ? { action: "ask", asks } : ALLOW;
}
