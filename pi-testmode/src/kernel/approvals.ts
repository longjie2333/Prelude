/**
 * Risk-tiered approvals (agent-core §11.1, plan M1-6). Missions have no UI: they call
 * `request()`, which asks on the main session's UI when one is attached and denies otherwise.
 * Requests are serialized so concurrent missions never stack dialogs.
 */
import type { Store } from "../store/db.ts";
import { audit, hasStandingApproval, insertApproval } from "../store/repos.ts";
import type { Actor, RiskTier } from "../types.ts";
import { newId } from "../util.ts";

export interface ApprovalRequest {
	actor: Actor;
	missionId?: string;
	tier: RiskTier;
	/** Stable key; repeated approvals of the same subject are reused per scope. */
	subject: string;
	title: string;
	detail: string;
}

export interface ApprovalUI {
	select(title: string, options: string[]): Promise<string | undefined>;
}

export type ApprovalOutcome = { approved: true; scope: "once" | "session" | "always" | "standing" } | { approved: false; reason: string };

const ONCE = "Allow once";
const SESSION = "Allow for this session";
const ALWAYS = "Always allow";
const DENY = "Deny";

export class Approvals {
	private readonly sessionApproved = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();

	private readonly store: Store;
	private readonly getUI: () => ApprovalUI | undefined;

	constructor(store: Store, getUI: () => ApprovalUI | undefined) {
		this.store = store;
		this.getUI = getUI;
	}

	request(req: ApprovalRequest): Promise<ApprovalOutcome> {
		const run = this.queue.then(() => this.decide(req));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async decide(req: ApprovalRequest): Promise<ApprovalOutcome> {
		// R4 always needs a human decision; only lower tiers reuse standing approvals.
		if (req.tier !== "R4" && hasStandingApproval(this.store, req.subject)) return { approved: true, scope: "standing" };
		if (this.sessionApproved.has(req.subject)) return { approved: true, scope: "session" };

		const ui = this.getUI();
		if (!ui) {
			this.record(req, "denied", "once", "no UI to ask");
			return { approved: false, reason: "approval required but no interactive UI is attached (denied by default)" };
		}
		const options = req.tier === "R4" ? [ONCE, SESSION, DENY] : [ONCE, SESSION, ALWAYS, DENY];
		let choice: string | undefined;
		try {
			choice = await ui.select(`[${req.tier}] ${req.title}\n\n${req.detail}`, options);
		} catch {
			choice = undefined;
		}
		if (choice === ONCE || choice === SESSION || choice === ALWAYS) {
			const scope = choice === ONCE ? "once" : choice === SESSION ? "session" : "always";
			if (scope === "session") this.sessionApproved.add(req.subject);
			this.record(req, "approved", scope);
			return { approved: true, scope };
		}
		this.record(req, "denied", "once", choice === DENY ? "denied by user" : "dialog dismissed");
		return { approved: false, reason: choice === DENY ? "denied by user" : "approval dialog dismissed" };
	}

	private record(req: ApprovalRequest, decision: "approved" | "denied", scope: "once" | "session" | "always", reason?: string): void {
		this.store.tx(() => {
			insertApproval(this.store, { id: newId("ap"), missionId: req.missionId ?? null, tier: req.tier, subject: req.subject, decision, scope });
			audit(this.store, { actor: req.actor, event: "approval", decision, reason: `${req.subject} (${scope})${reason ? `: ${reason}` : ""}` });
		});
	}
}
