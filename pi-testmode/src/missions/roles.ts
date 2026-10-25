/**
 * Role definitions: the frontmatter + system-prompt format of
 * @earendil-works/pi-coding-agent@1.4.0 examples/extensions/subagent/agents/*.md (format only).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionSpecRecord } from "../store/repos.ts";
import type { Role } from "../types.ts";

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "roles");

export interface RoleDefinition {
	name: Role;
	description: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
}

export function parseRoleFile(text: string): RoleDefinition {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) throw new Error("role file has no frontmatter");
	const fields: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim();
	}
	if (!fields.name || !fields.tools) throw new Error("role frontmatter needs name and tools");
	return {
		name: fields.name as Role,
		description: fields.description ?? "",
		tools: fields.tools.split(",").map((t) => t.trim()).filter(Boolean),
		model: fields.model || undefined,
		systemPrompt: m[2].trim(),
	};
}

const cache = new Map<Role, RoleDefinition>();

export function loadRole(role: Role): RoleDefinition {
	let def = cache.get(role);
	if (!def) {
		def = parseRoleFile(readFileSync(join(ROLES_DIR, `${role}.md`), "utf8"));
		cache.set(role, def);
	}
	return def;
}

/** Built-in tools available to a role on this platform (Windows adds `powershell` next to `bash`). */
export function roleTools(def: RoleDefinition, platform: NodeJS.Platform = process.platform): string[] {
	const tools = [...def.tools];
	if (platform === "win32" && tools.includes("bash") && !tools.includes("powershell")) tools.push("powershell");
	return tools;
}

function list(items: readonly string[]): string {
	return items.length ? items.map((i) => `  - ${i}`).join("\n") : "  []";
}

/** Mission Spec (agent-core §5.3) as rendered into the mission's `mission` prompt section. */
export function renderMissionSpec(spec: MissionSpecRecord, runDir: string): string {
	const lines = [
		"<mission>",
		`mission_id: ${spec.missionId}`,
		`intent_id: ${spec.intentId}`,
		`role: ${spec.role}`,
		`objective: ${JSON.stringify(spec.objective)}`,
		`targets:\n${list(spec.targets)}`,
		`test_kinds: [${spec.testKinds.join(", ")}]`,
		`risk_tier: ${spec.riskTier}  # computed by the kernel; operations above it need approval`,
		`budget: { tokens: ${spec.budget.tokens}, wall_clock_s: ${Math.round(spec.budget.wallClockMs / 1000)} }`,
		`run_dir: ${runDir}  # the only directory you may write`,
		"return: mission_submit (result envelope)",
	];
	if (spec.context) lines.push(`context: |\n${spec.context.split("\n").map((l) => `  ${l}`).join("\n")}`);
	if (spec.verify) {
		const v = spec.verify;
		lines.push(
			"verify:",
			`  claims:\n${v.claims.map((c) => `    - { id: ${c.id}, type: ${c.type}, statement: ${JSON.stringify(c.statement)} }`).join("\n")}`,
			`  frozen_artifacts (copied into run_dir and frozen):\n${v.artifacts.map((a) => `    - ${a.path}  sha256=${a.sha256}`).join("\n") || "    []"}`,
			`  commands_used:\n${v.testRuns.map((r) => `    - ${JSON.stringify(r.command)}`).join("\n") || "    []"}`,
		);
	}
	lines.push("</mission>");
	return lines.join("\n");
}
