/**
 * Prelude entry (plan §4): registers the gate, test mode, the progress/verify/report tools, the
 * knowledge-base tools, and the Skills (methodology and categories). `createPrelude` takes options for tests; the default export is what pi
 * loads.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Prelude, type PreludeOptions } from "./context.ts";
import { createScopeRequestTool } from "./authorize.ts";
import { createKbTools } from "./kb/api.ts";
import { registerMode } from "./mode.ts";
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
		pi.registerTool(createScopeRequestTool(prelude));
		pi.registerTool(createTestProgressTool(prelude));
		pi.registerTool(createFindingRecordTool(prelude));
		pi.registerTool(createVerifyFindingsTool(prelude));
		pi.registerTool(createReportFinalizeTool(prelude));
		for (const tool of createKbTools(prelude)) pi.registerTool(tool);
		registerMode(pi, prelude);
	};
}

export default createPrelude();
