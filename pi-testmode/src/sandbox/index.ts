/**
 * OS-level bash isolation for missions (plan M1-7).
 * Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/sandbox/index.ts:
 * the config comes from the mission's authorization scope instead of `.pi/sandbox.json`, and is
 * passed per command (`wrapWithSandbox(..., customConfig)`) so concurrent missions with different
 * scopes share one initialized SandboxManager.
 *
 * Only macOS and Linux are supported; on Windows `isolationLevel()` reports tool-layer policy only.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type BashOperations, createBashTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { parseHost, type Scope } from "../kernel/scope.ts";

export interface MissionSandboxConfig {
	network: { allowedDomains: string[]; deniedDomains: string[] };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

export function sandboxConfigFor(opts: {
	scope?: Scope;
	targets: readonly string[];
	runDir: string;
	agentDir: string;
	home?: string;
}): MissionSandboxConfig {
	const home = opts.home ?? homedir();
	const domains = new Set<string>();
	for (const h of opts.scope?.egress_allowlist ?? []) domains.add(h);
	for (const t of opts.scope?.targets ?? []) {
		const host = parseHost(t.host.replace(/^\*\./, ""));
		if (host) domains.add(t.host.startsWith("*.") ? `*.${host.host}` : host.host);
	}
	for (const t of opts.targets) {
		const host = parseHost(t);
		if (host) domains.add(host.host);
	}
	return {
		network: { allowedDomains: [...domains].sort(), deniedDomains: [] },
		filesystem: {
			denyRead: [join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg"), join(opts.agentDir, "auth.json")],
			allowWrite: [opts.runDir, tmpdir()],
			denyWrite: [".env", ".env.*", "*.pem", "*.key"],
		},
	};
}

export function sandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin" || platform === "linux";
}

export function isolationLevel(sandboxActive: boolean): string {
	if (sandboxActive) return "OS sandbox (sandbox-runtime: filesystem + network allowlist) + tool-layer policy";
	if (process.platform === "win32") {
		return "tool-layer policy only (no OS sandbox on Windows; run pi in the official Docker setup for strong isolation)";
	}
	return "tool-layer policy only (sandbox-runtime unavailable)";
}

type SandboxModule = typeof import("@anthropic-ai/sandbox-runtime");
let sandboxModule: Promise<SandboxModule | undefined> | undefined;
let initialized: Promise<boolean> | undefined;

async function loadSandbox(): Promise<SandboxModule | undefined> {
	sandboxModule ??= import("@anthropic-ai/sandbox-runtime").catch(() => undefined);
	return sandboxModule;
}

/** Initializes the shared SandboxManager once; resolves false when isolation is unavailable. */
export async function ensureSandbox(base: MissionSandboxConfig): Promise<boolean> {
	if (!sandboxSupported()) return false;
	initialized ??= (async () => {
		const mod = await loadSandbox();
		if (!mod) return false;
		try {
			await mod.SandboxManager.initialize({ network: base.network, filesystem: base.filesystem });
			return true;
		} catch {
			return false;
		}
	})();
	return initialized;
}

function sandboxedOps(mod: SandboxModule, config: MissionSandboxConfig): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const wrapped = await mod.SandboxManager.wrapWithSandbox(command, undefined, config);
			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrapped], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const kill = () => {
					if (!child.pid) return;
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};
				const timer =
					timeout && timeout > 0 ? setTimeout(() => ((timedOut = true), kill()), timeout * 1000) : undefined;
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				});
				signal?.addEventListener("abort", kill, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", kill);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

/**
 * Replaces the mission's `bash` tool with a sandboxed one. Returns undefined when the platform
 * or runtime does not support it; the caller then reports tool-layer isolation only.
 */
export async function missionSandboxExtension(
	cwd: string,
	config: MissionSandboxConfig,
): Promise<ExtensionFactory | undefined> {
	if (!(await ensureSandbox(config))) return undefined;
	const mod = await loadSandbox();
	if (!mod) return undefined;
	return (pi) => {
		const local = createBashTool(cwd);
		const sandboxed = createBashTool(cwd, { operations: sandboxedOps(mod, config) });
		pi.registerTool({
			...local,
			label: "bash (sandboxed)",
			execute: (id, params, signal, onUpdate) => sandboxed.execute(id, params, signal, onUpdate),
		});
	};
}
