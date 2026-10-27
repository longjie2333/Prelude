// Collects one Prelude test run into docs/runs/<name>/ (plan §10): the report, findings, run state,
// system notes, repro scripts, a summary (phases, verdicts, tokens from the pi session, audit
// chain, knowledge-base writes) and a README skeleton for the tester's own observations.
//
//   node scripts/collect-run.mjs <project dir> <name> [run id]
//        REDACT="pw1,pw2"   strings replaced by <redacted> in every copied file
//        SESSION_DIR=<dir>  pi session directory, when not the default ~/.pi/agent/sessions
//
// Reads only; never touches the project or the knowledge base.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAudit } from "../src/audit.ts";

const [projectArg, name, runArg] = process.argv.slice(2);
if (!projectArg || !name) {
	console.error("usage: node scripts/collect-run.mjs <project dir> <name> [run id]");
	process.exit(2);
}
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(projectArg);
const prelude = join(root, ".prelude");
const runsDir = join(prelude, "runs");
if (!existsSync(runsDir)) throw new Error(`no .prelude/runs in ${root}`);
const runId = runArg ?? readdirSync(runsDir).sort().at(-1);
if (!runId) throw new Error("no runs yet");
const runDir = join(runsDir, runId);
const out = join(PKG, "docs", "runs", name);
if (existsSync(out)) throw new Error(`${out} exists; pick another name`);
const secrets = (process.env.REDACT ?? "").split(",").filter(Boolean);
const redact = (text) => secrets.reduce((t, s) => t.split(s).join("<redacted>"), text);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readJsonl = (p) =>
	existsSync(p)
		? readFileSync(p, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const copy = (from, to) => {
	mkdirSync(dirname(to), { recursive: true });
	writeFileSync(to, redact(readFileSync(from, "utf8")));
};

const state = readJson(join(runDir, "state.json"));
const findings = readJsonl(join(runDir, "findings.jsonl"));
const audit = readJsonl(join(prelude, "audit.jsonl")).filter((e) => e.run === runId);
const start = Date.parse(state.startedAt);
const end = Math.max(...audit.map((e) => Date.parse(e.at)), start);

// Phases: minutes spent in each, from the first time the run entered it.
const phases = [];
for (const h of state.history) if (!phases.some((p) => p.phase === h.phase)) phases.push({ phase: h.phase, at: h.at });
const phaseMinutes = Object.fromEntries(
	phases.map((p, i) => [
		p.phase,
		Number(((Date.parse(phases[i + 1]?.at ?? new Date(end).toISOString()) - Date.parse(p.at)) / 60_000).toFixed(1)),
	]),
);

// Tokens: assistant usage in the pi session files of this project that overlap the run.
function sessionUsage() {
	const base = process.env.SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
	if (!existsSync(base)) return undefined;
	const usage = { files: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dir of readdirSync(base)) {
		for (const file of readdirSync(join(base, dir)).filter((f) => f.endsWith(".jsonl"))) {
			const path = join(base, dir, file);
			if (statSync(path).mtimeMs < start) continue;
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			let header;
			try {
				header = JSON.parse(lines[0]);
			} catch {
				continue;
			}
			if (resolve(header.cwd ?? "") !== root) continue;
			let counted = false;
			for (const l of lines) {
				let e;
				try {
					e = JSON.parse(l);
				} catch {
					continue;
				}
				const m = e.message;
				const t = Date.parse(e.timestamp ?? "");
				if (e.type !== "message" || m?.role !== "assistant" || !m.usage || t < start || t > end + 60_000) continue;
				counted = true;
				usage.turns++;
				for (const k of ["input", "output", "cacheRead", "cacheWrite"]) usage[k] += m.usage[k] ?? 0;
			}
			if (counted) usage.files++;
		}
	}
	return usage.files
		? { ...usage, processed: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }
		: undefined;
}

const review = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
for (const e of audit.filter((x) => x.event === "verification" && x.detail?.reviewUsage))
	for (const k of Object.keys(review)) review[k] += e.detail.reviewUsage[k] ?? 0;

const summary = {
	project: basename(root),
	run: runId,
	goal: redact(state.goal ?? ""),
	startedAt: state.startedAt,
	minutes: Number(((end - start) / 60_000).toFixed(1)),
	phases: phaseMinutes,
	reportRegistered: state.report?.path ?? null,
	findings: findings.map((f) => ({
		id: f.id,
		severity: f.severity,
		kind: f.kind,
		title: redact(f.title),
		verdict: f.verification?.verdict ?? "unverified",
		rerun: f.verification?.rerun ? `${f.verification.rerun.reproduced}/${f.verification.rerun.runs}` : null,
	})),
	mainUsage: sessionUsage() ?? "no pi session file found (run with sessions enabled, or set SESSION_DIR)",
	reviewUsage: review,
	kbWrites: audit.filter((e) => e.event === "kb_write").map((e) => e.detail?.write ?? e.detail?.action),
	blocks: audit.filter((e) => e.decision === "block").map((e) => ({ tool: e.tool, reason: redact(e.reason ?? "") })),
	audit: verifyAudit(join(prelude, "audit.jsonl")),
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
copy(join(runDir, "findings.jsonl"), join(out, "findings.jsonl"));
copy(join(runDir, "state.json"), join(out, "state.json"));
if (state.report) copy(join(root, state.report.path), join(out, "report.md"));
for (const dir of ["notes"]) {
	const from = join(prelude, dir);
	if (existsSync(from))
		for (const f of readdirSync(from).filter((x) => x.endsWith(".md"))) copy(join(from, f), join(out, dir, f));
}
for (const f of findings.filter((x) => x.repro)) {
	mkdirSync(join(out, "repro"), { recursive: true });
	copyFileSync(join(root, f.repro.stored), join(out, "repro", basename(f.repro.source)));
}
if (existsSync(join(out, "repro")))
	for (const f of readdirSync(join(out, "repro")).map((x) => join(out, "repro", x)))
		writeFileSync(f, redact(readFileSync(f, "utf8")));

const verdicts = summary.findings.reduce((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
writeFileSync(
	join(out, "README.md"),
	`# 真实运行：${name}

> 由 \`scripts/collect-run.mjs\` 生成；"测试人员记录"一节由测试人员填写。

## 自动汇总

| 项 | 值 |
|---|---|
| 运行 | ${runId}（项目目录 \`${basename(root)}\`） |
| 目标 | ${summary.goal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |
| 耗时 | ${summary.minutes} 分钟（${Object.entries(phaseMinutes)
		.map(([k, v]) => `${k} ${v}`)
		.join("、")}） |
| 报告 | ${summary.reportRegistered ? `已登记：[report.md](report.md)` : "**未登记**（report_finalize 没有成功）"} |
| 发现 | ${findings.length} 条：${
		Object.entries(verdicts)
			.map(([k, v]) => `${k} ${v}`)
			.join("、") || "无"
	} |
| processed token | ${typeof summary.mainUsage === "object" ? `主会话 ${summary.mainUsage.processed.toLocaleString("en-US")}（${summary.mainUsage.turns} 轮）` : summary.mainUsage}；审查 ${(review.input + review.output + review.cacheRead + review.cacheWrite).toLocaleString("en-US")}（${review.turns} 轮） |
| 知识库写入 | ${summary.kbWrites.length ? summary.kbWrites.map((w) => (typeof w === "object" ? `${w.kind} ${w.subject}` : w)).join("、") : "无"} |
| 闸门拦截 | ${summary.blocks.length} 次 |
| 审计链 | ${summary.audit.ok ? `完整（${summary.audit.lines} 行）` : `**断在第 ${summary.audit.brokenAt} 行**`} |

数据：[summary.json](summary.json)、[findings.jsonl](findings.jsonl)、[state.json](state.json)、[notes/](notes/)、[repro/](repro/)。

## 测试人员记录

- 目标类型与环境：
- 授权（scope.json）：
- 接收阶段问了什么、怎么回答的：
- 运行中是否干预（引导、批准、拒绝），为什么：
- 发现是否属实（逐条：属实 / 误报 / 不确定）：
- 漏掉了什么（你知道存在、但报告没有的问题）：
- 其他观察（卡住、绕路、违反约束、界面问题）：
`,
);
console.log(`collected ${runId} into ${out}`);
console.log(
	JSON.stringify({
		minutes: summary.minutes,
		findings: findings.length,
		verdicts,
		report: !!state.report,
		audit: summary.audit,
	}),
);
