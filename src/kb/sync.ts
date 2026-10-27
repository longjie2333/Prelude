/**
 * Knowledge-base lifecycle (plan M2-1, M2-3, design §6.2): setup, the entry merge with conflict
 * questions, writes (workspace check → change → render → commit, under a lock), and the end push.
 *
 * The end step pushes `HEAD:<main>` from this machine's own branch instead of checking out main:
 * entry already merged origin/main in, so the push is a fast-forward unless main moved meanwhile;
 * then origin/main is merged into the own branch first, and a conflict there is left pending (D-6).
 */
import {
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "../audit.ts";
import { globalPaths, SKILLS_DIR } from "../paths.ts";
import { errorMessage, nowIso, readJson, writeJson } from "../util.ts";
import { type KbConfig, newBranchName, writeConfig } from "./config.ts";
import { Git } from "./git.ts";
import { newLessonId } from "./lessons.ts";
import { renderAll } from "./render.ts";

export type KbState = "local" | "synced" | "pending" | "conflict" | "offline";

export interface KbUi {
	select(title: string, options: string[]): Promise<string | undefined>;
}

const LOCK = ".lock";
const STALE_LOCK_MS = 5 * 60_000;
export const KEEP_LOCAL = "Keep local";
export const TAKE_REMOTE = "Take remote";
export const KEEP_BOTH = "Keep both";
export const ABORT = "Abort merge";

interface Pending {
	since: string;
	reason: string;
}

export class Kb {
	readonly config: KbConfig;
	readonly git: Git;
	readonly home: string | undefined;
	state: KbState;
	private chain: Promise<unknown> = Promise.resolve();
	private audit: (e: AuditEvent) => void;

	constructor(config: KbConfig, audit: (e: AuditEvent) => void, home?: string) {
		this.config = config;
		this.git = new Git(config.dir);
		this.home = home;
		this.audit = audit;
		this.state = config.remote ? (this.pending() ? "conflict" : "pending") : "local";
	}

	get dir(): string {
		return this.config.dir;
	}

	private get pendingFile(): string {
		return join(globalPaths(this.home).dir, "kb-pending.json");
	}

	pending(): Pending | undefined {
		return readJson<Pending>(this.pendingFile);
	}

	private setPending(reason: string | undefined): void {
		if (reason) writeJson(this.pendingFile, { since: nowIso(), reason } satisfies Pending);
		else if (existsSync(this.pendingFile)) unlinkSync(this.pendingFile);
	}

	/** In-process serialization plus a lock file against other pi processes (design §6.2). */
	async locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			const lock = join(this.dir, LOCK);
			for (let i = 0; ; i++) {
				try {
					closeSync(openSync(lock, "wx"));
					break;
				} catch {
					if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
					else if (i > 50) throw new Error(`knowledge base is locked by another process (${lock})`);
					else await new Promise((r) => setTimeout(r, 100));
				}
			}
			try {
				return await fn();
			} finally {
				try {
					unlinkSync(lock);
				} catch {
					// already gone
				}
			}
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** M2-2: changes no tool made (shell edits that slipped past the gate) are rolled back and audited. */
	async checkWorkspace(): Promise<string[]> {
		const dirty = (await this.git.dirtyPaths()).filter((p) => p !== LOCK);
		if (dirty.length === 0) return [];
		await this.git.restoreClean();
		this.audit({
			event: "kb_restore",
			decision: "block",
			reason: "uncommitted changes not made by kb tools",
			detail: { paths: dirty },
		});
		return dirty;
	}

	/** One knowledge write: clean check, change, render, commit — all under the lock. */
	async write(message: string, change: () => void): Promise<void> {
		await this.locked(async () => {
			if (await this.git.mergeInProgress())
				throw new Error("a knowledge-base merge is unfinished; run /prelude-sync");
			await this.checkWorkspace();
			change();
			renderAll(this.dir);
			await this.git.commitAll(message);
			if (this.state === "synced") this.state = "pending";
		});
	}

	/** Entry (design §6.2): fetch, merge origin/main into the own branch, ask about conflicts. */
	async enter(ui: KbUi | undefined): Promise<KbState> {
		return this.locked(async () => {
			await this.checkWorkspace();
			if (!this.config.remote) return (this.state = "local");
			try {
				await this.git.fetch();
			} catch (err) {
				this.audit({ event: "kb_sync", decision: "offline", reason: errorMessage(err) });
				return (this.state = "offline");
			}
			const main = `origin/${this.config.mainBranch}`;
			if (!(await this.git.refExists(main))) return (this.state = "pending");
			const conflicts = await this.git.merge(main, `Merge ${main} into ${this.config.branch}`);
			if (conflicts.length && !(await this.resolve(conflicts, ui))) {
				await this.git.abortMerge();
				this.setPending(`merge of ${main} has conflicts: ${conflicts.join(", ")}`);
				this.audit({ event: "kb_sync", decision: "conflict", detail: { conflicts } });
				return (this.state = "conflict");
			}
			this.setPending(undefined);
			renderAll(this.dir);
			await this.git.commitAll("Regenerate SKILL.md after merge");
			this.audit({ event: "kb_sync", decision: "merged", detail: { conflicts } });
			return (this.state = "pending");
		});
	}

	/** End of a test (design §6.2): bring main in if it moved, push main and the own branch. Never asks. */
	async finish(): Promise<KbState> {
		return this.locked(async () => {
			if (!this.config.remote) return (this.state = "local");
			try {
				await this.git.fetch();
			} catch {
				return (this.state = "offline");
			}
			const main = `origin/${this.config.mainBranch}`;
			if (await this.git.refExists(main)) {
				const conflicts = await this.git.merge(main, `Merge ${main} into ${this.config.branch}`);
				if (conflicts.length) {
					await this.git.abortMerge();
					await this.git.push([`HEAD:refs/heads/${this.config.branch}`]);
					this.setPending(`merge of ${main} has conflicts: ${conflicts.join(", ")}`);
					this.audit({ event: "kb_sync", decision: "conflict", detail: { conflicts } });
					return (this.state = "conflict");
				}
				renderAll(this.dir);
				await this.git.commitAll("Regenerate SKILL.md after merge");
			}
			const r = await this.git.push([
				`HEAD:refs/heads/${this.config.branch}`,
				`HEAD:refs/heads/${this.config.mainBranch}`,
			]);
			if (r.code !== 0) {
				this.audit({ event: "kb_sync", decision: "offline", reason: r.stderr.trim().slice(0, 300) });
				return (this.state = "offline");
			}
			this.setPending(undefined);
			this.audit({ event: "kb_sync", decision: "pushed" });
			return (this.state = "synced");
		});
	}

	/** Per-file conflict questions; false = abort. SKILL.md is generated, so it never needs one. */
	private async resolve(conflicts: string[], ui: KbUi | undefined): Promise<boolean> {
		const generated = conflicts.filter((c) => c.endsWith("/SKILL.md") && !c.startsWith("skills/test-pilot/"));
		const asked = conflicts.filter((c) => !generated.includes(c));
		if (asked.length && !ui) return false;
		for (const path of asked) {
			const isLesson = /^skills\/[^/]+\/lessons\/[^/]+\.json$/.test(path);
			const options = isLesson ? [KEEP_LOCAL, TAKE_REMOTE, KEEP_BOTH, ABORT] : [KEEP_LOCAL, TAKE_REMOTE, ABORT];
			const choice = await ui?.select(`Knowledge-base conflict in ${path}`, options);
			if (choice === KEEP_LOCAL) await this.git.checkoutSide(path, "ours");
			else if (choice === TAKE_REMOTE) await this.git.checkoutSide(path, "theirs");
			else if (choice === KEEP_BOTH && isLesson) await this.keepBoth(path);
			else return false;
		}
		for (const path of generated) await this.git.checkoutSide(path, "ours");
		renderAll(this.dir);
		await this.git.exec(["add", "-A"]);
		await this.git.finishMerge();
		return true;
	}

	/** Keeps the local lesson and saves the remote one under a new id. */
	private async keepBoth(path: string): Promise<void> {
		const theirs = JSON.parse(await this.git.showStage(path, 3)) as { id: string };
		await this.git.checkoutSide(path, "ours");
		const category = path.split("/")[1];
		const id = newLessonId(this.dir, category);
		const copy = { ...theirs, id };
		writeFileSync(join(this.dir, "skills", category, "lessons", `${id}.json`), `${JSON.stringify(copy, null, 2)}\n`);
	}
}

// ---------------------------------------------------------------- setup (M2-1)

export interface SetupOptions {
	home?: string;
	remote?: string;
	mainBranch?: string;
	/** Reuse a branch name from an existing config instead of generating one. */
	branch?: string;
}

const README = `# Prelude 知识库

由 Prelude 扩展管理。只通过 \`kb_*\` 工具写入，由代码提交；不要手改。

- \`skills/test-pilot/\`：测试方法论（随扩展发布，人工维护）。
- \`skills/<类别>/\`：类别经验（\`lessons/*.json\`，一条一个文件）、工具（\`scripts/<tool>/\`）和生成的 \`SKILL.md\`。
`;

/** Creates config, clones or initializes the knowledge base, seeds it, and pushes the first commit. */
export async function setupKb(opts: SetupOptions, audit: (e: AuditEvent) => void): Promise<Kb> {
	const g = globalPaths(opts.home);
	const mainBranch = opts.mainBranch ?? "main";
	mkdirSync(g.dir, { recursive: true });
	const probe = new Git(g.dir);
	let branch = opts.branch ?? newBranchName();
	if (opts.remote && !opts.branch) {
		for (let i = 0; i < 5 && (await probe.remoteBranchExists(opts.remote, branch)); i++) branch = newBranchName();
	}
	const config: KbConfig = { dir: g.kbDir, ...(opts.remote ? { remote: opts.remote } : {}), mainBranch, branch };
	const git = new Git(g.kbDir);
	if (!existsSync(join(g.kbDir, ".git"))) {
		if (opts.remote) await Git.clone(opts.remote, g.kbDir);
		else {
			mkdirSync(g.kbDir, { recursive: true });
			await git.init(branch);
		}
	}
	if (opts.remote) {
		const hasMain = await git.refExists(`origin/${mainBranch}`);
		await git.exec(["checkout", "--quiet", "-B", branch, ...(hasMain ? [`origin/${mainBranch}`] : [])]);
	}
	if (!existsSync(join(g.kbDir, "skills", "test-pilot", "SKILL.md")))
		cpSync(join(SKILLS_DIR, "test-pilot"), join(g.kbDir, "skills", "test-pilot"), { recursive: true });
	if (!existsSync(join(g.kbDir, "README.md"))) writeFileSync(join(g.kbDir, "README.md"), README);
	const ignore = join(g.kbDir, ".gitignore");
	if (!existsSync(ignore) || !readFileSync(ignore, "utf8").includes(LOCK)) writeFileSync(ignore, `${LOCK}\n`);
	await git.commitAll("Initialize Prelude knowledge base");
	writeConfig({ kb: config }, opts.home);
	const kb = new Kb(config, audit, opts.home);
	if (opts.remote) await kb.finish();
	return kb;
}
