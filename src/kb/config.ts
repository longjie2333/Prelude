/**
 * `~/.prelude/config.json` (design §6.1, plan M2-1): where the knowledge base lives, its remote,
 * the main branch and this machine's own branch.
 */
import { hostname, userInfo } from "node:os";
import { globalPaths } from "../paths.ts";
import { randomHex, readJson, writeJson } from "../util.ts";

export interface KbConfig {
	dir: string;
	/** Absent: local-only knowledge base, nothing is pushed. */
	remote?: string;
	mainBranch: string;
	branch: string;
}

export interface PreludeConfig {
	kb: KbConfig;
}

export function readConfig(home?: string): PreludeConfig | undefined {
	return readJson<PreludeConfig>(globalPaths(home).configFile);
}

export function writeConfig(config: PreludeConfig, home?: string): void {
	writeJson(globalPaths(home).configFile, config);
}

/** `kb/<user>-<host>-<4 hex>`, reduced to characters git accepts in a branch name. */
export function newBranchName(): string {
	const clean = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 20) || "x";
	let user = "user";
	try {
		user = userInfo().username;
	} catch {
		// some containers have no passwd entry
	}
	return `kb/${clean(user)}-${clean(hostname())}-${randomHex(2)}`;
}
