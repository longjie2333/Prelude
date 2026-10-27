/**
 * The only place Prelude runs git (plan M2-2, design §6.2). Every command carries `-C <kb dir>`;
 * output is porcelain; credentials are whatever the user's git already has, never read or stored.
 *
 * Git runs through its own spawn, not `pi.exec`: `GIT_TERMINAL_PROMPT=0` must be set so a missing
 * credential fails fast instead of waiting on a prompt nobody sees, and `pi.exec` takes no env.
 */
import { spawn } from "node:child_process";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export class GitError extends Error {
	readonly result: GitResult;
	constructor(args: string[], result: GitResult) {
		super(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
		this.result = result;
	}
}

/** Fallback identity for commits on machines without one; passed with `-c`, git config is untouched. */
const IDENTITY = ["-c", "user.name=Prelude", "-c", "user.email=prelude@localhost"];

function run(args: string[], timeoutMs = 120_000): Promise<GitResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const child = spawn("git", args, {
			shell: false,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" },
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => (stdout += d.toString().replace(/\r\n/g, "\n")));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

export class Git {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Runs `git -C <dir> ...`; throws on a non-zero exit unless `allowFail`. */
	async exec(args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<GitResult> {
		const full = ["-C", this.dir, ...args];
		const r = await run(full, opts.timeoutMs);
		if (r.code !== 0 && !opts.allowFail) throw new GitError(full, r);
		return r;
	}

	static async clone(remote: string, dir: string): Promise<void> {
		const args = ["clone", "--quiet", remote, dir];
		const r = await run(args, 300_000);
		if (r.code !== 0) throw new GitError(args, r);
	}

	async isRepo(): Promise<boolean> {
		const r = await this.exec(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
		return r.code === 0 && r.stdout.trim() === "true";
	}

	async init(branch: string): Promise<void> {
		await this.exec(["init", "--quiet", "-b", branch]);
	}

	async currentBranch(): Promise<string> {
		return (await this.exec(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	}

	async hasCommits(): Promise<boolean> {
		return (await this.exec(["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true })).code === 0;
	}

	/** Paths with changes, from `status --porcelain` (untracked included). */
	async dirtyPaths(): Promise<string[]> {
		const out = (await this.exec(["status", "--porcelain", "--untracked-files=all"])).stdout;
		return out
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(3).replace(/^"|"$/g, ""));
	}

	async conflictedPaths(): Promise<string[]> {
		const out = (await this.exec(["diff", "--name-only", "--diff-filter=U"])).stdout;
		return out.split("\n").filter(Boolean);
	}

	/** Discards every uncommitted change in the knowledge base (M2-2 workspace restore). */
	async restoreClean(): Promise<void> {
		if (await this.hasCommits()) await this.exec(["checkout", "--quiet", "--", "."]);
		await this.exec(["clean", "-fdq"]);
	}

	async commitAll(message: string): Promise<boolean> {
		await this.exec(["add", "-A"]);
		const staged = await this.exec(["diff", "--cached", "--quiet"], { allowFail: true });
		if (staged.code === 0) return false;
		await this.exec([...IDENTITY, "commit", "--quiet", "-m", message]);
		return true;
	}

	async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
		const r = await this.exec(["ls-remote", "--heads", remote, branch], { timeoutMs: 60_000 });
		return r.stdout.trim().length > 0;
	}

	async fetch(): Promise<void> {
		await this.exec(["fetch", "--quiet", "origin"], { timeoutMs: 120_000 });
	}

	async refExists(ref: string): Promise<boolean> {
		return (await this.exec(["rev-parse", "--verify", "--quiet", ref], { allowFail: true })).code === 0;
	}

	/** Merges `ref` into the current branch; returns the conflicted paths (empty when clean). */
	async merge(ref: string, message: string): Promise<string[]> {
		const r = await this.exec([...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", message, ref], {
			allowFail: true,
		});
		if (r.code === 0) return [];
		const conflicts = await this.conflictedPaths();
		if (conflicts.length === 0) throw new GitError(["merge", ref], r);
		return conflicts;
	}

	async abortMerge(): Promise<void> {
		await this.exec(["merge", "--abort"], { allowFail: true });
	}

	async mergeInProgress(): Promise<boolean> {
		return this.refExists("MERGE_HEAD");
	}

	/** Takes one side of a conflicted file: `ours` (local) or `theirs` (incoming). */
	async checkoutSide(path: string, side: "ours" | "theirs"): Promise<void> {
		await this.exec(["checkout", `--${side}`, "--", path]);
		await this.exec(["add", "--", path]);
	}

	/** Contents of `path` at a conflict stage: 2 = ours, 3 = theirs. */
	async showStage(path: string, stage: 2 | 3): Promise<string> {
		return (await this.exec(["show", `:${stage}:${path}`])).stdout;
	}

	async finishMerge(): Promise<void> {
		await this.exec([...IDENTITY, "commit", "--quiet", "--no-edit"]);
	}

	async push(refspecs: string[]): Promise<GitResult> {
		return this.exec(["push", "--quiet", "origin", ...refspecs], { allowFail: true, timeoutMs: 120_000 });
	}
}
