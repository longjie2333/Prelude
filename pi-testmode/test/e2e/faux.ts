/**
 * Faux model wiring for e2e tests (plan M1-13). One faux provider serves the main session and
 * every mission; each request is routed to the script of the actor that sent it, identified by
 * the prompt sections (`testmode` = main, `mission` = a mission with its role).
 */
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface ActorInfo {
	actor: string;
	role?: string;
	missionId?: string;
	runDir?: string;
}

export interface Ctx {
	info: ActorInfo;
	messages: Array<{ role: string; content?: unknown; sections?: Record<string, string | null>; toolCallId?: string; toolName?: string }>;
	/** Text of the most recent tool result. */
	lastToolResult(): string;
	/** All tool results so far, in order. */
	toolResults(): Array<{ toolName: string; toolCallId: string; text: string; isError?: boolean }>;
	/** Text of the latest non-tool user/custom message. */
	lastUserText(): string;
}

export type Step = (ctx: Ctx) => AssistantMessage;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
	return "";
}

export function identify(messages: Ctx["messages"]): ActorInfo {
	const sections: Record<string, string> = {};
	for (const m of messages) {
		if (m.role !== "system" || !m.sections) continue;
		for (const [k, v] of Object.entries(m.sections)) {
			if (v === null) delete sections[k];
			else sections[k] = v;
		}
	}
	if (sections.mission) {
		const get = (key: string) => sections.mission.match(new RegExp(`^${key}: (.+?)(?:\\s+#.*)?$`, "m"))?.[1]?.trim();
		const role = get("role");
		return { actor: role ?? "mission", role, missionId: get("mission_id"), runDir: get("run_dir") };
	}
	return { actor: sections.testmode ? "main" : "plain" };
}

export function makeCtx(messages: Ctx["messages"]): Ctx {
	const info = identify(messages);
	return {
		info,
		messages,
		lastToolResult() {
			const m = [...messages].reverse().find((x) => x.role === "toolResult");
			return m ? textOf(m.content) : "";
		},
		toolResults() {
			return messages
				.filter((x) => x.role === "toolResult")
				.map((x) => ({ toolName: x.toolName ?? "", toolCallId: x.toolCallId ?? "", text: textOf(x.content), isError: (x as { isError?: boolean }).isError }));
		},
		lastUserText() {
			const m = [...messages].reverse().find((x) => x.role === "user" || x.role === "custom");
			return m ? textOf(m.content) : "";
		},
	};
}

export interface Router {
	runtime: () => Promise<ModelRuntime>;
	model: () => Model<string>;
	/** Scripts by actor (`main`, `executor`, `verifier`, `scout`). */
	scripts: Record<string, Step[]>;
	/** Requests seen, by actor. */
	seen: Array<{ info: ActorInfo; lastUserText: string }>;
	remaining(actor: string): number;
}

export function createRouter(tmpDir: string, scripts: Record<string, Step[]>): Router {
	const faux = fauxProvider();
	const seen: Router["seen"] = [];
	const route = (context: { messages: unknown[] }): AssistantMessage => {
		const ctx = makeCtx(context.messages as Ctx["messages"]);
		seen.push({ info: ctx.info, lastUserText: ctx.lastUserText() });
		const queue = scripts[ctx.info.actor];
		const step = queue?.shift();
		if (!step) return fauxAssistantMessage(fauxText(`[faux] no script left for ${ctx.info.actor}`));
		return step(ctx);
	};
	faux.setResponses(Array.from({ length: 500 }, () => route as never));
	let runtime: Promise<ModelRuntime> | undefined;
	return {
		runtime: () =>
			(runtime ??= ModelRuntime.create({ authPath: join(tmpDir, "auth.json"), modelsPath: null, refreshOnCreate: false }).then((r) => {
				r.registerNativeProvider(faux.provider);
				return r;
			})),
		model: () => faux.getModel(),
		scripts,
		seen,
		remaining: (actor) => scripts[actor]?.length ?? 0,
	};
}

export function idFrom(text: string, prefix: string): string {
	const m = text.match(new RegExp(`\\b(${prefix}-\\d{8}-[0-9a-f]{6})\\b`));
	if (!m) throw new Error(`no ${prefix} id in: ${text.slice(0, 300)}`);
	return m[1];
}
