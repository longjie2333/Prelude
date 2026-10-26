import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, GENESIS, readAudit, verifyAudit } from "../../src/audit.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
let file: string;
beforeEach(() => {
	p = tempProject();
	file = join(p.root, ".prelude", "audit.jsonl");
});
afterEach(() => p.cleanup());

describe("audit hash chain (D-8)", () => {
	it("chains each line to the previous one", () => {
		const a = appendAudit(file, { event: "tool_call", tool: "bash", decision: "allow" });
		appendAudit(file, { event: "tool_call", tool: "write", decision: "block", reason: "scope.json" });
		appendAudit(file, { event: "verification", finding: "f-001", decision: "confirmed" });
		expect(a.prev).toBe(GENESIS);
		expect(verifyAudit(file)).toEqual({ ok: true, lines: 3 });
		expect(readAudit(file).map((r) => r.event)).toEqual(["tool_call", "tool_call", "verification"]);
	});

	it("detects an edited line", () => {
		for (let i = 0; i < 4; i++) appendAudit(file, { event: "tool_call", decision: "block" });
		const lines = readFileSync(file, "utf8").split("\n");
		lines[1] = lines[1].replace('"block"', '"allow"');
		writeFileSync(file, lines.join("\n"));
		expect(verifyAudit(file)).toMatchObject({ ok: false, brokenAt: 3 });
	});

	it("detects a deleted line", () => {
		for (let i = 0; i < 3; i++) appendAudit(file, { event: "e", detail: { i } });
		const lines = readFileSync(file, "utf8").split("\n");
		lines.splice(1, 1);
		writeFileSync(file, lines.join("\n"));
		expect(verifyAudit(file)).toMatchObject({ ok: false, brokenAt: 2 });
	});

	it("keeps chaining across long lines (tail read)", () => {
		appendAudit(file, { event: "big", reason: "x".repeat(20_000) });
		appendAudit(file, { event: "after" });
		expect(verifyAudit(file).ok).toBe(true);
	});
});
