import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime data layout, docs/pi-testmode-plan.md §5. */
export interface TestmodePaths {
	/** Project root (the pi session cwd). */
	root: string;
	/** `<root>/.pi/testmode` */
	dir: string;
	projectDb: string;
	scopeFile: string;
	runsDir: string;
	evidenceDir: string;
	skillsDir: string;
	reportsDir: string;
	/** `<agentDir>/testmode` */
	globalDir: string;
	globalDb: string;
	globalSkillsDir: string;
	/** Directory of this extension package; agents may never write here. */
	extensionDir: string;
}

export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolvePaths(root: string, agentDir: string): TestmodePaths {
	const dir = join(root, ".pi", "testmode");
	const globalDir = join(agentDir, "testmode");
	return {
		root,
		dir,
		projectDb: join(dir, "project.db"),
		scopeFile: join(dir, "scope.json"),
		runsDir: join(dir, "runs"),
		evidenceDir: join(dir, "evidence"),
		skillsDir: join(dir, "skills"),
		reportsDir: join(dir, "reports"),
		globalDir,
		globalDb: join(globalDir, "global.db"),
		globalSkillsDir: join(globalDir, "skills"),
		extensionDir: EXTENSION_DIR,
	};
}
