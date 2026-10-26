/**
 * Independent verification (plan M1-7, design §7, D-7).
 *
 * 1. Rerun (code): the frozen repro script runs k times, each in a fresh empty directory under
 *    `runs/<id>/verify/<finding>/`; non-zero exit = reproduced; rate >= 0.6 counts.
 * 2. Review (model): a new session with only `read`/`bash`, no user resources and the same gate,
 *    sees the claim, the script and the rerun output, never the test conversation, and decides
 *    whether the script really proves the claim.
 *
 * Reruns use their own spawn instead of `pi.exec`: `pi.exec` reports a missing interpreter as exit
 * code 1, which would read as "reproduced".
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { type Model, StringEnum } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Prelude } from "./context.ts";
import { updateDisplay } from "./progress.ts";
import type { Finding, Run, Verdict, Verification } from "./run.ts";
import { errorMessage, nowIso, textResult, truncate } from "./util.ts";

export const REPRO_THRESHOLD = 0.6;

export interface RerunOptions {
	runs: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface ProcessResult {
	/** null when the process was killed (timeout, abort) or could not start. */
	code: number | null;
	stdout: string;
	stderr: string;
	killed: boolean;
	spawnError?: string;
}

export interface RerunResult {
	runs: number;
	reproduced: number;
	rate: number;
	exitCodes: Array<number | null>;
	/** Output of the last run, for the reviewer. */
	lastOutput: string;
	/** Set when the script could not run at all (no interpreter, unknown extension). */
	error?: string;
}

/** Interpreter by extension. Node runs .ts directly (type stripping, Node >= 22.18). */
export function interpreterFor(file: string): { command: string; args: string[] } | undefined {
	const ext = extname(file).toLowerCase();
	if ([".js", ".mjs", ".cjs", ".ts", ".mts"].includes(ext)) return { command: process.execPath, args: [file] };
	if (ext === ".py") return { command: process.platform === "win32" ? "python" : "python3", args: [file] };
	if (ext === ".sh") return { command: "bash", args: [file] };
	if (ext === ".ps1")
		return {
			command: process.platform === "win32" ? "powershell" : "pwsh",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
		};
	if ((ext === ".cmd" || ext === ".bat") && process.platform === "win32")
		return { command: "cmd.exe", args: ["/d", "/c", file] };
	return undefined;
}

export function runProcess(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const finish = (r: Omit<ProcessResult, "stdout" | "stderr" | "killed">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			resolve({ ...r, stdout, stderr, killed });
		};
		const kill = () => {
			killed = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(kill, timeoutMs);
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
		child.stdout?.on("data", (d) => (stdout = truncate(stdout + d.toString(), 200_000)));
		child.stderr?.on("data", (d) => (stderr = truncate(stderr + d.toString(), 200_000)));
		child.on("error", (err) => finish({ code: null, spawnError: err.message }));
		// "exit", not "close": a detached grandchild holding the pipes must not hang verification.
		child.on("exit", (code) => setTimeout(() => finish({ code: killed ? null : code }), 50));
	});
}

export async function rerun(run: Run, finding: Finding, opts: RerunOptions): Promise<RerunResult> {
	if (!finding.repro) throw new Error(`${finding.id} has no repro script`);
	const script = run.abs(finding.repro.stored);
	const base = join(run.paths.verifyDir, finding.id);
	rmSync(base, { recursive: true, force: true });
	const exitCodes: Array<number | null> = [];
	let reproduced = 0;
	let lastOutput = "";
	for (let i = 1; i <= opts.runs; i++) {
		const dir = join(base, `run-${i}`);
		mkdirSync(dir, { recursive: true });
		const local = join(dir, `repro${extname(script).toLowerCase()}`);
		copyFileSync(script, local);
		const interp = interpreterFor(local);
		if (!interp) return fail(`no interpreter for ${extname(script) || "a file without extension"}`);
		const r = await runProcess(interp.command, interp.args, dir, opts.timeoutMs, opts.signal);
		if (r.spawnError) return fail(`cannot start ${interp.command}: ${r.spawnError}`);
		const out = `exit: ${r.killed ? `killed after ${opts.timeoutMs} ms` : r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
		writeFileSync(join(dir, "output.txt"), out);
		lastOutput = out;
		exitCodes.push(r.code);
		if (!r.killed && r.code !== null && r.code !== 0) reproduced++;
		if (opts.signal?.aborted) break;
	}
	return {
		runs: exitCodes.length,
		reproduced,
		rate: exitCodes.length ? reproduced / exitCodes.length : 0,
		exitCodes,
		lastOutput,
	};

	function fail(error: string): RerunResult {
		return { runs: exitCodes.length, reproduced: 0, rate: 0, exitCodes, lastOutput, error };
	}
}

// ---------------------------------------------------------------- review sub-session

export interface ReviewDeps {
	cwd: string;
	agentDir: string;
	runtime: ModelRuntime;
	model: Model<string>;
	/** The same gate as the main session, so the reviewer's shell calls are checked too. */
	gate: ExtensionFactory;
	signal?: AbortSignal;
}

export interface ReviewResult {
	verdict: "confirmed" | "rejected";
	reason: string;
}

/** Token use of a review sub-session; it has no session file, so the audit is the only record. */
export interface ReviewUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function sumUsage(messages: readonly unknown[]): ReviewUsage {
	const u: ReviewUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const m of messages as Array<{ role?: string; usage?: Partial<ReviewUsage> }>) {
		if (m.role !== "assistant" || !m.usage) continue;
		u.turns++;
		u.input += m.usage.input ?? 0;
		u.output += m.usage.output ?? 0;
		u.cacheRead += m.usage.cacheRead ?? 0;
		u.cacheWrite += m.usage.cacheWrite ?? 0;
	}
	return u;
}

export const REVIEW_SECTION = "prelude_review";

const REVIEW_PROMPT = `你是独立审查员。另一个测试者声称发现了一个问题，并给出了复现脚本和证据。你看不到他的测试过程，这是有意的。

判断这份材料是否真的证明了所声称的问题：
- 断言是否过弱：任何实现都会让脚本失败吗？
- 预期值是否抄自实际输出，或者没有依据（例如按自己猜的业务规则断言）？
- 脚本失败是否源于脚本自身（语法错误、依赖缺失、环境问题），而不是被测系统？
- 描述、脚本、输出三者是否一致？脚本测的是描述里说的那件事吗？
- 对"建议"类发现：理由是否具体、可验证，而不是泛泛的偏好？

可以用 read 查看文件、用 bash 做只读检查或重跑一次脚本；不要修改任何文件。
最后必须调用 review_verdict 给出结论：confirmed（证据成立）或 rejected（证据不成立），并写明理由。`;

function reviewBrief(run: Run, f: Finding, rr: RerunResult | undefined): string {
	const parts = [
		`## 发现 ${f.id}`,
		`- 标题：${f.title}`,
		`- 类型：${f.kind}；严重程度：${f.severity}`,
		`- 描述：\n${f.description}`,
	];
	if (f.repro) {
		parts.push(
			`## 复现脚本（${run.abs(f.repro.stored)}）\n约定：退出码非 0 = 问题复现。\n\`\`\`\n${truncate(readFileSync(run.abs(f.repro.stored), "utf8"), 12_000)}\n\`\`\``,
		);
	}
	if (rr) {
		parts.push(
			`## 代码重跑结果\n在干净目录中运行 ${rr.runs} 次，复现 ${rr.reproduced} 次，退出码 ${JSON.stringify(rr.exitCodes)}。最后一次输出：\n\`\`\`\n${truncate(rr.lastOutput, 8_000)}\n\`\`\``,
		);
	}
	if (f.evidence.length)
		parts.push(`## 证据文件\n${f.evidence.map((e) => `- ${run.abs(e.stored)}（原路径 ${e.source}）`).join("\n")}`);
	return parts.join("\n\n");
}

export async function review(
	run: Run,
	f: Finding,
	rr: RerunResult | undefined,
	deps: ReviewDeps,
): Promise<ReviewResult & { usage: ReviewUsage }> {
	let verdict: ReviewResult | undefined;
	const verdictTool = defineTool({
		name: "review_verdict",
		label: "Review verdict",
		description: "Record the review conclusion for the finding: confirmed or rejected, with the reason.",
		promptGuidelines: ["Call review_verdict exactly once, at the end of the review."],
		parameters: Type.Object({
			verdict: StringEnum(["confirmed", "rejected"] as const),
			reason: Type.String({ minLength: 1, description: "Why the evidence does or does not prove the claim" }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			verdict = { verdict: params.verdict, reason: params.reason };
			return { content: [{ type: "text", text: "Verdict recorded." }], details: verdict, terminate: true };
		},
	});
	const loader = new DefaultResourceLoader({
		cwd: deps.cwd,
		agentDir: deps.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
		extensionFactories: [
			deps.gate,
			(pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections[REVIEW_SECTION] = REVIEW_PROMPT;
				});
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: deps.cwd,
		agentDir: deps.agentDir,
		model: deps.model,
		modelRuntime: deps.runtime,
		resourceLoader: loader,
		tools: ["read", "bash", "review_verdict"],
		customTools: [verdictTool],
		sessionManager: SessionManager.inMemory(deps.cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});
	let usage: ReviewUsage | undefined;
	const onAbort = () => void session.abort();
	deps.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.bindExtensions({});
		await session.prompt(reviewBrief(run, f, rr), { expandPromptTemplates: false });
		if (!verdict && !deps.signal?.aborted)
			await session.prompt("请调用 review_verdict 给出结论。", { expandPromptTemplates: false });
	} finally {
		deps.signal?.removeEventListener("abort", onAbort);
		usage = sumUsage(session.messages);
		// dispose() does not emit session_shutdown (plan §1).
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
		session.dispose();
	}
	if (!verdict) throw new Error(`reviewer for ${f.id} ended without review_verdict`);
	return { ...verdict, usage: usage ?? sumUsage([]) };
}

// ---------------------------------------------------------------- verify_findings

/** Rerun (defects), then review (reproduced defects and suggestions); writes the verdict back. */
export async function verifyFinding(
	prelude: Prelude,
	run: Run,
	f: Finding,
	signal: AbortSignal | undefined,
): Promise<Verification> {
	let rr: RerunResult | undefined;
	if (f.kind === "defect") {
		rr = await rerun(run, f, {
			runs: prelude.options.rerun?.runs ?? 3,
			timeoutMs: prelude.options.rerun?.timeoutMs ?? 120_000,
			signal,
		});
		if (rr.error) throw new Error(`${f.id}: ${rr.error}`);
	}
	const rerunSummary = rr && { runs: rr.runs, reproduced: rr.reproduced, rate: rr.rate, exitCodes: rr.exitCodes };
	let v: Verification;
	let usage: ReviewUsage | undefined;
	if (rr && rr.rate < REPRO_THRESHOLD) {
		// Not reproduced by code: no claim left for a reviewer to judge (D-7).
		v = { verdict: "not-reproduced", at: nowIso(), rerun: rerunSummary };
	} else {
		const r = await review(run, f, rr, {
			cwd: prelude.cwd,
			agentDir: prelude.agentDir,
			runtime: await prelude.modelRuntime(),
			model: prelude.model(),
			gate: prelude.gate({ interactive: false }),
			signal,
		});
		usage = r.usage;
		v = { verdict: r.verdict, at: nowIso(), rerun: rerunSummary, review: { verdict: r.verdict, reason: r.reason } };
	}
	run.updateFinding(f.id, (x) => {
		x.verification = v;
	});
	prelude.audit({
		event: "verification",
		finding: f.id,
		decision: v.verdict,
		reason: v.review?.reason,
		detail: rerunSummary || usage ? { rerun: rerunSummary, reviewUsage: usage } : undefined,
	});
	return v;
}

export function createVerifyFindingsTool(prelude: Prelude) {
	return defineTool({
		name: "verify_findings",
		label: "Verify findings",
		description:
			"Independently verify findings of the running Prelude test. Each defect's frozen repro script is rerun 3 times in a clean directory (non-zero exit = reproduced, needs >= 60%); reproduced defects and suggestions then go to a reviewer in a fresh context that sees only the claim, the script and the output. Without ids, verifies every unverified finding.",
		promptSnippet: "Verify recorded findings independently (rerun + fresh-context review)",
		promptGuidelines: [
			"Call verify_findings once after testing, before writing the report; only confirmed findings count as defects or suggestions.",
		],
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Finding ids to (re)verify" })),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params, signal, onUpdate) {
			const run = prelude.run();
			const all = run.findings();
			const targets = params.ids?.length
				? params.ids.map((id) => run.finding(id))
				: all.filter((f) => !f.verification);
			if (targets.length === 0)
				return textResult("Nothing to verify: every finding has a verdict.", { results: [] });
			const results: Array<{ id: string; verdict?: Verdict; error?: string }> = [];
			for (const f of targets) {
				onUpdate?.({ content: [{ type: "text", text: `Verifying ${f.id} ${f.title}…` }], details: { results } });
				try {
					results.push({ id: f.id, verdict: (await verifyFinding(prelude, run, f, signal)).verdict });
				} catch (err) {
					results.push({ id: f.id, error: errorMessage(err) });
				}
				updateDisplay(prelude);
				if (signal?.aborted) break;
			}
			const lines = results.map((r) => {
				const f = run.finding(r.id);
				const v = f.verification;
				if (r.error) return `- ${r.id} ${f.title}: not verified (${r.error})`;
				const rate = v?.rerun ? `, reproduced ${v.rerun.reproduced}/${v.rerun.runs}` : "";
				return `- ${r.id} ${f.title}: ${r.verdict}${rate}${v?.review ? ` — ${v.review.reason}` : ""}`;
			});
			return textResult(lines.join("\n"), { results });
		},
	});
}
