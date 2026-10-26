/** Intent IR (agent-core §6.1), validated before it is stored (plan M1-4). */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const GOAL_KINDS = [
	"find_defects",
	"assess_quality",
	"regression_guard",
	"compliance_check",
	"explore",
] as const;

export const IntentIRSchema = Type.Object({
	raw: Type.String({ description: "The user's request, verbatim" }),
	goal: Type.Object({
		kind: StringEnum(GOAL_KINDS),
		quality_attributes: Type.Array(Type.String(), {
			description: "e.g. correctness.consistency, performance.concurrency",
		}),
		hypotheses: Type.Array(Type.String(), { description: "Concrete failure hypotheses to test" }),
	}),
	sut_refs: Type.Array(
		Type.Object({
			kind: StringEnum(["api", "web", "cli", "library", "service", "repo"] as const),
			locator: Type.String({ description: "URL, OpenAPI path, package, or repo path" }),
			env: Type.Optional(Type.String()),
		}),
		{ minItems: 1 },
	),
	constraints: Type.Object({
		environment: Type.String({ description: "Target environment: local, dev, staging, production, …" }),
		data: Type.Optional(Type.String({ description: "e.g. synthetic-only" })),
		destructive_allowed: Type.Optional(Type.Boolean()),
		deadline: Type.Optional(Type.String()),
	}),
	acceptance: Type.Array(Type.String(), { minItems: 1, description: "What counts as done" }),
	assumptions: Type.Array(Type.String(), {
		description: "Gaps you filled with defaults; they are listed in the report",
	}),
	open_questions: Type.Array(Type.String(), { description: "Must be empty: ask with questionnaire first" }),
});

export type IntentIR = Static<typeof IntentIRSchema>;

/** Deterministic checks the schema cannot express. Returns problems for the model to fix. */
export function intentProblems(ir: IntentIR): string[] {
	const problems: string[] = [];
	if (ir.open_questions.length > 0) {
		problems.push(
			"open_questions is not empty: ask them with questionnaire, then record the answers (or list remaining gaps as assumptions)",
		);
	}
	if (!ir.constraints.environment.trim())
		problems.push("constraints.environment is empty: it changes the risk tier, so ask with questionnaire");
	return problems;
}
