// Real-model canary run (plan M1-10): the real `pi` CLI in RPC mode with Prelude loaded, against
// the canary on :4100, from an empty temp project outside this repo (D-12).
//
//   node scripts/run-canary.mjs      RUN_MODEL=provider/model  RUN_GOAL=<text>  RUN_OUT=<dir>  RUN_MINUTES=60
//
// No human in the loop: host/install approvals are blocked; questionnaire dialogs get their first
// option (the model's own default). Output in <out>: events.jsonl, driver.log, summary.json, and
// a copy of the project's .prelude/.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createCanary } from "../canary/server.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const MODEL = process.env.RUN_MODEL ?? "magpie/trae-cn/deepseek-v4.1-flash";
// Same wording as the old pi-testmode run 5 intent 1, for comparison.
const GOAL =
	process.env.RUN_GOAL ??
	"测一下 canary（http://localhost:4100，接口文档在 /openapi.json）的下单接口在并发下会不会超卖";
const PORT = 4100;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(process.env.RUN_OUT ?? join(tmpdir(), `prelude-run-${stamp}`));
const ROOT = join(OUT, "project");
const DEADLINE_MS = Number(process.env.RUN_MINUTES ?? 60) * 60_000;

mkdirSync(join(ROOT, ".prelude"), { recursive: true });
writeFileSync(
	join(ROOT, ".prelude", "scope.json"),
	JSON.stringify(
		{ project: "canary", targets: [{ host: `localhost:${PORT}`, allowed: ["functional", "load"] }] },
		null,
		2,
	),
);
const log = (line) => {
	const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
	console.log(s);
	appendFileSync(join(OUT, "driver.log"), `${s}\n`);
};

const canary = createCanary({ bugs: new Set(["B1", "B2", "B3"]) });
await new Promise((r) => canary.listen(PORT, "127.0.0.1", r));
log(`canary :${PORT} (B1,B2,B3); project ${ROOT}; model ${MODEL}`);

const started = Date.now();
const pi = spawn(process.execPath, [CLI, "--mode", "rpc", "--no-session", "-ne", "-e", PKG, "--model", MODEL], {
	cwd: ROOT,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, NODE_NO_WARNINGS: "1" },
});
const send = (msg) => pi.stdin.write(`${JSON.stringify(msg)}\n`);
pi.stderr.on("data", (b) => appendFileSync(join(OUT, "pi.stderr.log"), b));

const dialogs = [];
const usage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const tools = {};
let settled = false;
let testStarted = false;
let finish;
const done = new Promise((r) => {
	finish = r;
});

function answer(ev) {
	const opts = ev.options ?? [];
	if (ev.method === "select") {
		const deny = opts.find((o) => o === "Block");
		if (deny) return { value: deny };
		return opts.length ? { value: opts[0] } : { cancelled: true };
	}
	if (ev.method === "confirm") return { confirmed: false };
	return { cancelled: true };
}

createInterface({ input: pi.stdout }).on("line", (line) => {
	appendFileSync(join(OUT, "events.jsonl"), `${line}\n`);
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === "extension_ui_request") {
		if (ev.method === "notify") {
			log(`notify: ${String(ev.message).slice(0, 300)}`);
			if (String(ev.message).includes("started")) testStarted = true;
		}
		if (["select", "confirm", "input", "editor"].includes(ev.method)) {
			const a = answer(ev);
			dialogs.push({ method: ev.method, title: ev.title, options: ev.options, answer: a });
			log(`dialog ${ev.method}: ${String(ev.title).slice(0, 200).replace(/\n/g, " ")} → ${JSON.stringify(a)}`);
			send({ type: "extension_ui_response", id: ev.id, ...a });
		}
	}
	if (ev.type === "tool_execution_start") {
		tools[ev.toolName] = (tools[ev.toolName] ?? 0) + 1;
		const arg = ev.args?.command ?? ev.args?.path ?? "";
		log(`tool ${ev.toolName} ${String(arg).slice(0, 160).replace(/\n/g, " ")}`);
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const u = ev.message.usage ?? {};
		usage.turns++;
		for (const k of ["input", "output", "cacheRead", "cacheWrite"]) usage[k] += u[k] ?? 0;
		const text = (ev.message.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.trim();
		if (text) log(`says: ${text.slice(0, 300).replace(/\n/g, " ")}`);
		if (ev.message.stopReason === "error") log(`model error: ${ev.message.errorMessage}`);
	}
	if (ev.type === "response" && ev.command === "prompt")
		log(`prompt response: ${JSON.stringify(ev.data ?? ev.error)}`);
	if (ev.type === "agent_settled" && testStarted) {
		settled = true;
		finish("settled");
	}
});
pi.on("exit", (code) => {
	log(`pi exited ${code}`);
	finish("exited");
});

send({ id: "test", type: "prompt", message: `/test ${GOAL}` });
const timer = setTimeout(() => finish("deadline"), DEADLINE_MS);
const reason = await done;
clearTimeout(timer);
const minutes = (Date.now() - started) / 60_000;
log(`end: ${reason} after ${minutes.toFixed(1)} min`);
pi.kill();
await new Promise((r) => canary.close(() => r()));

const preludeDir = join(ROOT, ".prelude");
const audit = existsSync(join(preludeDir, "audit.jsonl"))
	? readFileSync(join(preludeDir, "audit.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];
const review = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
for (const a of audit.filter((x) => x.event === "verification" && x.detail?.reviewUsage))
	for (const k of Object.keys(review)) review[k] += a.detail.reviewUsage[k] ?? 0;
writeFileSync(
	join(OUT, "summary.json"),
	JSON.stringify(
		{
			model: MODEL,
			goal: GOAL,
			end: reason,
			settled,
			minutes: Number(minutes.toFixed(1)),
			mainUsage: usage,
			reviewUsage: review,
			tools,
			dialogs,
			blocks: audit.filter((a) => a.decision === "block").map((a) => ({ tool: a.tool, reason: a.reason })),
			verifications: audit
				.filter((a) => a.event === "verification")
				.map((a) => ({ finding: a.finding, verdict: a.decision, reason: a.reason, rerun: a.detail?.rerun })),
		},
		null,
		2,
	),
);
cpSync(preludeDir, join(OUT, "prelude"), { recursive: true });
log(`summary: ${join(OUT, "summary.json")}`);
process.exit(0);
