// Real-model smoke run (plan §13): the real `pi` CLI in RPC mode with pi-testmode loaded, against
// the canary on :4100, from an isolated temp project (the agent cannot see canary/bugs.json).
//
//   node smoke/run-smoke.mjs                 SMOKE_MODEL=provider/model  SMOKE_OUT=<dir>
//
// Every approval dialog is denied (no human in the loop). Progress is read from project.db.
// Output: <out>/events.jsonl, <out>/summary.json, <out>/reports/*.md
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanary } from "../canary/server.mjs";
import { collect } from "./collect.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const [PROVIDER, ...rest] = (process.env.SMOKE_MODEL ?? "magpie/trae-cn/deepseek-v4.1-flash").split("/");
const MODEL = rest.join("/");
const PORT = 4100;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(process.env.SMOKE_OUT ?? join(tmpdir(), `pitm-smoke-${stamp}`));
const ROOT = join(OUT, "project");
const DB = join(ROOT, ".pi", "testmode", "project.db");
const DEADLINE = Date.now() + Number(process.env.SMOKE_MINUTES ?? 60) * 60_000;

const INTENTS = [
	"测一下 canary（http://localhost:4100，接口文档在 /openapi.json）的下单接口在并发下会不会超卖",
	"再看看 canary（http://localhost:4100）的优惠券 SAVE10 在并发领取时会不会超领",
];

mkdirSync(join(ROOT, ".pi", "testmode"), { recursive: true });
writeFileSync(
	join(ROOT, ".pi", "testmode", "scope.json"),
	JSON.stringify({ project: "canary smoke", targets: [{ host: `localhost:${PORT}`, envs: ["local"], allowed: ["functional", "load"] }], data: { policy: "synthetic-only" }, egress_allowlist: [] }, null, 2),
);
const log = (line) => {
	const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
	console.log(s);
	appendFileSync(join(OUT, "driver.log"), `${s}\n`);
};

const canary = createCanary({ bugs: new Set(["B1", "B2", "B3"]) });
await new Promise((r) => canary.listen(PORT, "127.0.0.1", r));
log(`canary on :${PORT} (B1,B2,B3); project ${ROOT}; model ${PROVIDER}/${MODEL}`);

const pi = spawn(process.execPath, [CLI, "--mode", "rpc", "--no-session", "-ne", "-e", PKG, "--provider", PROVIDER, "--model", MODEL], {
	cwd: ROOT,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, NODE_NO_WARNINGS: "1" },
});
const send = (msg) => pi.stdin.write(`${JSON.stringify(msg)}\n`);
pi.stderr.on("data", (b) => appendFileSync(join(OUT, "pi.stderr.log"), b));
let exited = false;
pi.on("exit", (code) => {
	exited = true;
	log(`pi exited ${code}`);
});

const dialogs = [];
createInterface({ input: pi.stdout }).on("line", (line) => {
	appendFileSync(join(OUT, "events.jsonl"), `${line}\n`);
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === "extension_ui_request") {
		if (ev.method === "notify") log(`notify: ${String(ev.message).slice(0, 300)}`);
		if (["select", "confirm", "input", "editor"].includes(ev.method)) {
			const opts = ev.options ?? [];
			const answer = ev.method === "select" ? (opts.includes("Deny") ? { value: "Deny" } : opts.includes("Decide later") ? { value: "Decide later" } : { cancelled: true }) : ev.method === "confirm" ? { confirmed: false } : { cancelled: true };
			dialogs.push({ method: ev.method, title: ev.title, answer });
			log(`dialog ${ev.method}: ${String(ev.title).slice(0, 200)} → ${JSON.stringify(answer)}`);
			send({ type: "extension_ui_response", id: ev.id, ...answer });
		}
	}
	if (ev.type === "tool_execution_start") log(`main tool: ${ev.toolName}`);
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const text = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
		if (text) log(`main says: ${text.slice(0, 400)}`);
		if (ev.message.stopReason === "error") log(`main model error: ${ev.message.errorMessage}`);
	}
});

const { DatabaseSync } = await import("node:sqlite");
const query = (sql) => {
	if (!existsSync(DB)) return [];
	const db = new DatabaseSync(DB, { readOnly: true });
	try {
		return db.prepare(sql).all();
	} catch {
		return [];
	} finally {
		db.close();
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => query("SELECT COUNT(*) AS n FROM missions WHERE status IN ('queued','running')")[0]?.n ?? 0;

/** Waits until intent #k is closed and nothing is running for `quietMs`; nudges once if main stalls. */
async function waitIntent(k) {
	let quietSince = 0;
	let nudged = false;
	let lastState = "";
	while (Date.now() < DEADLINE && !exited) {
		await sleep(5000);
		const intents = query("SELECT id, status, hit_level FROM intents ORDER BY created_at");
		const missions = query("SELECT role, status FROM missions");
		const state = `intents ${intents.map((i) => `${i.id}:${i.status}/${i.hit_level ?? "-"}`).join(" ")} | missions ${missions.map((m) => `${m.role}:${m.status}`).join(" ")}`;
		if (state !== lastState) log(state);
		lastState = state;
		const mine = intents[k];
		if (busy() > 0) {
			quietSince = 0;
			continue;
		}
		quietSince ||= Date.now();
		if (mine?.status === "closed" && Date.now() - quietSince > 30_000) return true;
		if (Date.now() - quietSince > 180_000 && !nudged) {
			nudged = true;
			log("main idle with work pending: nudging once");
			send({ type: "prompt", id: `nudge-${k}`, message: mine ? "All missions for the current intent have ended. Review the results and call report_finalize (or dispatch what is still missing)." : INTENTS[k], streamingBehavior: "followUp" });
		}
		if (Date.now() - quietSince > 420_000) return false;
	}
	return false;
}

const started = Date.now();
send({ type: "prompt", id: "toggle", message: "/test" });
await sleep(3000);
const results = [];
for (let k = 0; k < INTENTS.length; k++) {
	log(`intent ${k + 1}: ${INTENTS[k]}`);
	send({ type: "prompt", id: `intent-${k}`, message: INTENTS[k], streamingBehavior: "followUp" });
	const ok = await waitIntent(k);
	results.push({ intent: INTENTS[k], closed: ok, minutes: Math.round((Date.now() - started) / 6000) / 10 });
	log(`intent ${k + 1} ${ok ? "closed" : "did NOT close"}`);
	if (!ok) break;
}
send({ type: "prompt", id: "kb", message: "/test-kb" });
await sleep(4000);
pi.kill();
canary.close();

collect(OUT, { model: `${PROVIDER}/${MODEL}`, results, dialogs, minutes: Math.round((Date.now() - started) / 6000) / 10 });
log(`done → ${OUT}`);
process.exit(0);
