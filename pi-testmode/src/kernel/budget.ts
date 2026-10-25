/** Mission budget accounting (plan M1-8): warn at 80%, stop at 100%. */
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

	constructor(budget: Budget, previous: Cost = EMPTY_COST, now = Date.now()) {
		this.budget = budget;
		this.cost = { ...previous };
		// Resumed missions keep the wall clock they already spent.
		this.startedAt = now - previous.wallClockMs;
	}

	addUsage(usage: UsageLike | undefined): void {
		if (!usage) return;
		const input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const output = usage.output ?? 0;
		this.cost.input += input;
		this.cost.output += output;
		this.cost.tokens += usage.totalTokens ?? input + output;
		this.cost.costUsd += usage.cost?.total ?? 0;
		this.cost.turns += 1;
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
