/**
 * Policy gate extension factory (plan M1-6), loaded by the main session and by every mission.
 * Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/permission-gate.ts.
 *
 * - `tool_call`: evaluate rules, ask for approval when needed, audit, journal `started`.
 * - `tool_result`: journal `finished` with a digest and an evidence copy of the result (M1-14).
 * A handler error blocks the call (fail-closed).
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { putEvidence } from "../harness/evidence.ts";
import type { Store } from "../store/db.ts";
import { audit, journalFinish, journalStart } from "../store/repos.ts";
import type { Actor } from "../types.ts";
import { digest, errorMessage } from "../util.ts";
import type { ApprovalOutcome, ApprovalRequest } from "./approvals.ts";
import { evaluateToolCall, type PolicyContext } from "./policy.ts";

export interface PolicyHost {
	/** Undefined in normal mode until test mode opened the store. */
	store(): Store | undefined;
	context(): PolicyContext;
	actor(): Actor;
	approve(req: ApprovalRequest): Promise<ApprovalOutcome>;
	/** Journal tool calls for crash recovery (missions only). */
	journal?: { missionId: string; evidenceDir: string };
	/** Extra kernel check run first (MCP tool-definition hash lock); returns a block reason. */
	guard?(pi: ExtensionAPI, toolName: string): string | undefined;
}

export function policyExtension(host: PolicyHost): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event) => {
			const input = event.input as Record<string, unknown>;
			const inputDigest = digest(input);
			let ctx: PolicyContext;
			try {
				ctx = host.context();
				const annotations = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
				if (annotations) ctx = { ...ctx, annotations };
			} catch (err) {
				return { block: true, reason: `policy unavailable (fail-closed): ${errorMessage(err)}` };
			}
			const store = host.store();
			const actor = host.actor();
			const record = (decision: string, reason: string) => {
				if (!store) return;
				if (ctx.mode === "normal" && decision === "allow") return;
				audit(store, { actor, event: "tool_call", tool: event.toolName, inputDigest, decision, reason });
			};

			try {
				const guarded = host.guard?.(pi, event.toolName);
				if (guarded) {
					record("block", guarded);
					return { block: true, reason: guarded };
				}
				let decision = evaluateToolCall(event.toolName, input, ctx);
				if (decision.action === "ask") {
					const outcome = await host.approve({
						actor,
						missionId: ctx.missionId,
						tier: decision.tier,
						subject: decision.subject ?? `${event.toolName}:${inputDigest.slice(0, 16)}`,
						title: `${actor} wants to run ${event.toolName}`,
						detail: `${decision.reason}\n\n${summarizeInput(event.toolName, input)}`,
					});
					decision = outcome.approved
						? { ...decision, action: "allow", reason: `${decision.reason}; approved (${outcome.scope})` }
						: { ...decision, action: "block", reason: `${decision.reason}; ${outcome.reason}` };
				}
				record(decision.action, `${decision.tier} ${decision.effect}: ${decision.reason}`);
				if (decision.action === "block") return { block: true, reason: decision.reason };
				if (host.journal && store) {
					journalStart(store, {
						missionId: host.journal.missionId,
						toolCallId: event.toolCallId,
						tool: event.toolName,
						inputDigest,
						effectClass: decision.effect,
					});
				}
				return undefined;
			} catch (err) {
				const reason = `policy error (fail-closed): ${errorMessage(err)}`;
				try {
					record("block", reason);
				} catch {
					// the block below still applies
				}
				return { block: true, reason };
			}
		});

		pi.on("tool_result", async (event) => {
			const store = host.store();
			if (!host.journal || !store) return undefined;
			const result = { content: event.content, details: event.details ?? null, isError: event.isError };
			try {
				const ref = putEvidence(store, host.journal.evidenceDir, JSON.stringify(result), {
					missionId: host.journal.missionId,
					kind: "tool_result",
				});
				journalFinish(store, {
					missionId: host.journal.missionId,
					toolCallId: event.toolCallId,
					isError: event.isError,
					resultDigest: ref.sha256,
					resultRef: ref.sha256,
				});
			} catch {
				// The journal is best effort on the result side: a missing `finished` row only makes
				// recovery more conservative.
			}
			return undefined;
		});
	};
}

function summarizeInput(tool: string, input: Record<string, unknown>): string {
	if (typeof input.command === "string") return `${tool}: ${input.command.slice(0, 500)}`;
	if (typeof input.path === "string") return `${tool}: ${input.path}`;
	return `${tool}: ${JSON.stringify(input).slice(0, 500)}`;
}
