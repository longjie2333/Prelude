/** Shared test fixtures: temp project/home/agent dirs, a gate context, the canary. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanary } from "../canary/server.mjs";
import type { GateContext } from "../src/guard/gate.ts";
import { CANARY_DIR, EXTENSION_DIR, globalPaths, type ProjectPaths, projectPaths } from "../src/paths.ts";

export interface TempProject {
	base: string;
	root: string;
	home: string;
	agentDir: string;
	paths: ProjectPaths;
	cleanup(): void;
}

export function tempProject(): TempProject {
	const base = mkdtempSync(join(tmpdir(), "prelude-"));
	const root = join(base, "project");
	const home = join(base, "home");
	const agentDir = join(home, ".pi", "agent");
	for (const d of [root, home, agentDir]) mkdirSync(d, { recursive: true });
	return {
		base,
		root,
		home,
		agentDir,
		paths: projectPaths(root),
		cleanup() {
			try {
				rmSync(base, { recursive: true, force: true, maxRetries: 3 });
			} catch {
				// Windows may hold a handle briefly
			}
		},
	};
}

export function gateCtx(p: TempProject, over: Partial<GateContext> = {}): GateContext {
	return {
		testMode: true,
		cwd: p.root,
		home: p.home,
		project: p.paths,
		kbDir: globalPaths(p.home).kbDir,
		agentDir: p.agentDir,
		extensionDir: EXTENSION_DIR,
		canaryDir: CANARY_DIR,
		scope: {
			targets: [{ host: "localhost:4100", allowed: ["functional"] }],
			egress_allowlist: ["registry.npmjs.org"],
		},
		...over,
	};
}

export async function startCanary(
	opts: Parameters<typeof createCanary>[0] = {},
): Promise<{ url: string; port: number; close(): Promise<void> }> {
	const server = createCanary(opts);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return { url: `http://localhost:${port}`, port, close: () => new Promise((r) => server.close(() => r())) };
}
