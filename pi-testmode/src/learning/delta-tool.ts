/**
 * `delta_propose` (plan §7, M3-5): the curator turns an accumulated hypothesis into a structured
 * delta. The kernel fixes the target, the condition (from the contrast set), and the evidence;
 * the curator supplies only the action and its content. The gate decides.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MissionToolHost } from "../harness/tools.ts";
import { textResult } from "../util.ts";
import { REVISABLE_PATHS } from "./delta.ts";
import { listDeltas, proposeDelta } from "./gate.ts";

export function createDeltaProposeTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "delta_propose",
		label: "Propose Delta",
		description:
			"Turn the hypothesis in the <delta> section into a structured change of the template. You choose the action and content; the condition, target, and evidence are fixed by the kernel. The gate replays every cornerstone and commits, suspends, or rejects.",
		promptSnippet: "Propose a structured template delta for the hypothesis; the gate decides",
		parameters: Type.Object({
			delta_id: Type.String(),
			action: Type.Optional(
				StringEnum(["exclude", "patch", "redirect", "require_probe"] as const, {
					description: "except: what happens under the condition",
				}),
			),
			patch: Type.Optional(
				Type.Object({
					slot: Type.String(),
					use: Type.String({ description: "tpl://… of the replacement slot template" }),
					note: Type.Optional(Type.String()),
				}),
			),
			redirect: Type.Optional(Type.String()),
			probe: Type.Optional(Type.String()),
			revise: Type.Optional(Type.Object({ path: StringEnum(REVISABLE_PATHS), value: Type.Unknown() })),
			because: Type.String({ description: "Why, in one sentence, grounded in the evidence" }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const task = host.spec.deltaTask;
			if (!task || task.deltaId !== params.delta_id)
				throw new Error("delta_propose only accepts the delta assigned to this mission");
			const d = listDeltas(host.store).find((x) => x.id === params.delta_id);
			if (!d) throw new Error(`unknown delta ${params.delta_id}`);
			if (d.status === "committed" || d.status === "rejected")
				throw new Error(`delta ${d.id} is already ${d.status}`);
			let payload: Record<string, unknown>;
			if (d.op === "except") {
				const base = (d.payload as { exception: Record<string, unknown> }).exception;
				if (!params.action) throw new Error("except needs an action");
				payload = {
					exception: {
						id: base.id,
						when: base.when,
						action: params.action,
						...(params.patch ? { patch: params.patch } : {}),
						...(params.redirect ? { redirect: params.redirect } : {}),
						...(params.probe ? { probe: params.probe } : {}),
						because: params.because,
						source: "experience",
						evidence: { support: d.evidence.length, contradict: 0 },
					},
				};
			} else if (d.op === "revise") {
				if (!params.revise) throw new Error("revise needs { path, value }");
				payload = { path: params.revise.path, value: params.revise.value, reason: params.because };
			} else {
				throw new Error(`delta_propose does not handle ${d.op}`);
			}
			const r = proposeDelta(host.store, {
				op: d.op,
				target: d.target,
				payload,
				evidence: d.evidence,
				proposedBy: `mission:${host.missionId}`,
				deltaId: d.id,
				hypothesisKey: d.hypothesisKey ?? undefined,
			});
			const failed = r.report.checks.filter((c) => !c.ok);
			const lines = [
				`gate: ${r.report.decision}${r.version ? ` → ${d.target}@${r.version}` : ""}`,
				...failed.map((c) => `failed: ${c.name} — ${c.detail}`),
				`cornerstone replay: ${r.report.replay.filter((x) => x.ok).length}/${r.report.replay.length} unchanged`,
				`evidence: ${r.report.evidence.have}/${r.report.evidence.need}`,
			];
			return textResult(
				lines.join("\n"),
				{ decision: r.report.decision, version: r.version },
				{ isError: r.report.decision === "rejected" },
			);
		},
	});
}
