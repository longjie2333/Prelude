import { spawn, spawnSync } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export interface ProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	aborted: boolean;
	spawnError?: string;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

function killTree(pid: number): void {
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

/** Runs `command` in the same shell pi's bash tool uses (Git Bash on Windows). */
export function runShell(
	command: string,
	opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal },
): Promise<ProcessResult> {
	const shell = getShellConfig();
	const started = Date.now();
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const child = spawn(shell.shell, shell.commandTransport === "stdin" ? shell.args : [...shell.args, command], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const finish = (r: Omit<ProcessResult, "stdout" | "stderr" | "durationMs" | "timedOut" | "aborted">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({ ...r, stdout, stderr, durationMs: Date.now() - started, timedOut, aborted });
		};
		const onAbort = () => {
			aborted = true;
			if (child.pid) killTree(child.pid);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) killTree(child.pid);
		}, opts.timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b: Buffer) => {
			if (stdout.length < MAX_CAPTURE) stdout += b.toString("utf8");
		});
		child.stderr.on("data", (b: Buffer) => {
			if (stderr.length < MAX_CAPTURE) stderr += b.toString("utf8");
		});
		child.on("error", (err) => finish({ exitCode: null, signal: null, spawnError: err.message }));
		child.on("close", (code, signal) => finish({ exitCode: code, signal }));
		if (shell.commandTransport === "stdin") child.stdin.end(command);
		else child.stdin.end();
	});
}
