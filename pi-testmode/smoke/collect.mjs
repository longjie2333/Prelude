// Summarizes a smoke-run project directory: node smoke/collect.mjs <out-dir>
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function collect(out, extra = {}) {
	const root = join(out, "project");
	const dbPath = join(root, ".pi", "testmode", "project.db");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const q = (sql) => {
		try {
			return db.prepare(sql).all();
		} catch {
			return [];
		}
	};
	const evidence = (sha) => {
		const p = join(root, ".pi", "testmode", "evidence", sha ?? "");
		return sha && existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").slice(-3).join(" | ").slice(0, 300) : "";
	};
	const reportsDir = join(root, ".pi", "testmode", "reports");
	if (existsSync(reportsDir)) cpSync(reportsDir, join(out, "reports"), { recursive: true });
	const summary = {
		...extra,
		intents: q(
			"SELECT id, raw, status, hit_level, report_path, created_at, closed_at FROM intents ORDER BY created_at",
		),
		missions: q(
			"SELECT id, intent_id, parent_id, role, status, risk_tier, budget_json, cost_json, error, objective, started_at, ended_at FROM missions ORDER BY created_at",
		).map((m) => ({
			...m,
			budget: JSON.parse(m.budget_json),
			cost: JSON.parse(m.cost_json || "{}"),
			budget_json: undefined,
			cost_json: undefined,
		})),
		envelopes: q(
			"SELECT id, role, envelope_json FROM missions WHERE envelope_json IS NOT NULL ORDER BY created_at",
		).map((m) => ({ id: m.id, role: m.role, envelope: JSON.parse(m.envelope_json) })),
		testRuns: q(
			"SELECT id, mission_id, command, exit_code, verdict, verdict_note, stdout_sha FROM test_runs ORDER BY started_at",
		).map((r) => ({ ...r, stdoutTail: evidence(r.stdout_sha) })),
		retrievals: q("SELECT intent_id, hit_level, cards_json FROM retrievals ORDER BY created_at"),
		blocked: q(
			"SELECT actor, tool, decision, reason FROM audit WHERE event = 'tool_call' AND decision = 'block' ORDER BY seq",
		),
		approvals: q("SELECT tier, subject, decision FROM approvals ORDER BY decided_at"),
		auditCounts: q("SELECT event, decision, COUNT(*) AS n FROM audit GROUP BY event, decision ORDER BY n DESC"),
		templates: q("SELECT id, type, status, head_version FROM templates"),
		providers: q("SELECT cap_id, kind, name, trust, conformance_score FROM providers"),
		gaps: q("SELECT cap_id, status FROM capability_gaps"),
		feedback: q("SELECT episode_id, triage_class, credibility, attribution_json FROM feedback"),
		reports: existsSync(reportsDir) ? readdirSync(reportsDir) : [],
	};
	db.close();
	writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
	return summary;
}

if (process.argv[2]) {
	const s = collect(process.argv[2], { note: "collected after the run" });
	console.log(
		`intents ${s.intents.length}, missions ${s.missions.length}, test runs ${s.testRuns.length} → ${join(process.argv[2], "summary.json")}`,
	);
}
