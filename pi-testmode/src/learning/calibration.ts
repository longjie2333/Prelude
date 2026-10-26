/**
 * Calibration on the canary (agent-core §10.3 #5, plan M3-9): compare confirmed defects with the
 * ground truth in bugs.json. Precision/recall drift beyond the threshold raises an alert and pauses
 * automatic learning until a calibration run without drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Envelope } from "../missions/envelope.ts";
import { claimViews } from "../orchestrator/verification.ts";
import type { Store } from "../store/db.ts";
import { audit, listMissions } from "../store/repos.ts";
import { newId, nowIso } from "../util.ts";

export const DRIFT = { minPrecision: 0.8, minRecall: 0.5, maxDrop: 0.2 } as const;

export interface BugTruth {
	id: string;
	title: string;
	match: string;
}

const BUGS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "canary", "bugs.json");

export function loadBugTruth(path = BUGS_FILE): BugTruth[] {
	const j = JSON.parse(readFileSync(path, "utf8")) as { bugs: BugTruth[] };
	return j.bugs;
}

export interface CalibrationResult {
	id: string;
	precision: number;
	recall: number;
	drift: boolean;
	details: {
		active: string[];
		found: string[];
		unmatched: string[];
		missed: string[];
		intents: string[];
		reasons: string[];
	};
}

/** Precision/recall of confirmed defects across `intentIds` against the bugs active in that run. */
export function calibrate(
	s: Store,
	intentIds: readonly string[],
	activeBugs: readonly string[],
	truth = loadBugTruth(),
): CalibrationResult {
	const confirmed = intentIds
		.flatMap((i) => listMissions(s, { intentId: i }).filter((m) => m.role === "executor"))
		.flatMap((m) => claimViews(s, m).filter((v) => v.claim.type === "defect" && v.status === "confirmed"))
		.map((v) =>
			[v.claim.statement, v.claim.minimal_repro ?? "", ...((v.claim.evidence as string[]) ?? [])].join(" "),
		);
	const active = truth.filter((b) => activeBugs.includes(b.id));
	const matches = (text: string) => active.filter((b) => new RegExp(b.match, "i").test(text)).map((b) => b.id);
	const found = new Set<string>();
	const unmatched: string[] = [];
	for (const c of confirmed) {
		const m = matches(c);
		if (m.length) for (const id of m) found.add(id);
		else unmatched.push(c.slice(0, 120));
	}
	const precision = confirmed.length ? (confirmed.length - unmatched.length) / confirmed.length : 1;
	const recall = active.length ? found.size / active.length : 1;

	const prev = latestCalibration(s);
	const reasons: string[] = [];
	if (precision < DRIFT.minPrecision) reasons.push(`precision ${precision.toFixed(2)} < ${DRIFT.minPrecision}`);
	if (recall < DRIFT.minRecall) reasons.push(`recall ${recall.toFixed(2)} < ${DRIFT.minRecall}`);
	if (prev && prev.precision - precision > DRIFT.maxDrop)
		reasons.push(`precision dropped ${(prev.precision - precision).toFixed(2)}`);
	if (prev && prev.recall - recall > DRIFT.maxDrop)
		reasons.push(`recall dropped ${(prev.recall - recall).toFixed(2)}`);
	const drift = reasons.length > 0;
	const id = newId("cal");
	const details = {
		active: active.map((b) => b.id),
		found: [...found],
		unmatched,
		missed: active.filter((b) => !found.has(b.id)).map((b) => b.id),
		intents: [...intentIds],
		reasons,
	};
	s.tx(() => {
		insertCalibrationRun(s, { id, precision, recall, details, drift });
		audit(s, {
			actor: "main",
			event: "calibration",
			decision: drift ? "drift" : "ok",
			reason: `precision ${precision.toFixed(2)} recall ${recall.toFixed(2)}${drift ? `: ${reasons.join("; ")}` : ""}`,
		});
	});
	return { id, precision, recall, drift, details };
}

export function latestCalibration(s: Store): { precision: number; recall: number; drift: boolean } | undefined {
	const r = s.get<{ precision: number; recall: number; drift: number }>(
		"SELECT precision, recall, drift FROM calibration_runs ORDER BY ts DESC, id DESC LIMIT 1",
	);
	return r ? { precision: r.precision, recall: r.recall, drift: !!r.drift } : undefined;
}

export function insertCalibrationRun(
	s: Store,
	r: { id: string; precision: number; recall: number; details: unknown; drift: boolean },
): void {
	s.run(
		"INSERT INTO calibration_runs (id, ts, precision, recall, details_json, drift) VALUES ($id, $ts, $p, $r, $d, $drift)",
		{ $id: r.id, $ts: nowIso(), $p: r.precision, $r: r.recall, $d: JSON.stringify(r.details), $drift: r.drift },
	);
}

/** Learning is paused while the latest calibration run shows drift. */
export function isLearningPaused(s: Store): boolean {
	return latestCalibration(s)?.drift ?? false;
}

/** The verifier's verdicts against truth (J-class check): confirmed claims that match no active bug. */
export function verifierFalseConfirmations(
	s: Store,
	intentIds: readonly string[],
	activeBugs: readonly string[],
	truth = loadBugTruth(),
): string[] {
	const active = truth.filter((b) => activeBugs.includes(b.id));
	return intentIds
		.flatMap((i) => listMissions(s, { intentId: i }).filter((m) => m.role === "executor"))
		.flatMap((m) =>
			claimViews(s, m)
				.filter((v) => v.claim.type === "defect" && v.status === "confirmed")
				.map((v) => ({ m, v })),
		)
		.filter(({ v }) => !active.some((b) => new RegExp(b.match, "i").test(v.claim.statement)))
		.map(
			({ m, v }) =>
				`${m.id}: ${v.claim.statement} (${((m.envelope as Envelope | null)?.summary ?? "").slice(0, 60)})`,
		);
}
