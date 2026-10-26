/**
 * Child process for the crash-recovery e2e test (plan M1-14 §9). Hosts an orchestrator with one
 * executor mission that performs side effects; the parent kills this process mid-tool-execution.
 * Runs under plain `node` (type stripping), so it imports sources with `.ts` extensions.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.ts";
import { resolvePaths } from "../../../src/paths.ts";
import { openStore } from "../../../src/store/db.ts";
import { insertIntent } from "../../../src/store/repos.ts";
import { createRouter } from "../faux.ts";

const root = process.env.TM_ROOT as string;
const agentDir = process.env.TM_AGENT as string;
const url = process.env.CANARY_URL as string;
const order = (productId: string) =>
	`curl -s -X POST ${url}/orders -H 'content-type: application/json' -d '{"productId":"${productId}","qty":1}'`;

const paths = resolvePaths(root, agentDir);
const store = openStore(paths.projectDb, paths.globalDb);
const router = createRouter(agentDir, {
	executor: [
		() => fauxAssistantMessage(fauxToolCall("bash", { command: order("p3") }, { id: "post1" })),
		() =>
			fauxAssistantMessage([
				fauxToolCall("bash", { command: order("p3") }, { id: "post2" }),
				fauxToolCall("bash", { command: `${order("p4")} && sleep 20` }, { id: "hang" }),
				fauxToolCall("test_run", { command: "sleep 20" }, { id: "tr1" }),
			]),
	],
});
const o = new Orchestrator({
	paths,
	agentDir,
	store,
	modelRuntime: router.runtime,
	noSandbox: true,
	heartbeatMs: 200,
	missionSettings: { retry: { enabled: false } },
});
insertIntent(store, "i-crash", "crash test", { constraints: { environment: "local" } });
const [outcome] = await o.dispatch(
	"i-crash",
	[{ role: "executor", objective: "make orders", targets: [url], testKinds: ["functional"] }],
	router.model(),
);
process.stdout.write(`${JSON.stringify(outcome)}\n`);
setInterval(() => undefined, 1000);
