/**
 * Progress tools and display (plan M1-6, design §10): `test_progress` (phase changes) and
 * `finding_record` (one finding into `runs/<id>/findings.jsonl`), plus the status line and the
 * widget with the latest findings. Adapted display calls from @earendil-works/pi-coding-agent@1.4.0
 * examples/extensions/status-line.ts and widget-placement.ts.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Prelude } from "./context.ts";
import { FINDING_KINDS, type Finding, PHASES, type RunState, SEVERITIES, severityCounts } from "./run.ts";
import { textResult } from "./util.ts";

export const STATUS_KEY = "prelude";
export const WIDGET_KEY = "prelude-findings";

const SEVERITY_MARK: Record<string, string> = { critical: "‼", high: "!", medium: "·", low: " " };

export function statusText(state: RunState, findings: Finding[]): string {
	const counts = severityCounts(findings);
	const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${s} ${counts[s]}`);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return `🧪 ${state.phase}${total ? ` · ${total} (${parts.join(", ")})` : ""}`;
}

export function widgetLines(findings: Finding[], limit = 5): string[] {
	return findings.slice(-limit).map((f) => {
		const v = f.verification?.verdict ?? "unverified";
		return `${SEVERITY_MARK[f.severity] ?? " "} ${f.id} ${f.title} [${v}]`;
	});
}

export function updateDisplay(prelude: Prelude, ctx: ExtensionContext | undefined = prelude.ctx): void {
	if (!ctx) return;
	try {
		if (!prelude.enabled || !prelude.runId) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const run = prelude.run();
		const findings = run.findings();
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", statusText(run.state(), findings)));
		const kb = prelude.kb();
		const lines = [...widgetLines(findings), ...(kb?.config.remote ? [`kb: ${kb.state}`] : [])];
		ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined);
	} catch {
		// Display is best effort: a stale context after session replacement must not fail a tool.
	}
}

export function createTestProgressTool(prelude: Prelude) {
	return defineTool({
		name: "test_progress",
		label: "Test progress",
		description:
			"Report a phase change of the running Prelude test: intake, profile, execute, verify, report, retro.",
		promptSnippet: "Report the current test phase",
		promptGuidelines: ["Call test_progress whenever the Prelude test moves to another phase."],
		parameters: Type.Object({
			phase: StringEnum(PHASES),
			note: Type.Optional(Type.String({ description: "One line on what this phase will cover" })),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			const run = prelude.run();
			const state = run.setPhase(params.phase, params.note);
			prelude.audit({ event: "phase", detail: { phase: params.phase } });
			updateDisplay(prelude);
			// The Skill time-boxes phases; the model has no clock of its own.
			const minutes = Math.round((Date.now() - Date.parse(state.startedAt)) / 60_000);
			const findings = run.findings().length;
			return textResult(`Phase: ${state.phase}. Elapsed: ${minutes} min. Findings recorded: ${findings}.`, {
				phase: state.phase,
				minutes,
				findings,
			});
		},
	});
}

export function createFindingRecordTool(prelude: Prelude) {
	return defineTool({
		name: "finding_record",
		label: "Record finding",
		description:
			"Record one finding of the running Prelude test. A defect needs a repro script whose exit code is non-zero when the problem reproduces and 0 when it does not; the script and evidence files are frozen (copied by hash) at this moment. Pass id to replace an unverified finding.",
		promptSnippet: "Record a test finding with its repro script and evidence",
		promptGuidelines: [
			"Call finding_record as soon as a problem is found, not at the end of the test.",
			"finding_record freezes the repro script: finish and run it first, then record it.",
		],
		parameters: Type.Object({
			title: Type.String({ minLength: 1 }),
			severity: StringEnum(SEVERITIES),
			kind: StringEnum(FINDING_KINDS, { description: "defect: wrong behavior; suggestion: UX or design advice" }),
			description: Type.String({
				minLength: 1,
				description: "What happens, what was expected and why, and the steps",
			}),
			repro: Type.Optional(
				Type.String({
					description: "Path of a self-contained repro script (.mjs/.js/.ts/.py/.sh/.ps1); required for defects",
				}),
			),
			evidence: Type.Optional(
				Type.Array(Type.String(), { description: "Paths of evidence files (responses, logs, screenshots)" }),
			),
			id: Type.Optional(Type.String({ description: "Replace this unverified finding instead of adding one" })),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			const run = prelude.run();
			let f: Finding;
			if (params.id) {
				const old = run.finding(params.id);
				if (old.verification) throw new Error(`${params.id} is already verified; record a new finding instead`);
				if (params.kind === "defect" && !params.repro) throw new Error("a defect needs a repro script");
				f = run.updateFinding(params.id, (x) => {
					x.title = params.title;
					x.severity = params.severity;
					x.kind = params.kind;
					x.description = params.description;
					x.repro = params.repro ? run.freeze(params.repro) : undefined;
					x.evidence = (params.evidence ?? []).map((e) => run.freeze(e));
				});
			} else {
				f = run.addFinding({ ...params });
			}
			prelude.audit({ event: "finding", finding: f.id, detail: { severity: f.severity, kind: f.kind } });
			updateDisplay(prelude);
			return textResult(`Recorded ${f.id}: ${f.title}`, { id: f.id });
		},
	});
}
