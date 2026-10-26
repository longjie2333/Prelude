/**
 * Mission budget accounting (plan M1-8, decision I-28): warn at 80%, ask for submission at 100%.
 *
 * Every turn resends the whole conversation, so summing prompt tokens counts the same context
 * again on each turn (8–13× over in the 2026-10-26 smoke run). The budget instead counts new
 * tokens: how much the prompt grew beyond the previous prompt plus its output (new tool results,
 * steering, a compaction summary), plus the tokens the model generates. `processed` keeps the
 * billed total for cost reporting.
 */
import type { Budget, Cost } from "../types.ts";
import { EMPTY_COST } from "../types.ts";

export type BudgetState = "ok" | "warn" | "exceeded";

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

export class BudgetTracker {
	private cost: Cost;
	private readonly startedAt: number;
	private warned = false;

	readonly budget: Budget;

	constructor(budget: Budget, previous: Partial<Cost> = EMPTY_COST, now = Date.now()) {
		this.budget = budget;
		// Rows written before I-28 lack the new fields.
		this.cost = { ...EMPTY_COST, ...previous };
		// Resumed missions keep the wall clock they already spent.
		this.startedAt = now - this.cost.wallClockMs;
	}

	addUsage(usage: UsageLike | undefined): void {
		if (!usage) return;
		const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const output = usage.output ?? 0;
		// After compaction the prompt shrinks: growth is measured from the smaller prompt onwards.
		const growth = Math.max(0, prompt - this.cost.context);
		this.cost.tokens += growth + output;
		this.cost.processed += prompt + output;
		this.cost.input += prompt;
		this.cost.output += output;
		this.cost.costUsd += usage.cost?.total ?? 0;
		this.cost.turns += 1;
		this.cost.context = prompt + output;
	}

	snapshot(now = Date.now()): Cost {
		return { ...this.cost, wallClockMs: now - this.startedAt };
	}

	fraction(now = Date.now()): number {
		const c = this.snapshot(now);
		const parts = [c.tokens / this.budget.tokens, c.wallClockMs / this.budget.wallClockMs];
		if (this.budget.costUsd) parts.push(c.costUsd / this.budget.costUsd);
		return Math.max(...parts);
	}

	state(now = Date.now()): BudgetState {
		const f = this.fraction(now);
		return f >= 1 ? "exceeded" : f >= 0.8 ? "warn" : "ok";
	}

	/** True exactly once, the first time the budget crosses 80%. */
	shouldWarn(now = Date.now()): boolean {
		if (this.warned || this.state(now) === "ok") return false;
		this.warned = true;
		return true;
	}
}
