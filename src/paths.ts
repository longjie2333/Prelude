/**
 * Where Prelude keeps its files (design §6.1, §8; D-9): the project's `.prelude/`, the global
 * `~/.prelude/`, and the extension's own directory.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectPaths {
	root: string;
	dir: string;
	projectFile: string;
	scopeFile: string;
	auditFile: string;
	gitignore: string;
	notesDir: string;
	reportsDir: string;
	workDir: string;
	evidenceDir: string;
	runsDir: string;
	agentsFile: string;
}

export function projectPaths(root: string): ProjectPaths {
	const dir = join(root, ".prelude");
	return {
		root,
		dir,
		projectFile: join(dir, "project.json"),
		scopeFile: join(dir, "scope.json"),
		auditFile: join(dir, "audit.jsonl"),
		gitignore: join(dir, ".gitignore"),
		notesDir: join(dir, "notes"),
		reportsDir: join(dir, "reports"),
		workDir: join(dir, "work"),
		evidenceDir: join(dir, "evidence"),
		runsDir: join(dir, "runs"),
		agentsFile: join(root, "AGENTS.md"),
	};
}

export interface RunPaths {
	dir: string;
	stateFile: string;
	findingsFile: string;
	verifyDir: string;
}

export function runPaths(p: ProjectPaths, runId: string): RunPaths {
	const dir = join(p.runsDir, runId);
	return {
		dir,
		stateFile: join(dir, "state.json"),
		findingsFile: join(dir, "findings.jsonl"),
		verifyDir: join(dir, "verify"),
	};
}

export interface GlobalPaths {
	dir: string;
	configFile: string;
	kbDir: string;
}

export function globalPaths(home = homedir()): GlobalPaths {
	const dir = join(home, ".prelude");
	return { dir, configFile: join(dir, "config.json"), kbDir: join(dir, "kb") };
}

/** The package root: `src/` sits directly under it. */
export const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILLS_DIR = join(EXTENSION_DIR, "skills");
/** Canary SUT and its ground truth; hidden from the model in test mode. */
export const CANARY_DIR = join(EXTENSION_DIR, "canary");
