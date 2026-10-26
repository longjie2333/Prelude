/**
 * Authorization scope (agent-core §11.1). Human-maintained, read-only for agents; the policy gate
 * blocks every agent write to it.
 */
import { existsSync, readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TEST_KINDS = ["functional", "load", "security-check", "destructive"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const ScopeSchema = Type.Object({
	project: Type.Optional(Type.String()),
	targets: Type.Array(
		Type.Object({
			/** `host` or `host:port`; a leading `*.` matches subdomains. */
			host: Type.String({ minLength: 1 }),
			envs: Type.Optional(Type.Array(Type.String())),
			allowed: Type.Array(StringEnum(TEST_KINDS)),
		}),
	),
	limits: Type.Optional(
		Type.Object({
			load: Type.Optional(
				Type.Object({
					max_rps: Type.Optional(Type.Number()),
					max_duration: Type.Optional(Type.String()),
					max_concurrency: Type.Optional(Type.Number()),
					windows: Type.Optional(Type.Array(Type.String())),
				}),
			),
			security_check: Type.Optional(
				Type.Object({ ruleset: Type.Optional(Type.String()), intrusive: Type.Optional(Type.Boolean()) }),
			),
		}),
	),
	data: Type.Optional(Type.Object({ policy: Type.String() })),
	egress_allowlist: Type.Optional(Type.Array(Type.String())),
});
export type Scope = Static<typeof ScopeSchema>;

export interface ScopeLoad {
	scope?: Scope;
	/** Set when the file exists but is invalid; an invalid scope is treated as missing. */
	error?: string;
}

export function parseScope(raw: unknown): ScopeLoad {
	if (!Value.Check(ScopeSchema, raw)) {
		const first = [...Value.Errors(ScopeSchema, raw)][0];
		return { error: `scope.json invalid at ${first?.instancePath || "/"}: ${first?.message ?? "schema mismatch"}` };
	}
	return { scope: raw };
}

export function loadScope(path: string): ScopeLoad {
	if (!existsSync(path)) return {};
	try {
		return parseScope(JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		return { error: `scope.json unreadable: ${(err as Error).message}` };
	}
}

/** Extracts `host` and optional port from a URL, `host:port`, or bare host. */
export function parseHost(target: string): { host: string; port?: string } | undefined {
	const t = target.trim();
	if (!t) return undefined;
	try {
		const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
		if (!u.hostname) return undefined;
		return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: u.port || undefined };
	} catch {
		return undefined;
	}
}

function hostPatternMatches(pattern: string, target: { host: string; port?: string }): boolean {
	const p = parseHost(pattern.startsWith("*.") ? pattern.slice(2) : pattern);
	if (!p) return false;
	const hostOk = pattern.startsWith("*.")
		? target.host === p.host || target.host.endsWith(`.${p.host}`)
		: target.host === p.host;
	return hostOk && (!p.port || p.port === target.port);
}

export function findScopeTarget(scope: Scope | undefined, target: string): Scope["targets"][number] | undefined {
	const t = parseHost(target);
	if (!scope || !t) return undefined;
	return scope.targets.find((st) => hostPatternMatches(st.host, t));
}

/** Hosts an agent may reach: scope targets plus the egress allowlist. */
export function isEgressAllowed(scope: Scope | undefined, target: string): boolean {
	const t = parseHost(target);
	if (!scope || !t) return false;
	return (
		scope.targets.some((st) => hostPatternMatches(st.host, t)) ||
		(scope.egress_allowlist ?? []).some((h) => hostPatternMatches(h, t))
	);
}

const PROD_ENV = /^(prod|production|live)$/i;

export function isProductionTarget(scope: Scope | undefined, target: string): boolean {
	const st = findScopeTarget(scope, target);
	if (st?.envs?.some((e) => PROD_ENV.test(e))) return true;
	return /(^|\.)prod(uction)?(\.|$)/i.test(parseHost(target)?.host ?? "");
}
