/**
 * Prelude entry (plan §4, M1): registers the gate, test mode, the progress/verify/report tools and
 * the test-pilot Skill. `createPrelude` takes options for tests; the default export is what pi
 * loads.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Prelude, type PreludeOptions } from "./context.ts";
import { registerMode, TEST_PILOT } from "./mode.ts";
import { createFindingRecordTool, createTestProgressTool } from "./progress.ts";
import questionnaire from "./questionnaire.ts";
import { createReportFinalizeTool } from "./report.ts";
import { createVerifyFindingsTool } from "./verify.ts";

export { Prelude, type PreludeOptions } from "./context.ts";

export function createPrelude(options: PreludeOptions = {}, onCreate?: (p: Prelude) => void): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const prelude = new Prelude(options);
		onCreate?.(prelude);
		prelude.gate()(pi);
		questionnaire(pi);
		pi.registerTool(createTestProgressTool(prelude));
		pi.registerTool(createFindingRecordTool(prelude));
		pi.registerTool(createVerifyFindingsTool(prelude));
		pi.registerTool(createReportFinalizeTool(prelude));
		registerMode(pi, prelude);
		// M1-4: loaded from the extension; M2-7 moves it to the knowledge base.
		pi.on("resources_discover", () => ({ skillPaths: [TEST_PILOT] }));
	};
}

export default createPrelude();
