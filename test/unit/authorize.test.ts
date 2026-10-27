import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECLINE, decide, normalizeHost } from "../../src/authorize.ts";
import { applyScopeGrant, loadScope } from "../../src/guard/scope.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
});
afterEach(() => p.cleanup());

/** A UI that answers each dialog in turn and records what it was asked. */
function ui(...answers: Array<string | undefined | ((options: string[]) => string | undefined)>) {
	const asked: Array<{ title: string; options: string[] }> = [];
	return {
		asked,
		select: async (title: string, options: string[]) => {
			asked.push({ title, options });
			const a = answers.shift();
			return typeof a === "function" ? a(options) : a;
		},
	};
}
const first = (o: string[]) => o[0];

describe("scope_request dialogs (D-29)", () => {
	it("asks per target for the missing kinds and grants what the user picks", async () => {
		const u = ui(first, "Allow functional only", DECLINE);
		const { grant, lines } = await decide(u, undefined, {
			reason: "test the order flow",
			targets: [
				{ host: "http://staging.example.com:8080/app", allowed: ["functional"], envs: ["staging"] },
				{ host: "api.example.com", allowed: ["functional", "load"], limits: { max_concurrency: 50 } },
				{ host: "pay.example.com", allowed: ["security-check"] },
			],
		});
		expect(u.asked.map((a) => a.options)).toEqual([
			["Allow functional", DECLINE],
			["Allow functional, load", "Allow functional only", DECLINE],
			["Allow security-check", DECLINE],
		]);
		expect(u.asked[0].title).toContain("Environment: staging");
		expect(u.asked[1].title).toContain('Limits: {"max_concurrency":50}');
		expect(u.asked[2].title).toMatch(/security-check \(scanners, injection/);
		expect(u.asked.every((a) => a.title.includes("Reason: test the order flow"))).toBe(true);
		expect(grant.targets?.map((t) => [t.host, t.allowed])).toEqual([
			["staging.example.com:8080", ["functional"]],
			["api.example.com", ["functional"]],
		]);
		expect(lines).toEqual([
			"staging.example.com:8080: granted functional",
			"api.example.com: granted functional; declined load",
			"pay.example.com: declined (security-check)",
		]);
	});

	it("only asks for what is not already granted, and treats a closed dialog as declined", async () => {
		const scope = { targets: [{ host: "localhost:4100", allowed: ["functional" as const] }] };
		const u = ui(undefined);
		const { grant, lines } = await decide(u, scope, {
			reason: "r",
			targets: [
				{ host: "127.0.0.1:4100", allowed: ["functional"] },
				{ host: "localhost:4100", allowed: ["functional", "load"] },
			],
		});
		expect(u.asked).toHaveLength(1);
		expect(u.asked[0].options).toEqual(["Allow load", DECLINE]);
		expect(grant.targets).toEqual([]);
		expect(lines).toEqual(["127.0.0.1:4100: already authorized for functional", "localhost:4100: declined (load)"]);
	});

	it("asks separately for extra hosts and for the isolated host", async () => {
		const u = ui("Allow", DECLINE, "Yes, this machine is disposable");
		const { grant, lines } = await decide(u, undefined, {
			reason: "r",
			egress: ["registry.npmjs.org", "https://cdn.example.com/x"],
			isolated_host: true,
		});
		expect(grant).toMatchObject({ egress: ["registry.npmjs.org"], isolatedHost: true });
		expect(lines).toEqual(["registry.npmjs.org: reachable", "cdn.example.com: declined", "isolated host: confirmed"]);
		expect(u.asked[2].title).toMatch(/disposable Windows Sandbox or virtual machine/);
	});

	it("rejects things that are not hosts", () => {
		expect(normalizeHost("HTTP://Example.COM:80/")).toBe("example.com");
		expect(normalizeHost("*.Example.com")).toBe("*.example.com");
		expect(() => normalizeHost("   ")).toThrow(/not a host/);
	});
});

describe("applying a grant", () => {
	it("merges into scope.json and never removes anything", () => {
		const file = p.paths.scopeFile;
		applyScopeGrant(file, { targets: [{ host: "a.example.com", allowed: ["functional"], envs: ["staging"] }] });
		applyScopeGrant(file, {
			targets: [{ host: "a.example.com", allowed: ["load"], limits: { max_concurrency: 20 } }],
			egress: ["registry.npmjs.org"],
			isolatedHost: true,
		});
		applyScopeGrant(file, { targets: [{ host: "a.example.com", allowed: ["functional"] }] });
		expect(loadScope(file).scope).toEqual({
			targets: [{ host: "a.example.com", allowed: ["functional", "load"], envs: ["staging"] }],
			limits: { "a.example.com": { max_concurrency: 20 } },
			egress_allowlist: ["registry.npmjs.org"],
			isolated_host: true,
		});
	});

	it("refuses to overwrite a file that does not parse", () => {
		const file = p.paths.scopeFile;
		applyScopeGrant(file, { egress: ["x.example.com"] });
		writeFileSync(file, "{ broken");
		expect(() => applyScopeGrant(file, { egress: ["y.example.com"] })).toThrow(/user has to fix the file/);
		expect(readFileSync(file, "utf8")).toBe("{ broken");
	});
});
