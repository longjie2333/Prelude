import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Run } from "../../src/run.ts";
import { interpreterFor, rerun } from "../../src/verify.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
let run: Run;
const work = (name: string, content: string) => {
	const path = join(p.paths.workDir, name);
	mkdirSync(p.paths.workDir, { recursive: true });
	writeFileSync(path, content);
	return `.prelude/work/${name}`;
};

beforeEach(() => {
	p = tempProject();
	run = Run.create(p.paths, "run-1", "goal");
});
afterEach(() => p.cleanup());

describe("findings", () => {
	it("numbers findings and freezes the repro script and evidence by hash", () => {
		const repro = work("a.mjs", "process.exit(1)");
		const ev = work("resp.json", '{"status":500}');
		const f = run.addFinding({
			title: "t",
			severity: "high",
			kind: "defect",
			description: "d",
			repro,
			evidence: [ev],
		});
		expect(f.id).toBe("f-001");
		expect(f.repro?.source).toBe(repro);
		expect(f.repro?.stored).toMatch(/^\.prelude\/evidence\/[0-9a-f]{64}\.mjs$/);
		writeFileSync(join(p.root, repro), "process.exit(0)");
		expect(readFileSync(run.abs(f.repro?.stored ?? ""), "utf8")).toBe("process.exit(1)");
		expect(run.addFinding({ title: "s", severity: "low", kind: "suggestion", description: "d" }).id).toBe("f-002");
		expect(run.findings().map((x) => x.id)).toEqual(["f-001", "f-002"]);
	});

	it("requires a repro script for defects and an existing file", () => {
		expect(() => run.addFinding({ title: "t", severity: "high", kind: "defect", description: "d" })).toThrow(/repro/);
		expect(() =>
			run.addFinding({ title: "t", severity: "high", kind: "defect", description: "d", repro: "nope.mjs" }),
		).toThrow(/not a file/);
	});

	it("records phase changes", () => {
		run.setPhase("execute", "orders");
		expect(run.state()).toMatchObject({
			phase: "execute",
			history: [{ phase: "intake" }, { phase: "execute", note: "orders" }],
		});
	});
});

describe("rerun", () => {
	const record = (name: string, content: string) =>
		run.addFinding({ title: name, severity: "high", kind: "defect", description: "d", repro: work(name, content) });

	it("counts non-zero exits as reproduced, each run in a fresh directory", async () => {
		const f = record(
			"flaky.mjs",
			`import { existsSync, writeFileSync } from "node:fs";
if (existsSync("marker")) { console.log("dirty dir"); process.exit(0); }
writeFileSync("marker", "");
process.exit(1);`,
		);
		const r = await rerun(run, f, { runs: 3, timeoutMs: 10_000 });
		expect(r).toMatchObject({ runs: 3, reproduced: 3, rate: 1, exitCodes: [1, 1, 1] });
		expect(readFileSync(join(run.paths.verifyDir, f.id, "run-1", "output.txt"), "utf8")).toMatch(/exit: 1/);
	});

	it("reports exit 0 as not reproduced and kills scripts at the timeout", async () => {
		expect((await rerun(run, record("ok.mjs", "process.exit(0)"), { runs: 2, timeoutMs: 10_000 })).rate).toBe(0);
		const slow = await rerun(run, record("slow.mjs", "setTimeout(() => process.exit(1), 30_000)"), {
			runs: 1,
			timeoutMs: 500,
		});
		expect(slow).toMatchObject({ reproduced: 0, exitCodes: [null] });
	});

	it("fails instead of reproducing when there is no interpreter", async () => {
		const r = await rerun(run, record("x.unknown", "boom"), { runs: 3, timeoutMs: 1000 });
		expect(r.error).toMatch(/no interpreter/);
		expect(r.reproduced).toBe(0);
		expect(interpreterFor("a.ts")?.command).toBe(process.execPath);
	});
});
