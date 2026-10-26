export const ROLES = ["scout", "toolsmith", "executor", "verifier", "curator"] as const;
export type Role = (typeof ROLES)[number];

export const MISSION_STATUSES = [
	"queued",
	"running",
	"interrupted",
	"completed",
	"partial",
	"blocked",
	"failed",
	"aborted",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];
export const TERMINAL_STATUSES: readonly MissionStatus[] = ["completed", "partial", "failed", "aborted"];
/** States that need a human decision before the mission can move again. */
export const PARKED_STATUSES: readonly MissionStatus[] = ["interrupted", "blocked"];

export type InterruptReason = "crash" | "network" | "shutdown";
export type EffectClass = "read_only" | "idempotent" | "side_effecting";
export type RiskTier = "R0" | "R1" | "R2" | "R3" | "R4";
export const RISK_ORDER: readonly RiskTier[] = ["R0", "R1", "R2", "R3", "R4"];

export function maxTier(...tiers: RiskTier[]): RiskTier {
	let best = 0;
	for (const t of tiers) best = Math.max(best, RISK_ORDER.indexOf(t));
	return RISK_ORDER[best];
}

export function tierAtLeast(tier: RiskTier, floor: RiskTier): boolean {
	return RISK_ORDER.indexOf(tier) >= RISK_ORDER.indexOf(floor);
}

export type Verdict = "pass" | "fail" | "inconclusive" | "error";
export type Actor = "main" | `mission:${string}`;

export interface Budget {
	/** Total tokens (input + output) across the mission's model calls. */
	tokens: number;
	/** Wall clock limit in milliseconds. */
	wallClockMs: number;
	/** Optional USD ceiling, enforced when providers report cost. */
	costUsd?: number;
}

export interface Cost {
	/**
	 * New tokens: what the model saw for the first time (prompt growth since the previous turn)
	 * plus what it generated. Budgets are measured in these (decision I-28).
	 */
	tokens: number;
	/** Every prompt + output token sent and received, resent context included (what providers bill). */
	processed: number;
	/** Prompt tokens, resent context included. */
	input: number;
	output: number;
	costUsd: number;
	wallClockMs: number;
	turns: number;
	/** Size of the last prompt plus its output: the base the next turn's growth is measured from. */
	context: number;
}

export const EMPTY_COST: Cost = {
	tokens: 0,
	processed: 0,
	input: 0,
	output: 0,
	costUsd: 0,
	wallClockMs: 0,
	turns: 0,
	context: 0,
};
