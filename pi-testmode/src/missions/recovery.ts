/**
 * Crash recovery (plan M1-14, decision I-8: side effects at most once).
 *
 * Before a session is resumed, every orphan tool call (a call on the active branch without a
 * result) is reconciled against `tool_journal`:
 * - no journal row      → leave it; pi-ai synthesizes "No result provided" and the model may retry
 *                         (the gate never let it start, so nothing happened)
 * - started + finished  → append the recorded result; the call is not executed again
 * - started, read-only / idempotent → "interrupted, safe to re-run"
 * - started, side-effecting         → needs a human; the mission is parked as `blocked`
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { readEvidence } from "../harness/evidence.ts";
import type { Store } from "../store/db.ts";
import { getJournal, type JournalRow } from "../store/repos.ts";

export interface OrphanCall {
	toolCallId: string;
	toolName: string;
	journal?: JournalRow;
}

export type OrphanResolution =
	| { kind: "untracked"; call: OrphanCall }
	| { kind: "replay"; call: OrphanCall; result: { content: unknown[]; details: unknown; isError: boolean } }
	| { kind: "rerun_safe"; call: OrphanCall }
	| { kind: "unknown_side_effect"; call: OrphanCall };

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
}

/** Tool calls of the last assistant message on the active branch that have no result yet. */
export function findOrphanCalls(sm: SessionManager): Array<{ toolCallId: string; toolName: string }> {
	const branch = sm.getBranch();
	let lastAssistant = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && (e.message as { role?: string }).role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	if (lastAssistant < 0) return [];
	const msg = (branch[lastAssistant] as { message: { stopReason?: string; content?: unknown[] } }).message;
	// Error/aborted assistant messages are not replayed to the model, so their calls do not matter.
	if (msg.stopReason === "error" || msg.stopReason === "aborted") return [];
	const calls = (msg.content ?? []).filter((c): c is ToolCallBlock => (c as { type?: string }).type === "toolCall");
	const answered = new Set<string>();
	for (const e of branch.slice(lastAssistant + 1)) {
		if (e.type !== "message") continue;
		const m = e.message as { role?: string; toolCallId?: string };
		if (m.role === "toolResult" && m.toolCallId) answered.add(m.toolCallId);
	}
	return calls.filter((c) => !answered.has(c.id)).map((c) => ({ toolCallId: c.id, toolName: c.name }));
}

export function resolveOrphans(
	sm: SessionManager,
	store: Store,
	missionId: string,
	evidenceDir: string,
): OrphanResolution[] {
	return findOrphanCalls(sm).map(({ toolCallId, toolName }) => {
		const journal = getJournal(store, missionId, toolCallId);
		const call: OrphanCall = { toolCallId, toolName, journal };
		if (!journal) return { kind: "untracked", call };
		if (journal.status === "finished" && journal.resultRef) {
			const raw = readEvidence(evidenceDir, journal.resultRef);
			if (raw) {
				const parsed = JSON.parse(raw.toString("utf8")) as {
					content: unknown[];
					details: unknown;
					isError: boolean;
				};
				return { kind: "replay", call, result: parsed };
			}
		}
		if (journal.effectClass === "read_only" || journal.effectClass === "idempotent")
			return { kind: "rerun_safe", call };
		return { kind: "unknown_side_effect", call };
	});
}

const RERUN_TEXT =
	"[testmode recovery] This call was interrupted by a crash before it finished. It is read-only or idempotent, so it is safe to re-run if you still need the result.";
const UNKNOWN_TEXT =
	"[testmode recovery] This call was interrupted mid-execution and has side effects; its outcome is UNKNOWN. A human approved continuing. Reset the environment (or verify its state) before relying on anything this call may have changed. Do not assume it succeeded or failed.";

/** Appends tool results for resolved orphans. Untracked calls get none (pi-ai synthesizes one). */
export function applyResolutions(sm: SessionManager, resolutions: readonly OrphanResolution[]): void {
	for (const r of resolutions) {
		if (r.kind === "untracked") continue;
		const base = {
			role: "toolResult" as const,
			toolCallId: r.call.toolCallId,
			toolName: r.call.toolName,
			timestamp: Date.now(),
		};
		if (r.kind === "replay") {
			sm.appendMessage({
				...base,
				content: r.result.content as never,
				details: (r.result.details ?? undefined) as never,
				isError: r.result.isError,
			});
		} else {
			sm.appendMessage({
				...base,
				content: [{ type: "text", text: r.kind === "rerun_safe" ? RERUN_TEXT : UNKNOWN_TEXT }],
				isError: true,
			});
		}
	}
}

export function recoveryNote(resolutions: readonly OrphanResolution[], voidedTestRuns: number, reason: string): string {
	const replayed = resolutions.filter((r) => r.kind === "replay").map((r) => r.call.toolName);
	const rerun = resolutions.filter((r) => r.kind === "rerun_safe").map((r) => r.call.toolName);
	const unknown = resolutions.filter((r) => r.kind === "unknown_side_effect").map((r) => r.call.toolName);
	const lines = [`[testmode recovery] This mission was interrupted (${reason}) and has been resumed.`];
	if (replayed.length)
		lines.push(`- Completed before the interruption (results restored, not re-executed): ${replayed.join(", ")}`);
	if (rerun.length) lines.push(`- Interrupted, safe to re-run: ${rerun.join(", ")}`);
	if (unknown.length)
		lines.push(
			`- Interrupted with UNKNOWN side effects (reset or verify the environment first): ${unknown.join(", ")}`,
		);
	if (voidedTestRuns)
		lines.push(
			`- ${voidedTestRuns} test_run(s) in flight were voided (verdict inconclusive); run them again if needed.`,
		);
	lines.push(
		"Continue the mission from where it stopped and finish with mission_submit. Do not repeat completed side effects.",
	);
	return lines.join("\n");
}
