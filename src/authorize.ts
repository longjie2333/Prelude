/**
 * `scope_request` (D-29, design §9): the model asks for the authorization a test needs (targets
 * and test kinds, extra hosts, an isolated host); the user decides each item in a dialog; code
 * writes exactly what was approved into `.prelude/scope.json`. The model never writes the file
 * and cannot approve anything itself; without a UI nothing is granted.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Prelude } from "./context.ts";
import {
	applyScopeGrant,
	findScopeTarget,
	isHostAllowed,
	loadScope,
	parseHost,
	type Scope,
	type ScopeGrant,
	TEST_KINDS,
	type TestKind,
} from "./guard/scope.ts";
import { textResult } from "./util.ts";

export interface AuthorizeUi {
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface ScopeRequest {
	reason: string;
	targets?: Array<{ host: string; allowed: TestKind[]; envs?: string[]; limits?: Record<string, unknown> }>;
	egress?: string[];
	isolated_host?: boolean;
}

export const DECLINE = "Decline";
const FUNCTIONAL_ONLY = "Allow functional only";

/** `host` or `host:port`, lower-cased; a URL is reduced to its host. Wildcards stay as given. */
export function normalizeHost(raw: string): string {
	const t = raw.trim();
	if (t.startsWith("*.")) return t.toLowerCase();
	const h = parseHost(t);
	if (!h) throw new Error(`not a host: ${raw}`);
	return h.port ? `${h.host}:${h.port}` : h.host;
}

const KIND_NOTE: Record<TestKind, string> = {
	functional: "functional",
	load: "load",
	"security-check": "security-check (scanners, injection and access-control probes)",
	destructive: "destructive (may delete or corrupt data)",
};

/** Asks the user about each requested item; returns what to grant and a line per decision. */
export async function decide(
	ui: AuthorizeUi,
	scope: Scope | undefined,
	req: ScopeRequest,
): Promise<{ grant: ScopeGrant; lines: string[] }> {
	const grant: ScopeGrant = { targets: [], egress: [] };
	const lines: string[] = [];
	for (const t of req.targets ?? []) {
		const host = normalizeHost(t.host);
		const have = findScopeTarget(scope, host)?.allowed ?? [];
		const missing = [...new Set(t.allowed)].filter((k) => !have.includes(k));
		if (missing.length === 0) {
			lines.push(`${host}: already authorized for ${t.allowed.join(", ")}`);
			continue;
		}
		const details = [
			`Authorize ${host} for: ${missing.map((k) => KIND_NOTE[k]).join(", ")}?`,
			t.envs?.length ? `Environment: ${t.envs.join(", ")}` : "",
			t.limits && Object.keys(t.limits).length ? `Limits: ${JSON.stringify(t.limits)}` : "",
			`Reason: ${req.reason}`,
		].filter(Boolean);
		const options = [`Allow ${missing.join(", ")}`];
		if (missing.length > 1 && missing.includes("functional")) options.push(FUNCTIONAL_ONLY);
		options.push(DECLINE);
		const choice = await ui.select(details.join("\n"), options);
		const kinds: TestKind[] = choice === options[0] ? missing : choice === FUNCTIONAL_ONLY ? ["functional"] : [];
		if (kinds.length === 0) {
			lines.push(`${host}: declined (${missing.join(", ")})`);
			continue;
		}
		grant.targets?.push({ host, allowed: kinds, envs: t.envs, limits: t.limits });
		const refused = missing.filter((k) => !kinds.includes(k));
		lines.push(`${host}: granted ${kinds.join(", ")}${refused.length ? `; declined ${refused.join(", ")}` : ""}`);
	}
	for (const raw of req.egress ?? []) {
		const host = normalizeHost(raw);
		if (isHostAllowed(scope, host)) {
			lines.push(`${host}: already reachable`);
			continue;
		}
		const choice = await ui.select(
			`Allow access to ${host}? It is not a test target (for example a package registry or a login provider).\nReason: ${req.reason}`,
			["Allow", DECLINE],
		);
		if (choice === "Allow") {
			grant.egress?.push(host);
			lines.push(`${host}: reachable`);
		} else lines.push(`${host}: declined`);
	}
	if (req.isolated_host) {
		if (scope?.isolated_host) lines.push("isolated host: already confirmed");
		else {
			const choice = await ui.select(
				`Does pi run inside a disposable Windows Sandbox or virtual machine? Confirming lets the model install and run the program under test on this machine.\nReason: ${req.reason}`,
				["Yes, this machine is disposable", DECLINE],
			);
			grant.isolatedHost = choice === "Yes, this machine is disposable";
			lines.push(grant.isolatedHost ? "isolated host: confirmed" : "isolated host: declined");
		}
	}
	return { grant, lines };
}

function granted(g: ScopeGrant): boolean {
	return !!(g.targets?.length || g.egress?.length || g.isolatedHost);
}

export function createScopeRequestTool(prelude: Prelude) {
	return defineTool({
		name: "scope_request",
		label: "Request authorization",
		description:
			"Ask the user to authorize what this test needs: target hosts and the test kinds for each (functional, load, security-check, destructive), extra hosts to reach, or that pi runs in a disposable sandbox. The user approves or declines each item in a dialog; Prelude writes only what was approved to .prelude/scope.json. Ask once at intake for everything the plan needs; ask again only for something new.",
		promptSnippet: "Ask the user to authorize targets and test kinds",
		promptGuidelines: [
			"Call scope_request at intake, together with the questionnaire, for every target and test kind the test plan needs; ask for the least that serves the goal.",
			"What scope_request reports as declined stays declined: do not test it another way, and list it under 没测什么.",
		],
		parameters: Type.Object({
			reason: Type.String({
				minLength: 1,
				description: "Why the test needs it, in one or two sentences the user will read",
			}),
			targets: Type.Optional(
				Type.Array(
					Type.Object({
						host: Type.String({
							description: "host or host:port (a URL is reduced to it); *.example.com for subdomains",
						}),
						allowed: Type.Array(StringEnum(TEST_KINDS), { minItems: 1 }),
						envs: Type.Optional(Type.Array(Type.String(), { description: "e.g. staging, local" })),
						limits: Type.Optional(
							Type.Record(Type.String(), Type.Unknown(), {
								description:
									"Intensity the test will stay within, e.g. { max_concurrency: 50, max_duration: '2m' }",
							}),
						),
					}),
				),
			),
			egress: Type.Optional(Type.Array(Type.String(), { description: "Hosts to reach that are not test targets" })),
			isolated_host: Type.Optional(
				Type.Boolean({ description: "Ask the user to confirm pi runs in a disposable sandbox or VM" }),
			),
		}),
		executionMode: "sequential",
		defaultActive: false,
		async execute(_id, params) {
			const run = prelude.run();
			const ctx = prelude.ctx;
			if (!ctx?.hasUI)
				throw new Error(
					"no user is present to authorize anything; continue within the current scope and list what was not authorized under 没测什么",
				);
			const file = run.project.scopeFile;
			const current = loadScope(file);
			if (current.error) throw new Error(`${current.error}; the user has to fix the file first`);
			const { grant, lines } = await decide({ select: (t, o) => ctx.ui.select(t, o) }, current.scope, params);
			if (granted(grant)) applyScopeGrant(file, grant);
			prelude.audit({
				event: "scope_grant",
				decision: granted(grant) ? "allow" : "deny",
				reason: params.reason.slice(0, 300),
				detail: { granted: grant, decisions: lines },
			});
			return textResult(lines.join("\n") || "Nothing was requested.", { granted: grant, decisions: lines });
		},
	});
}
