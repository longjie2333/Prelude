/**
 * Gate as an extension factory (plan M1-5, M1-7), loaded by the main session and by every review
 * sub-session. Adapted from @earendil-works/pi-coding-agent@1.4.0
 * examples/extensions/permission-gate.ts.
 *
 * `tool_call` sees direct calls and the nested calls of codemode and MCP alike. A handler error
 * blocks the call (fail-closed).
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AuditEvent } from "../audit.ts";
import { digest, errorMessage } from "../util.ts";
import { type Ask, evaluateToolCall, type GateContext } from "./gate.ts";

export interface GateHost {
	context(): GateContext;
	/** Settles every ask; returns a block reason, or undefined when all were approved. */
	resolve(asks: Ask[], tool: string, input: Record<string, unknown>): Promise<string | undefined>;
	audit(event: AuditEvent): void;
}

/** Seconds a test-mode shell call may run when the model sets no timeout (D-25). */
export const DEFAULT_SHELL_TIMEOUT_S = 600;

/**
 * pi's bash/powershell have no default timeout. In a real run a command that started a GUI
 * program (Chromium) never returned and stalled the test for 13 minutes; a default bounds that
 * without limiting calls that ask for longer.
 */
export function capShellTimeout(toolName: string, input: Record<string, unknown>): void {
	if (toolName !== "bash" && toolName !== "powershell") return;
	if (input.timeout === undefined) input.timeout = DEFAULT_SHELL_TIMEOUT_S;
}

export function gateExtension(host: GateHost): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event) => {
			const input = event.input as Record<string, unknown>;
			let testMode = true;
			try {
				const ctx = host.context();
				testMode = ctx.testMode;
				const inputDigest = digest(input);
				const record = (decision: string, reason?: string) => {
					if (testMode || decision !== "allow")
						host.audit({ event: "tool_call", tool: event.toolName, decision, reason, inputDigest });
				};
				const decision = evaluateToolCall(event.toolName, input, ctx);
				if (decision.action === "block") {
					record("block", decision.reason);
					return { block: true, reason: decision.reason };
				}
				if (decision.action === "ask") {
					const denied = await host.resolve(decision.asks, event.toolName, input);
					const subjects = decision.asks.map((a) => a.subject).join(", ");
					if (denied) {
						record("block", `${subjects}: ${denied}`);
						return { block: true, reason: denied };
					}
					record("allow", `approved: ${subjects}`);
					if (testMode) capShellTimeout(event.toolName, input);
					return undefined;
				}
				record("allow");
				if (testMode) capShellTimeout(event.toolName, input);
				return undefined;
			} catch (err) {
				const reason = `Prelude gate error (fail-closed): ${errorMessage(err)}`;
				try {
					host.audit({ event: "tool_call", tool: event.toolName, decision: "block", reason });
				} catch {
					// the block below still applies
				}
				return { block: true, reason };
			}
		});
	};
}

export function summarizeInput(tool: string, input: Record<string, unknown>): string {
	if (typeof input.command === "string") return `${tool}: ${input.command.slice(0, 400)}`;
	if (typeof input.path === "string") return `${tool}: ${input.path}`;
	return `${tool}: ${JSON.stringify(input).slice(0, 400)}`;
}
