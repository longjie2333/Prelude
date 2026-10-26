// Per-mission token usage from a smoke run's session files: node smoke/usage.mjs <out-dir>
// processed = every prompt token sent (what the old budget counted); new = tokens seen for the
// first time (prompt growth beyond the previous prompt and output) plus generated output.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const out = process.argv[2];
const runs = join(out, "project", ".pi", "testmode", "runs");
const db = new DatabaseSync(join(out, "project", ".pi", "testmode", "project.db"), { readOnly: true });
const roles = Object.fromEntries(db.prepare("SELECT id, role, status FROM missions").all().map((m) => [m.id, `${m.role}:${m.status}`]));
const totals = {};
let sample;
for (const id of readdirSync(runs)) {
	const files = readdirSync(join(runs, id)).filter((f) => f.endsWith(".jsonl"));
	let processed = 0, fresh = 0, turns = 0, lastPrompt = 0, lastOutput = 0, cacheRead = 0, maxPrompt = 0;
	for (const f of files) {
		for (const line of readFileSync(join(runs, id, f), "utf8").split("\n")) {
			if (!line) continue;
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			const m = e.message;
			if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
			const u = m.usage;
			sample ??= u;
			const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			processed += prompt + (u.output ?? 0);
			fresh += Math.max(0, prompt - (lastPrompt + lastOutput)) + (u.output ?? 0);
			cacheRead += u.cacheRead ?? 0;
			maxPrompt = Math.max(maxPrompt, prompt);
			lastPrompt = prompt;
			lastOutput = u.output ?? 0;
			turns++;
		}
	}
	if (!turns) continue;
	console.log(id.slice(-6), (roles[id] ?? "?").padEnd(20), `turns ${String(turns).padStart(2)}  processed ${String(processed).padStart(7)}  new ${String(fresh).padStart(6)}  maxPrompt ${String(maxPrompt).padStart(6)}  cacheRead ${cacheRead}`);
	const r = (roles[id] ?? "?").split(":")[0];
	totals[r] ??= [];
	totals[r].push(fresh);
}
console.log("sample usage", JSON.stringify(sample));
for (const [r, xs] of Object.entries(totals)) console.log(r, "new tokens per mission:", xs.sort((a, b) => a - b).join(", "));
