import { describe, expect, it } from "vitest";
import { assessMissionRisk } from "../../src/kernel/risk.ts";
import { findScopeTarget, isEgressAllowed, parseHost, parseScope, type Scope } from "../../src/kernel/scope.ts";

const scope: Scope = {
	targets: [
		{ host: "localhost:4100", envs: ["local"], allowed: ["functional", "load"] },
		{ host: "*.staging.example", envs: ["staging"], allowed: ["functional"] },
		{ host: "shop.example", envs: ["production"], allowed: ["functional"] },
	],
	egress_allowlist: ["registry.npmjs.org"],
};

describe("scope", () => {
	it("parses and validates", () => {
		expect(parseScope(scope).scope).toBeDefined();
		expect(parseScope({ targets: [{ host: "x" }] }).error).toMatch(/allowed/);
		expect(parseScope({ targets: [{ host: "x", allowed: ["fly"] }] }).error).toBeDefined();
	});

	it("matches hosts, ports, and wildcards", () => {
		expect(parseHost("http://LOCALHOST:4100/orders")).toEqual({ host: "localhost", port: "4100" });
		expect(findScopeTarget(scope, "http://localhost:4100/orders")?.host).toBe("localhost:4100");
		expect(findScopeTarget(scope, "http://localhost:4200/")).toBeUndefined();
		expect(findScopeTarget(scope, "https://api.staging.example/v1")?.host).toBe("*.staging.example");
		expect(isEgressAllowed(scope, "registry.npmjs.org")).toBe(true);
		expect(isEgressAllowed(scope, "evil.example")).toBe(false);
	});
});

describe("mission risk", () => {
	it("is computed, never declared", () => {
		expect(assessMissionRisk({ role: "scout", targets: ["http://localhost:4100"], testKinds: ["functional"], scope }).tier).toBe("R1");
		expect(assessMissionRisk({ role: "executor", targets: ["http://localhost:4100"], testKinds: ["functional"], scope }).tier).toBe("R3");
		expect(assessMissionRisk({ role: "executor", targets: [], testKinds: [], scope }).tier).toBe("R2");
	});

	it("raises to R4 for production, destructive, out-of-scope, or unauthorized operations", () => {
		const r4 = (x: Partial<Parameters<typeof assessMissionRisk>[0]>) =>
			assessMissionRisk({ role: "executor", targets: ["http://localhost:4100"], testKinds: ["functional"], scope, ...x });
		expect(r4({ targets: ["https://shop.example/"] })).toMatchObject({ tier: "R4", requiresApproval: true });
		expect(r4({ environment: "production" }).tier).toBe("R4");
		expect(r4({ testKinds: ["destructive"] }).tier).toBe("R4");
		expect(r4({ targets: ["https://other.example/"] }).tier).toBe("R4");
		expect(r4({ targets: ["https://api.staging.example/"], testKinds: ["load"] }).tier).toBe("R4");
	});

	it("honours template floors", () => {
		expect(assessMissionRisk({ role: "scout", targets: [], testKinds: [], templateFloor: "R2", scope }).tier).toBe("R2");
	});

	it("without a scope only R0/R1 run", () => {
		expect(assessMissionRisk({ role: "scout", targets: ["http://localhost:4100"], testKinds: ["functional"] })).toMatchObject({ tier: "R1", allowed: true });
		expect(assessMissionRisk({ role: "executor", targets: ["http://localhost:4100"], testKinds: ["functional"] })).toMatchObject({ allowed: false });
	});
});
