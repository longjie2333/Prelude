/**
 * Test mode (plan M1-3, M2-3, M2-7). Adapted from @earendil-works/pi-coding-agent@1.4.0
 * examples/extensions/plan-mode/index.ts: `/test` toggles it, `appendEntry` restores it, a prompt
 * section explains it, the status line shows it. Unlike plan mode it does not narrow the tools
 * (plan §2): it only adds Prelude's own. Entering syncs the knowledge base in (asking about
 * conflicts); once the report is registered, settling pushes it out without asking (D-6).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Prelude } from "./context.ts";
import { extractHosts } from "./guard/command.ts";
import { canonicalPath, isInside } from "./guard/paths.ts";
import { isHostAllowed, loadScope } from "./guard/scope.ts";
import { runGlobalInit, runInit } from "./init.ts";
import { listCategories, listLessons, skillsDir } from "./kb/lessons.ts";
import { SKILLS_DIR } from "./paths.ts";
import { updateDisplay } from "./progress.ts";
import { Run } from "./run.ts";
import { errorMessage, newRunId } from "./util.ts";

export const STATE_ENTRY = "prelude-state";
export const PROMPT_SECTION = "prelude";
/** The methodology shipped with the extension; once a knowledge base exists, its copy is used (M2-7). */
export const TEST_PILOT = join(SKILLS_DIR, "test-pilot", "SKILL.md");
export const KB_TOOLS = ["kb_category_add", "kb_lesson_add", "kb_lesson_revise", "kb_tool_add"];
/** Tools Prelude adds while a test runs; everything the user had stays active. */
export const MODE_TOOLS = ["questionnaire", "test_progress", "finding_record", "verify_findings", "report_finalize"];

interface PersistedState {
	enabled: boolean;
	runId?: string;
}

export function testPilotPath(prelude: Prelude): string {
	const kb = prelude.kb();
	const inKb = kb && join(skillsDir(kb.dir), "test-pilot", "SKILL.md");
	return inKb && existsSync(inKb) ? inKb : TEST_PILOT;
}

/** Skill paths Prelude mounts: the knowledge base's skills, or the shipped methodology. */
export function skillPaths(prelude: Prelude): string[] {
	const kb = prelude.kb();
	return kb && existsSync(skillsDir(kb.dir)) ? [skillsDir(kb.dir)] : [TEST_PILOT];
}

function kbLines(prelude: Prelude): string[] {
	const kb = prelude.kb();
	if (!kb) return [];
	const cats = listCategories(kb.dir).map((c) => {
		const lessons = listLessons(kb.dir, c.name).filter((l) => l.status !== "retired").length;
		return `${c.name}（${c.dimension}，${lessons} 条经验）`;
	});
	const slash = (p: string) => p.replace(/\\/g, "/");
	const lines = [
		`- 知识库：${slash(skillsDir(kb.dir))}/，类别：${cats.join("；") || "暂无"}。接收阶段读相关类别的 SKILL.md；复盘时只能用 kb_* 工具写入（直接写会被拦截）。`,
	];
	if (kb.state === "conflict")
		lines.push("- 知识库有未解决的合并冲突，写入仍在本机分支上进行；用户可以运行 /prelude-sync 处理。");
	return lines;
}

export function promptSection(prelude: Prelude): string {
	const run = prelude.run();
	const state = run.state();
	const scope = loadScope(run.project.scopeFile);
	const targets = scope.scope?.targets.map((t) => `${t.host}（${t.allowed.join(", ")}）`).join("；");
	const rel = (p: string) => p.slice(run.project.root.length + 1).replace(/\\/g, "/");
	return [
		`Prelude 测试模式已开启。运行 ${run.id}，目标：${state.goal || "（见用户下一条消息）"}`,
		"",
		`- 先读 test-pilot Skill（${testPilotPath(prelude).replace(/\\/g, "/")}），按它的流程做完整个测试。`,
		"- 接收阶段用 questionnaire 一次性问完所有缺少的信息；之后不再询问用户，自己判断并在报告里写明假设。",
		"- 阶段切换调用 test_progress；每个发现确认后立刻用 finding_record 记录（缺陷必须带复现脚本：退出码非 0 = 复现），不要攒到最后。",
		"- 会改被测系统状态的探测（下单、写入、重置）一次只跑一个，不要并行。",
		`- 测完调用 verify_findings，把报告写到 ${rel(run.project.reportsDir)}/，复盘，最后调用 report_finalize。`,
		`- 系统笔记写在 ${rel(run.project.notesDir)}/，脚本和草稿放在 ${rel(run.project.workDir)}/。`,
		...kbLines(prelude),
		`- 授权范围（.prelude/scope.json，只能由人维护）：${targets || (scope.error ? `无效：${scope.error}` : "尚未配置")}。访问范围外的主机、首次安装依赖需要用户批准；被拒绝就不要重试，记入"没测什么"。`,
		"- 隔离级别：仅工具层策略（Prelude 的闸门），不是安全边界。",
	].join("\n");
}

export function registerMode(pi: ExtensionAPI, prelude: Prelude): void {
	const modeTools = () => (prelude.kb() ? [...MODE_TOOLS, ...KB_TOOLS] : MODE_TOOLS);
	const setTools = (on: boolean) => {
		const all = [...MODE_TOOLS, ...KB_TOOLS];
		const active = pi.getActiveTools().filter((t) => !all.includes(t));
		pi.setActiveTools(on ? [...active, ...modeTools()] : active);
	};

	const persist = () =>
		pi.appendEntry<PersistedState>(STATE_ENTRY, { enabled: prelude.enabled, runId: prelude.runId });

	const enable = (runId: string) => {
		prelude.enabled = true;
		prelude.runId = runId;
		setTools(true);
		persist();
		updateDisplay(prelude);
	};

	const disable = () => {
		prelude.enabled = false;
		prelude.runId = undefined;
		setTools(false);
		persist();
		updateDisplay(prelude);
	};

	/** Hosts named in the goal are settled now, while the user is still here (design §4 step 1). */
	const authorizeGoalHosts = async (goal: string) => {
		const scope = loadScope(prelude.project.scopeFile).scope;
		const asks = extractHosts(goal)
			.filter((h) => !isHostAllowed(scope, h))
			.map((h) => ({ kind: "host" as const, subject: h, reason: `${h} is not in .prelude/scope.json` }));
		if (asks.length && prelude.ctx?.hasUI) await prelude.resolve(asks, "test", { goal });
	};

	/** Entry sync (M2-3): a failure here never blocks the test; it runs on the local knowledge base. */
	const enterKb = async (ctx: ExtensionContext) => {
		try {
			if (!prelude.kb()) await runGlobalInit(ctx, prelude);
			const kb = prelude.kb();
			if (!kb) return;
			const state = await kb.enter(ctx.hasUI ? { select: (t, o) => ctx.ui.select(t, o) } : undefined);
			if (state === "conflict")
				ctx.ui.notify("Knowledge base: merge conflict left for later (/prelude-sync)", "warning");
			if (state === "offline") ctx.ui.notify("Knowledge base: remote unreachable, using the local copy", "warning");
		} catch (err) {
			ctx.ui.notify(`Knowledge base unavailable: ${errorMessage(err)}`, "warning");
		}
	};

	const start = async (goal: string, ctx: ExtensionContext) => {
		prelude.ctx = ctx;
		if (!prelude.isInitialized()) await runInit(ctx, prelude.project);
		await enterKb(ctx);
		if (goal) await authorizeGoalHosts(goal);
		const run = Run.create(prelude.project, newRunId(), goal);
		enable(run.id);
		prelude.audit({ event: "test_start", detail: { goal } });
		ctx.ui.notify(`Prelude test ${run.id} started`, "info");
		if (!goal) return;
		// print/json modes dispose the session as soon as the command returns, and sendUserMessage
		// does not wait for the run it starts: without waiting, `pi -p "/test …"` would end the test
		// before it began. The TUI keeps running, so there the command returns at once.
		const unattended = ctx.mode === "print" || ctx.mode === "json";
		const settled = unattended ? nextSettle() : undefined;
		pi.sendUserMessage(goal, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		await settled;
	};

	let settleWaiters: Array<() => void> = [];
	const nextSettle = () => new Promise<void>((resolve) => settleWaiters.push(resolve));

	pi.registerCommand("test", {
		description: "Start a Prelude test: /test <goal>. Without a goal, toggles test mode",
		handler: async (args, ctx) => {
			prelude.ctx = ctx;
			const goal = args.trim();
			if (prelude.enabled && !goal) {
				prelude.audit({ event: "test_stop" });
				disable();
				ctx.ui.notify("Prelude test mode off", "info");
				return;
			}
			await start(goal, ctx);
		},
	});

	pi.registerCommand("prelude-init", {
		description: "Set up .prelude/ in this project, the AGENTS.md section, and the shared knowledge base",
		handler: async (_args, ctx) => {
			prelude.ctx = ctx;
			await runInit(ctx, prelude.project);
			if (!prelude.kb()) await runGlobalInit(ctx, prelude);
		},
	});

	pi.registerCommand("prelude-sync", {
		description: "Sync the knowledge base now: merge the remote main in (asking about conflicts), then push",
		handler: async (_args, ctx) => {
			prelude.ctx = ctx;
			const kb = prelude.kb();
			if (!kb) return ctx.ui.notify("No knowledge base yet; run /prelude-init", "warning");
			const entered = await kb.enter(ctx.hasUI ? { select: (t, o) => ctx.ui.select(t, o) } : undefined);
			const state = entered === "conflict" || entered === "offline" ? entered : await kb.finish();
			updateDisplay(prelude);
			ctx.ui.notify(`Knowledge base: ${state}`, state === "synced" || state === "local" ? "info" : "warning");
		},
	});

	pi.on("resources_discover", () => ({ skillPaths: skillPaths(prelude) }));

	pi.on("session_start", async (_event, ctx) => {
		prelude.ctx = ctx;
		const entry = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY)
			.pop() as { data?: PersistedState } | undefined;
		const saved = entry?.data;
		const runId = saved?.runId;
		if (saved?.enabled && runId && existsSync(new Run(prelude.project, runId).paths.stateFile)) {
			prelude.enabled = true;
			prelude.runId = runId;
			setTools(true);
		}
		updateDisplay(prelude);
	});

	pi.on("before_agent_start", (event, ctx) => {
		prelude.ctx = ctx;
		const opts = event.systemPromptOptions;
		if (!prelude.enabled) {
			delete opts.sections[PROMPT_SECTION];
			// Methodology and category lessons only make sense with the test tools active.
			const mounted = skillPaths(prelude).map((p) =>
				canonicalPath(p.endsWith("SKILL.md") ? join(p, "..") : p, ctx.cwd),
			);
			opts.skills = opts.skills.filter((s) => !mounted.some((m) => isInside(canonicalPath(s.filePath, ctx.cwd), m)));
			return;
		}
		const run = prelude.run();
		if (!run.state().goal && event.messageType === "user" && event.prompt.trim()) {
			run.updateState((s) => {
				s.goal = event.prompt.trim().slice(0, 2000);
			});
		}
		opts.sections[PROMPT_SECTION] = promptSection(prelude);
	});

	pi.on("agent_settled", async () => {
		// End sync (M2-3): once the report is registered, push without asking; conflicts stay pending.
		try {
			const kb = prelude.kb();
			const state = prelude.enabled && prelude.runId ? prelude.run().state() : undefined;
			if (kb?.config.remote && state?.report && state.kbSyncedWrites !== (state.kbWrites ?? 0)) {
				await kb.finish();
				prelude.run().updateState((s) => {
					s.kbSyncedWrites = s.kbWrites ?? 0;
				});
			}
		} catch (err) {
			prelude.ctx?.ui.notify(`Knowledge base sync failed: ${errorMessage(err)}`, "warning");
		}
		updateDisplay(prelude);
		const waiters = settleWaiters;
		settleWaiters = [];
		for (const w of waiters) w();
	});
}
