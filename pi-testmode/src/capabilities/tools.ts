/** Capability tools (plan §7, M2-6): `capability_request`, `skill_validate`, `provider_register`. */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MissionToolHost } from "../harness/tools.ts";
import { canonicalPath, isInside } from "../kernel/paths.ts";
import { addEdge, ensureCapability, insertProvider, listGaps, updateGap } from "../knowledge/store.ts";
import { audit } from "../store/repos.ts";
import { textResult } from "../util.ts";
import { hashDirectory } from "./registry.ts";
import { validateSkill } from "./skill-validate.ts";

const CAP = Type.String({ pattern: "^cap:[a-z0-9.-]+$", description: "Hierarchical capability id, e.g. cap:load.generate.http" });

export function createCapabilityRequestTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "capability_request",
		label: "Request Capability",
		description:
			"Report a missing capability (agent-core §9.5). A Toolsmith mission acquires and verifies it in the background; this mission does not wait. The request is recorded as a deviation.",
		promptSnippet: "Report a missing capability; a Toolsmith acquires it in the background",
		promptGuidelines: ["Use capability_request when the task needs a reusable tool or skill you do not have; then finish with what you can do now."],
		parameters: Type.Object({
			cap: CAP,
			semantics: Type.String({ description: "What the capability does, precisely" }),
			io: Type.Optional(Type.Object({ input: Type.String(), output: Type.String() })),
			acceptance_hints: Type.Optional(Type.Array(Type.String(), { description: "Checks with known answers, e.g. 'reading a product with stock 10 returns 10'" })),
			priority: Type.Optional(StringEnum(["blocking", "nice_to_have"] as const)),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			if (!host.requestCapability) throw new Error("capability requests are not available in this mission");
			const r = host.requestCapability({ capId: params.cap, semantics: params.semantics, io: params.io, acceptanceHints: params.acceptance_hints });
			return textResult(r.message, r);
		},
	});
}

function insideQuarantine(host: MissionToolHost, p: string): string {
	const abs = resolve(host.runDir, p);
	if (!isInside(canonicalPath(abs, host.root), canonicalPath(join(host.runDir, "quarantine"), host.root))) {
		throw new Error(`${p} must be inside ${join(host.runDir, "quarantine")}`);
	}
	return abs;
}

export function createSkillValidateTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "skill_validate",
		label: "Validate Skill",
		description: "Statically review a Skill directory in quarantine: frontmatter, invisible characters, instruction-like text, permission manifest. Nothing is executed.",
		promptSnippet: "Statically review a Skill directory in quarantine",
		parameters: Type.Object({ path: Type.String({ description: "Skill directory, relative to your run directory (inside quarantine/)" }) }),
		async execute(_id, params) {
			const report = validateSkill(insideQuarantine(host, params.path));
			const lines = [
				`skill_validate: ${report.ok ? "ok" : "FAILED"}${report.name ? ` (${report.name})` : ""}`,
				...report.errors.map((e) => `error: ${e}`),
				...report.warnings.map((w) => `warning: ${w}`),
				`manifest: hosts=[${report.manifest.hosts.join(", ")}] writes=[${report.manifest.writes.join(", ")}] exec=${report.manifest.exec} files=${report.manifest.files}`,
			];
			return textResult(lines.join("\n"), report);
		},
	});
}

export function createProviderRegisterTool(host: MissionToolHost): ToolDefinition {
	return defineTool({
		name: "provider_register",
		label: "Register Provider",
		description:
			"Register a validated Skill as a candidate provider of a capability. It is hashed, copied out of quarantine, and becomes usable only after an independent conformance check promotes it to verified.",
		promptSnippet: "Register a validated Skill as a candidate provider of a capability",
		parameters: Type.Object({
			path: Type.String({ description: "Skill directory inside quarantine/" }),
			cap: CAP,
			semantics: Type.String(),
			version: Type.Optional(Type.String({ description: "Semantic version, default 0.1.0" })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const src = insideQuarantine(host, params.path);
			const report = validateSkill(src);
			if (!report.ok || !report.name) throw new Error(`skill_validate failed:\n- ${report.errors.join("\n- ")}`);
			const hash = hashDirectory(src);
			const dest = join(host.paths.skillsDir, `${report.name}@${hash.slice(0, 8)}`);
			if (!existsSync(dest)) {
				mkdirSync(host.paths.skillsDir, { recursive: true });
				cpSync(src, dest, { recursive: true });
			}
			if (hashDirectory(dest) !== hash) throw new Error("registered copy does not match the validated content");
			const { store } = host;
			const gap = listGaps(store, { toolsmithMissionId: host.missionId })[0];
			store.tx(() => {
				ensureCapability(store, params.cap, params.semantics);
				insertProvider(store, {
					sha256: hash,
					capId: params.cap,
					layer: "project",
					kind: "skill",
					name: report.name as string,
					version: params.version ?? "0.1.0",
					location: { path: dest },
					trust: "candidate",
					provenance: { mission: host.missionId, gap: gap?.id, manifest: report.manifest, warnings: report.warnings },
				});
				addEdge(store, "project", params.cap, hash, "implemented_by", { trust: "candidate" });
				if (gap) updateGap(store, gap.id, { providerSha: hash });
				audit(store, { actor: `mission:${host.missionId}`, event: "provider_register", decision: "candidate", reason: `${params.cap} ← ${report.name}@${hash.slice(0, 8)}` });
			});
			return textResult(
				`Registered ${report.name}@${hash.slice(0, 8)} as a candidate provider of ${params.cap}. An independent verifier runs its conformance check after you submit.`,
				{ sha256: hash, path: dest, name: report.name },
			);
		},
	});
}
