/**
 * Seed knowledge (agent-core §13, plan M2-1): a small facet vocabulary and a few global
 * `candidate` templates with weak priors. Few and focused on purpose.
 *
 * `consistency.model` is deliberately absent: M3's acceptance scenario (agent-core §14, act 3)
 * requires the system to discover it as a new facet from a false positive.
 */
import type { Predicate, TemplateSpec } from "../schema.ts";

export interface SeedFacet {
	name: string;
	type: "enum" | "hier" | "bool" | "set" | "number";
	values: string[];
}

export const SEED_FACETS: SeedFacet[] = [
	{ name: "sut.kind", type: "enum", values: ["rest-api", "web-ui", "cli", "library", "service"] },
	{ name: "sut.stack", type: "hier", values: ["node", "jvm", "python", "go", "dotnet"] },
	{ name: "interface.protocol", type: "hier", values: ["http/json", "http/html", "grpc", "graphql"] },
	{ name: "interface.pagination", type: "bool", values: ["true", "false"] },
	{ name: "state.shared_resource", type: "bool", values: ["true", "false"] },
	{ name: "state.resource_kind", type: "enum", values: ["inventory", "quota", "balance", "seat"] },
	{ name: "env.kind", type: "enum", values: ["local", "dev", "staging", "production"] },
	{ name: "oracle.availability", type: "set", values: ["spec", "invariant", "reference", "baseline"] },
	{ name: "spec.format", type: "enum", values: ["openapi", "graphql-schema", "none"] },
	{
		name: "goal.kind",
		type: "enum",
		values: ["find_defects", "assess_quality", "regression_guard", "compliance_check", "explore"],
	},
	{
		name: "quality.attribute",
		type: "set",
		values: ["correctness.consistency", "correctness.functional", "robustness.input", "performance.concurrency"],
	},
];

export interface SeedTemplate {
	spec: TemplateSpec;
	body: string;
}

const P = (facet: string, op: Predicate["op"], v?: string | string[]): Predicate =>
	Array.isArray(v) ? { facet, op, values: v } : v === undefined ? { facet, op } : { facet, op, value: v };

function seed(
	partial: Pick<TemplateSpec, "id" | "type" | "card" | "intent_patterns"> & Partial<TemplateSpec>,
	body: string,
): SeedTemplate {
	return {
		spec: {
			applicability: { hard: [], soft: [], exceptions: [], unknown_handling: [] },
			io: { inputs: [], outputs: [] },
			slots: {},
			verdict: {
				fail_when: "the oracle is violated",
				pass_when: "the oracle holds",
				inconclusive_when: "the oracle cannot be evaluated",
			},
			control: { max_repair_iterations: 3, stop_when: ["verdict_reached", "budget_exhausted"] },
			parameters: [],
			procedure: [],
			capabilities_required: [],
			evidence_contract: { required: ["run_log"] },
			risk_tier_floor: "R0",
			pitfalls: [],
			recovery: [],
			...partial,
		},
		body,
	};
}

const PROD_EXCLUDE = {
	id: "ex-prod",
	when: [P("env.kind", "eq", "production")],
	action: "exclude" as const,
	because: "no state-changing tests in production",
	source: "policy" as const,
};

export const SEED_TEMPLATES: SeedTemplate[] = [
	seed(
		{
			id: "tpl://global/oracle.spec-assertion",
			type: "oracle",
			card: {
				title: "Spec assertion oracle",
				summary:
					"Expected values come from the interface specification (status codes, schemas, documented rules), never from observed output.",
			},
			intent_patterns: ["接口 规格", "spec", "openapi", "契约", "contract", "schema"],
			applicability: {
				hard: [P("oracle.availability", "contains", "spec")],
				soft: [],
				exceptions: [],
				unknown_handling: [],
			},
			slots: { oracle: { text: "assert documented status codes, schemas and rules", strength: "high" } },
		},
		"Derive every expected value from the spec. If the spec is silent, the check is an observation, not a pass/fail oracle.",
	),
	seed(
		{
			id: "tpl://global/oracle.conservation-invariant",
			type: "oracle",
			card: {
				title: "Conservation invariant oracle",
				summary:
					"Check that a conserved quantity (stock, balance, quota) satisfies initial − Σaccepted = final ≥ 0 after concurrent writes.",
			},
			intent_patterns: [
				"超卖",
				"库存",
				"余额为负",
				"重复扣减",
				"配额",
				"并发一致性",
				"oversell",
				"double spend",
				"quota",
				"inventory",
				"balance",
			],
			applicability: {
				hard: [P("state.shared_resource", "eq", "true")],
				soft: [
					{ when: P("quality.attribute", "contains", "correctness.consistency"), weight: 0.5 },
					{ when: P("goal.kind", "eq", "find_defects"), weight: 0.3 },
				],
				exceptions: [],
				unknown_handling: [],
			},
			slots: {
				oracle: { text: "initial − Σ(accepted qty) == final and final ≥ 0", strength: "high" },
				observation: ["accepted count", "value before", "value after"],
			},
			procedure: [
				{ step: 1, do: "reset and record the initial value", expect: "readable and stable" },
				{
					step: 2,
					do: "send concurrent writes against the same key",
					expect: "some accepted, some rejected with a business code",
				},
				{ step: 3, do: "read the final value", expect: "final = initial − accepted" },
			],
			evidence_contract: { required: ["minimal_repro", "state_snapshot", "run_log"], reproducibility_min: 0.6 },
		},
		"Expected values come from the invariant, not from what the SUT returns. Report accepted count, before and after values. Repeat the burst to estimate reproducibility.",
	),
	seed(
		{
			id: "tpl://global/oracle.implicit-5xx",
			type: "oracle",
			card: {
				title: "Implicit 5xx oracle",
				summary: "Any 5xx response or crash for schema-valid input is a defect, regardless of business rules.",
			},
			intent_patterns: ["500", "崩溃", "5xx", "crash", "异常输入", "emoji", "unicode", "robustness"],
			applicability: {
				hard: [P("interface.protocol", "in", ["http/*"])],
				soft: [{ when: P("quality.attribute", "contains", "robustness.input"), weight: 1 }],
				exceptions: [],
				unknown_handling: [],
			},
			slots: { oracle: { text: "status < 500 for every schema-valid request", strength: "low" } },
		},
		"A free oracle: cheap to apply to every request a mission sends. Strength is low; it says nothing about wrong-but-200 answers.",
	),
	seed(
		{
			id: "tpl://global/technique.boundary-value",
			type: "technique",
			card: {
				title: "Boundary value analysis",
				summary: "Exercise each input and page boundary: min, min−1, max, max+1, empty, last page, last item.",
			},
			intent_patterns: ["边界", "分页", "最后一页", "boundary", "pagination", "off-by-one", "limit"],
			applicability: {
				hard: [],
				soft: [{ when: P("interface.pagination", "eq", "true"), weight: 1 }],
				exceptions: [],
				unknown_handling: [],
			},
			slots: { stimulus: { generator: { text: "boundary values per input and per page" } } },
		},
		"For pagination: the union of all pages must equal the total, each item exactly once; check the last page explicitly.",
	),
	seed(
		{
			id: "tpl://global/technique.burst-same-key",
			type: "technique",
			card: {
				title: "Burst on the same key",
				summary: "Fire N concurrent writes at one resource key to expose missing locks or idempotency.",
			},
			intent_patterns: ["并发", "同时下单", "竞争", "concurrent", "race", "burst", "超卖"],
			applicability: {
				hard: [P("state.shared_resource", "eq", "true")],
				soft: [{ when: P("quality.attribute", "contains", "performance.concurrency"), weight: 0.5 }],
				exceptions: [PROD_EXCLUDE],
				unknown_handling: [],
			},
			slots: {
				stimulus: {
					generator: { text: "N concurrent requests on the same key (default 30)" },
					actuator: { cap: "cap:load.generate.http" },
				},
			},
			parameters: [{ name: "concurrency", type: "int", default: "30" }],
			risk_tier_floor: "R3",
		},
		"Start with N≈3×stock so oversell is possible; keep requests identical except for the key under test.",
	),
	seed(
		{
			id: "tpl://global/perception.openapi-dependency-graph",
			type: "perception",
			card: {
				title: "OpenAPI resource dependency graph",
				summary:
					"Build the producer→consumer graph of resources from an OpenAPI document to order requests and find shared state.",
			},
			intent_patterns: ["openapi", "接口文档", "依赖", "资源", "swagger", "api model"],
			applicability: {
				hard: [P("spec.format", "eq", "openapi")],
				soft: [{ when: P("sut.kind", "eq", "rest-api"), weight: 1 }],
				exceptions: [],
				unknown_handling: [],
			},
			io: { inputs: ["artifact:openapi"], outputs: ["artifact:api-model"] },
		},
		"List resources, which operations create/consume them, and which share mutable state (stock, balance). Report reset endpoints.",
	),
	seed(
		{
			id: "tpl://global/env.node-service-local",
			type: "environment",
			card: {
				title: "Local Node service",
				summary:
					"Run against a locally started Node HTTP service; reset state through its reset endpoint before each experiment.",
			},
			intent_patterns: ["本地", "local", "localhost", "node", "canary"],
			applicability: {
				hard: [P("env.kind", "in", ["local", "dev"])],
				soft: [{ when: P("sut.stack", "in", ["node"]), weight: 1 }],
				exceptions: [],
				unknown_handling: [],
			},
		},
		"Prefer the service's own reset endpoint; give each mission its own data where the service allows it.",
	),
];
