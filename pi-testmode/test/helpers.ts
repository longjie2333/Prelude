import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanary } from "../canary/server.mjs";
import type { PolicyContext } from "../src/kernel/policy.ts";
import { resolvePaths, type TestmodePaths } from "../src/paths.ts";
import { openStore, type Store } from "../src/store/db.ts";

export interface TempProject {
	root: string;
	agentDir: string;
	paths: TestmodePaths;
	store: Store;
	cleanup(): void;
}

export function tempProject(): TempProject {
	const base = mkdtempSync(join(tmpdir(), "pitm-"));
	const root = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const paths = resolvePaths(root, agentDir);
	const store = openStore(paths.projectDb, paths.globalDb);
	return {
		root,
		agentDir,
		paths,
		store,
		cleanup() {
			store.close();
			try {
				rmSync(base, { recursive: true, force: true, maxRetries: 3 });
			} catch {
				// Windows may hold WAL files briefly
			}
		},
	};
}

export function policyCtx(p: TempProject, over: Partial<PolicyContext> = {}): PolicyContext {
	return {
		mode: "mission",
		cwd: p.root,
		home: join(p.root, "..", "home"),
		testmodeDir: p.paths.dir,
		scopeFile: p.paths.scopeFile,
		globalDir: p.paths.globalDir,
		agentDir: p.agentDir,
		extensionDir: p.paths.extensionDir,
		runsDir: p.paths.runsDir,
		missionId: "m-1",
		runDir: join(p.paths.runsDir, "m-1"),
		missionTier: "R3",
		scope: {
			targets: [{ host: "localhost:4100", envs: ["local"], allowed: ["functional", "load"] }],
			egress_allowlist: ["registry.npmjs.org"],
		},
		frozen: new Set(),
		...over,
	};
}

export async function startCanary(
	opts: Parameters<typeof createCanary>[0] = {},
): Promise<{ url: string; port: number; close(): Promise<void>; setMode: ReturnType<typeof createCanary>["setMode"] }> {
	const server = createCanary(opts);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://localhost:${port}`,
		port,
		setMode: (m) => server.setMode(m),
		close: () => new Promise((r) => server.close(() => r())),
	};
}

/** Path for a TESTMODE_DEBUG output file under `<package>/tmp/` (gitignored); creates the directory. */
export function debugFile(name: string): string {
	const dir = join(process.cwd(), "tmp");
	mkdirSync(dir, { recursive: true });
	return join(dir, name);
}

export async function waitFor<T>(
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs = 20_000,
	intervalMs = 25,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
