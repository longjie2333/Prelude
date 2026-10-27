/**
 * Tool intake (plan M2-6, design §5.4): a tool the model wrote and used in `.prelude/work/` enters
 * the knowledge base only with a README.md and a selfcheck that exits 0 in a fresh copy within
 * 120 s.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpreterFor, runProcess } from "../verify.ts";
import { truncate } from "../util.ts";

export const SELFCHECK = /^selfcheck\.(mjs|js|cjs|ts|mts|py|sh|ps1|cmd|bat)$/i;
export const TOOL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SelfcheckResult {
	ok: boolean;
	output: string;
}

export function findSelfcheck(dir: string): string | undefined {
	return readdirSync(dir).find((f) => SELFCHECK.test(f));
}

/** Requirements a tool directory must meet before its selfcheck runs. */
export function toolProblems(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`not a directory: ${dir}`];
	const problems: string[] = [];
	if (!existsSync(join(dir, "README.md"))) problems.push("README.md is missing (usage and known failures)");
	if (!findSelfcheck(dir)) problems.push("selfcheck.<ext> is missing (exit 0 = the tool works)");
	return problems;
}

export async function runSelfcheck(dir: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<SelfcheckResult> {
	const copy = mkdtempSync(join(tmpdir(), "prelude-selfcheck-"));
	try {
		cpSync(dir, copy, { recursive: true });
		const file = findSelfcheck(copy);
		const interp = file && interpreterFor(join(copy, file));
		if (!interp) return { ok: false, output: "no runnable selfcheck" };
		const r = await runProcess(interp.command, interp.args, copy, timeoutMs, signal);
		const output = truncate(
			`exit: ${r.killed ? `killed after ${timeoutMs} ms` : (r.spawnError ?? r.code)}\n${r.stdout}\n${r.stderr}`,
			4000,
		);
		return { ok: !r.killed && !r.spawnError && r.code === 0, output };
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
}
