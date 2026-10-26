import { describe, expect, it } from "vitest";
import { verdictFor } from "../../src/harness/tools.ts";
import { conformanceScore } from "../../src/orchestrator/orchestrator.ts";
import { BudgetTracker } from "../../src/kernel/budget.ts";
import { type Claim, EnvelopeSchema, validateClaimsAgainstRuns, verifyClaim } from "../../src/missions/envelope.ts";
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

	it("tells the verifier that integrity_issues voids feedback and must stay empty without a real issue", () => {
		const d = (EnvelopeSchema.properties.integrity_issues as { description?: string }).description ?? "";
		expect(d).toMatch(/voids/);
		expect(d).toMatch(/Omit the field/);
	});

	it("verifies deterministically from the verifier's runs", () => {
		expect(verifyClaim("defect", [run("a", "fail"), run("b", "fail")])).toBe("confirmed");
		expect(verifyClaim("defect", [run("a", "pass")])).toBe("refuted");
		expect(verifyClaim("defect", [run("a", "pass"), run("b", "fail")])).toBe("inconclusive");
		expect(verifyClaim("defect", [run("a", "inconclusive")])).toBe("inconclusive");
		expect(verifyClaim("pass", [run("a", "pass")])).toBe("confirmed");
		// Race-dependent defect seen in the real-model smoke run: 7 of 10 replays fail.
		const race = [
			...Array.from({ length: 7 }, (_, i) => run(`f${i}`, "fail")),
			...Array.from({ length: 3 }, (_, i) => run(`p${i}`, "pass")),
		];
		expect(verifyClaim("defect", race)).toBe("confirmed");
		expect(verifyClaim("defect", race.slice(4))).toBe("inconclusive"); // 3 fail / 3 pass
	});
});

describe("conformanceScore", () => {
	it("scores the cited runs, not the verifier's fault probes", () => {
		const runs = [run("ok1", "pass"), run("ok2", "pass"), run("probe1", "fail"), run("probe2", "fail")];
		const env = {
			status: "completed",
			summary: "s",
			claims: [{ id: "k1", type: "pass", statement: "conforms", test_run_ids: ["ok1", "ok2"] }],
		} as never;
		expect(conformanceScore(env, runs)).toEqual({ passed: 2, decided: 2, score: 1 });
		expect(conformanceScore({ status: "completed", summary: "s", claims: [] } as never, runs).score).toBe(0.5);
	});
});

describe("verdictFor", () => {
	it("maps exit codes; unrunnable commands and timeouts are not verdicts", () => {
		expect(verdictFor({ exitCode: 0, timedOut: false, aborted: false }).verdict).toBe("pass");
		expect(verdictFor({ exitCode: 1, timedOut: false, aborted: false }).verdict).toBe("fail");
		expect(verdictFor({ exitCode: 127, timedOut: false, aborted: false }).verdict).toBe("error");
		expect(verdictFor({ exitCode: null, timedOut: true, aborted: false }).verdict).toBe("inconclusive");
		expect(verdictFor({ exitCode: null, timedOut: false, aborted: false, spawnError: "ENOENT" }).verdict).toBe(
			"error",
		);
	});
});

describe("budget (new tokens, I-28)", () => {
	it("counts prompt growth and output, not the resent context", () => {
		const b = new BudgetTracker({ tokens: 10_000, wallClockMs: 60_000 }, undefined, 0);
		b.addUsage({ input: 4000, output: 200 }); // system prompt + task: all new
		b.addUsage({ input: 500, cacheRead: 4200, output: 100 }); // 500 new tool-result tokens on a 4200 cached prefix
		b.addUsage({ input: 300, cacheRead: 4800, output: 100 });
		const c = b.snapshot(1);
		expect(c.tokens).toBe(4200 + 600 + 400);
		expect(c.processed).toBe(4200 + 4800 + 5200);
		expect(c.context).toBe(5200);
	});

	it("after compaction measures growth from the smaller prompt", () => {
		const b = new BudgetTracker({ tokens: 1e6, wallClockMs: 60_000 }, undefined, 0);
		b.addUsage({ input: 20_000, output: 0 });
		b.addUsage({ input: 3000, output: 100 }); // compacted: no growth, only the output is new
		b.addUsage({ input: 3600, output: 0 }); // 500 new tokens beyond 3000 + 100
		expect(b.snapshot(1).tokens).toBe(20_000 + 100 + 500);
	});

	it("warns once at 80% and is exceeded at 100%; wall clock counts too", () => {
		const b = new BudgetTracker({ tokens: 1000, wallClockMs: 60_000 }, undefined, 0);
		b.addUsage({ input: 600, output: 100 });
		expect(b.state(1)).toBe("ok");
		b.addUsage({ input: 800, output: 50 }); // +100 growth +50 output → 850
		expect(b.shouldWarn(1)).toBe(true);
		expect(b.shouldWarn(1)).toBe(false);
		b.addUsage({ input: 1000, output: 100 }); // +150 +100 → 1100
		expect(b.state(1)).toBe("exceeded");
		expect(new BudgetTracker({ tokens: 1e9, wallClockMs: 1000 }, undefined, 0).state(1500)).toBe("exceeded");
	});

	it("carries spent cost and the context base across a resume (and reads pre-I-28 rows)", () => {
		const b = new BudgetTracker(
			{ tokens: 1000, wallClockMs: 60_000 },
			{
				tokens: 900,
				processed: 5000,
				input: 4000,
				output: 1000,
				costUsd: 0,
				wallClockMs: 1000,
				turns: 3,
				context: 2000,
			},
			10_000,
		);
		expect(b.state(10_000)).toBe("warn");
		expect(b.snapshot(10_000).wallClockMs).toBe(1000);
		b.addUsage({ input: 2050, output: 0 });
		expect(b.snapshot(10_000).tokens).toBe(950);
		const legacy = new BudgetTracker(
			{ tokens: 1000, wallClockMs: 60_000 },
			{ tokens: 10, input: 0, output: 0, costUsd: 0, wallClockMs: 0, turns: 1 } as never,
			0,
		);
		expect(legacy.snapshot(0)).toMatchObject({ processed: 0, context: 0 });
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
			{
				missionId: "m-1",
				intentId: "i-1",
				role: "executor",
				objective: "o",
				targets: ["http://localhost:4100"],
				testKinds: ["functional"],
				riskTier: "R3",
				riskReasons: [],
				budget: { tokens: 10, wallClockMs: 60_000 },
			},
			"/runs/m-1",
		);
		expect(text).toContain("risk_tier: R3");
		expect(text).toContain("run_dir: /runs/m-1");
	});
});
