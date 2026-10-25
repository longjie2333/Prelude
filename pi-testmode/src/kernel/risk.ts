/**
 * Mission risk tiers (agent-core §11.1). Pure function; the tier is never a tool parameter, so a
 * model cannot declare or lower it.
 */
import type { RiskTier, Role } from "../types.ts";
import { maxTier, tierAtLeast } from "../types.ts";
import { findScopeTarget, isProductionTarget, type Scope, type TestKind } from "./scope.ts";

export interface MissionRiskInput {
	role: Role;
	targets: readonly string[];
	testKinds: readonly TestKind[];
	/** Environment named by the intent (e.g. `staging`, `production`). */
	environment?: string;
	/** Highest `risk_tier_floor` among the templates the mission activates. */
	templateFloor?: RiskTier;
	scope?: Scope;
}

export interface RiskAssessment {
	tier: RiskTier;
	reasons: string[];
	/** R4 always needs a human; nothing else does at mission level. */
	requiresApproval: boolean;
	/** False when the mission may not run at all, even with approval. */
	allowed: boolean;
	denyReason?: string;
}

const ROLE_BASE: Record<Role, { withTargets: RiskTier; without: RiskTier }> = {
	scout: { withTargets: "R1", without: "R0" },
	curator: { withTargets: "R0", without: "R0" },
	toolsmith: { withTargets: "R2", without: "R2" },
	executor: { withTargets: "R3", without: "R2" },
	verifier: { withTargets: "R3", without: "R2" },
};

const PROD_ENV = /^(prod|production|live)$/i;

export function assessMissionRisk(input: MissionRiskInput): RiskAssessment {
	const reasons: string[] = [];
	const base = input.targets.length > 0 ? ROLE_BASE[input.role].withTargets : ROLE_BASE[input.role].without;
	let tier: RiskTier = base;
	reasons.push(`${input.role} base ${base}`);

	if (input.templateFloor && tierAtLeast(input.templateFloor, tier) && input.templateFloor !== tier) {
		tier = input.templateFloor;
		reasons.push(`template floor ${input.templateFloor}`);
	}

	const kinds = new Set(input.testKinds);
	if (kinds.has("destructive")) {
		tier = "R4";
		reasons.push("destructive operation");
	} else if ((kinds.has("load") || kinds.has("security-check")) && input.targets.length > 0) {
		tier = maxTier(tier, "R3");
		reasons.push("load/security testing is a state-affecting operation (R3)");
	}

	if (input.environment && PROD_ENV.test(input.environment)) {
		tier = "R4";
		reasons.push(`production environment (${input.environment})`);
	}

	for (const target of input.targets) {
		if (isProductionTarget(input.scope, target)) {
			tier = "R4";
			reasons.push(`production target ${target}`);
			continue;
		}
		const st = findScopeTarget(input.scope, target);
		if (!st) {
			if (input.scope) {
				tier = "R4";
				reasons.push(`target ${target} is outside the authorization scope`);
			}
			continue;
		}
		const needed = input.testKinds.length > 0 ? input.testKinds : (["functional"] as const);
		const unauthorized = needed.filter((k) => !st.allowed.includes(k));
		if (unauthorized.length > 0) {
			tier = "R4";
			reasons.push(`${unauthorized.join(", ")} not pre-authorized for ${st.host}`);
		}
	}

	if (!input.scope && tierAtLeast(tier, "R2")) {
		return {
			tier,
			reasons: [...reasons, "no authorization scope"],
			requiresApproval: false,
			allowed: false,
			denyReason: `Risk ${tier} needs an authorization scope. Without .pi/testmode/scope.json only R0/R1 missions may run.`,
		};
	}

	return { tier, reasons, requiresApproval: tier === "R4", allowed: true };
}
