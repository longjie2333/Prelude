/**
 * The package loads the way `pi -e .` loads it (plan M1-1): pi resolves `package.json` →
 * `pi.extensions` and runs `src/index.ts` through jiti, not through the test's module graph.
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EXTENSION_DIR } from "../../src/paths.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
});
afterEach(() => p.cleanup());

it("loads from the package root with its tools and commands", async () => {
	const loader = new DefaultResourceLoader({
		cwd: p.root,
		agentDir: p.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [EXTENSION_DIR],
	});
	await loader.reload();
	const result = loader.getExtensions();
	expect(result.errors).toEqual([]);
	const ext = result.extensions.find((e) => e.resolvedPath.replace(/\\/g, "/").includes("/src/index.ts"));
	expect(ext).toBeDefined();
	expect([...(ext?.tools.keys() ?? [])].sort()).toEqual([
		"finding_record",
		"questionnaire",
		"report_finalize",
		"test_progress",
		"verify_findings",
	]);
	expect([...(ext?.commands.keys() ?? [])].sort()).toEqual(["prelude-init", "test"]);
});
