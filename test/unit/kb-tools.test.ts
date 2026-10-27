import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolSource } from "../../src/kb/api.ts";
import { runSelfcheck, toolProblems } from "../../src/kb/tools.ts";
import { Run } from "../../src/run.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
let dir: string;
beforeEach(() => {
	p = tempProject();
	dir = join(p.paths.workDir, "burst");
	mkdirSync(dir, { recursive: true });
});
afterEach(() => p.cleanup());

describe("tool intake (M2-6)", () => {
	it("needs README.md and selfcheck.<ext>", () => {
		expect(toolProblems(dir)).toEqual([
			"README.md is missing (usage and known failures)",
			"selfcheck.<ext> is missing (exit 0 = the tool works)",
		]);
		writeFileSync(join(dir, "README.md"), "# burst");
		writeFileSync(join(dir, "selfcheck.mjs"), "process.exit(0)");
		expect(toolProblems(dir)).toEqual([]);
		expect(toolProblems(join(dir, "nope"))[0]).toMatch(/not a directory/);
	});

	it("runs the selfcheck in a fresh copy: exit 0 passes, anything else or a timeout fails", async () => {
		writeFileSync(join(dir, "README.md"), "# burst");
		writeFileSync(join(dir, "lib.mjs"), "export const ok = true;");
		writeFileSync(
			join(dir, "selfcheck.mjs"),
			'import { writeFileSync } from "node:fs"; import { ok } from "./lib.mjs"; writeFileSync("ran", ""); console.log("ok"); process.exit(ok ? 0 : 1);',
		);
		const pass = await runSelfcheck(dir, 10_000);
		expect(pass.ok).toBe(true);
		expect(pass.output).toContain("ok");
		expect(existsSync(join(dir, "ran"))).toBe(false); // it ran in a copy, not in the source

		writeFileSync(join(dir, "selfcheck.mjs"), "process.exit(2)");
		expect((await runSelfcheck(dir, 10_000)).ok).toBe(false);
		writeFileSync(join(dir, "selfcheck.mjs"), "setTimeout(() => {}, 30_000)");
		expect(await runSelfcheck(dir, 500)).toMatchObject({ ok: false, output: expect.stringMatching(/killed/) });
	});
});

describe("tool source path", () => {
	it("accepts a bare name under .prelude/work/ as well as a project-relative path", () => {
		const run = new Run(p.paths, "run-1");
		expect(toolSource(run, "burst")).toBe(dir);
		expect(toolSource(run, ".prelude/work/burst")).toBe(dir);
		expect(toolSource(run, "src")).toBe(join(p.root, "src"));
	});
});
