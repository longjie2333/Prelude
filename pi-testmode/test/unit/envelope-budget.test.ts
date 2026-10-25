import { describe, expect, it } from "vitest";
import { verdictFor } from "../../src/harness/tools.ts";
import { BudgetTracker } from "../../src/kernel/budget.ts";
import { type Claim, validateClaimsAgainstRuns, verifyClaim } from "../../src/missions/envelope.ts";
import { parseRoleFile, renderMissionSpec, roleTools } from "../../src/missions/roles.ts";
import type { TestRunRow } from "../../src/store/repos.ts";

const run = (id: string, verdict: TestRunRow["verdict"], missionId = "m-1"): TestRunRow => ({
	id,
	missionId,
	toolCallId: null,
	command: "node t.mjs",
	cwd: ".",
	exitCode: verdict === "pass" ? 0 : 1,
	durationMs: 1,
	stdoutSha: null,
	stderrSha: null,
	verdict,
	verdictNote: null,
	artifactShas: [],
});

describe("claims need test_run verdicts", () => {
	const defect: Claim = { id: "c1", type: "defect", statement: "oversell", test_run_ids: ["tr-1"] };

	it("accepts a defect backed by a failing run", () => {
		expect(validateClaimsAgainstRuns([defect], [run("tr-1", "fail")], "m-1")).toEqual([]);
	});

	it("rejects pass/fail claims without, or contradicting, test_run evidence", () => {
		expect(validateClaimsAgainstRuns([{ ...defect, test_run_ids: [] }], [], "m-1")[0]).toMatch(/cites no test_run/);
		expect(validateClaimsAgainstRuns([defect], [run("tr-1", "pass")], "m-1")[0]).toMatch(/verdict "fail"/);
		expect(validateClaimsAgainstRuns([defect], [run("tr-1", "fail", "m-2")], "m-1")[0]).toMatch(/unknown test_run/);
		expect(validateClaimsAgainstRuns([{ id: "o1", type: "observation", statement: "x" }], [], "m-1")).toEqual([]);
	});

	it("verifies deterministically from the verifier's runs", () => {
		expect(verifyClaim("defect", [run("a", "fail"), run("b", "fail")])).toBe("confirmed");
		expect(verifyClaim("defect", [run("a", "pass")])).toBe("refuted");
		expect(verifyClaim("defect", [run("a", "pass"), run("b", "fail")])).toBe("inconclusive");
		expect(verifyClaim("defect", [run("a", "inconclusive")])).toBe("inconclusive");
		expect(verifyClaim("pass", [run("a", "pass")])).toBe("confirmed");
	});
});

describe("verdictFor", () => {
	it("maps exit codes; unrunnable commands and timeouts are not verdicts", () => {
		expect(verdictFor({ exitCode: 0, timedOut: false, aborted: false }).verdict).toBe("pass");
		expect(verdictFor({ exitCode: 1, timedOut: false, aborted: false }).verdict).toBe("fail");
		expect(verdictFor({ exitCode: 127, timedOut: false, aborted: false }).verdict).toBe("error");
		expect(verdictFor({ exitCode: null, timedOut: true, aborted: false }).verdict).toBe("inconclusive");
		expect(verdictFor({ exitCode: null, timedOut: false, aborted: false, spawnError: "ENOENT" }).verdict).toBe("error");
	});
});

describe("budget", () => {
	it("warns once at 80% and stops at 100%", () => {
		const b = new BudgetTracker({ tokens: 1000, wallClockMs: 60_000 }, undefined, 0);
		b.addUsage({ input: 500, output: 200, totalTokens: 700 });
		expect(b.state(1)).toBe("ok");
		b.addUsage({ input: 100, output: 50, totalTokens: 150 });
		expect(b.shouldWarn(1)).toBe(true);
		expect(b.shouldWarn(1)).toBe(false);
		b.addUsage({ totalTokens: 200 });
		expect(b.state(1)).toBe("exceeded");
		expect(new BudgetTracker({ tokens: 1e9, wallClockMs: 1000 }, undefined, 0).state(1500)).toBe("exceeded");
	});

	it("carries spent cost across a resume", () => {
		const b = new BudgetTracker({ tokens: 1000, wallClockMs: 60_000 }, { tokens: 900, input: 0, output: 0, costUsd: 0, wallClockMs: 1000, turns: 3 }, 10_000);
		expect(b.state(10_000)).toBe("warn");
		expect(b.snapshot(10_000).wallClockMs).toBe(1000);
	});
});

describe("roles", () => {
	it("parses frontmatter and adds powershell next to bash on Windows", () => {
		const def = parseRoleFile("---\nname: executor\ndescription: d\ntools: read, bash, test_run\n---\nBody");
		expect(def).toMatchObject({ name: "executor", tools: ["read", "bash", "test_run"], systemPrompt: "Body" });
		expect(roleTools(def, "win32")).toContain("powershell");
		expect(roleTools(def, "linux")).not.toContain("powershell");
	});

	it("renders the mission spec with the kernel-computed tier", () => {
		const text = renderMissionSpec(
			{ missionId: "m-1", intentId: "i-1", role: "executor", objective: "o", targets: ["http://localhost:4100"], testKinds: ["functional"], riskTier: "R3", riskReasons: [], budget: { tokens: 10, wallClockMs: 60_000 } },
			"/runs/m-1",
		);
		expect(text).toContain("risk_tier: R3");
		expect(text).toContain("run_dir: /runs/m-1");
	});
});
