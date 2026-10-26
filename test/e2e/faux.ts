/**
 * Faux model wiring for e2e tests (plan M1-10), after pi-testmode test/e2e/faux.ts (commit
 * f5d01c7). One faux provider serves the main session and every review sub-session; each request
 * goes to the script of the actor that sent it, identified by its prompt sections.
 */
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { PROMPT_SECTION } from "../../src/mode.ts";
import { REVIEW_SECTION } from "../../src/verify.ts";

export interface Msg {
	role: string;
	content?: unknown;
	sections?: Record<string, string | null>;
	toolsAdded?: Array<{ name: string }>;
	toolsRemoved?: Array<{ name: string }>;
	toolName?: string;
	isError?: boolean;
}

export type Actor = "main" | "reviewer" | "plain";

export interface Ctx {
	actor: Actor;
	messages: Msg[];
	sections: Record<string, string>;
	lastToolResult(): { text: string; isError: boolean; toolName: string };
	firstUserText(): string;
}

export type Step = (ctx: Ctx) => AssistantMessage;

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
			.join("\n");
	return "";
}

export function sectionsOf(messages: Msg[]): Record<string, string> {
	const sections: Record<string, string> = {};
	for (const m of messages) {
		if (m.role !== "system" || !m.sections) continue;
		for (const [k, v] of Object.entries(m.sections)) {
			if (v === null) delete sections[k];
			else sections[k] = v;
		}
	}
	return sections;
}

/** Tools available at the end of the transcript (system messages add and remove them). */
export function toolsOf(messages: Msg[]): string[] {
	const tools = new Set<string>();
	for (const m of messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) tools.add(t.name);
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
	}
	return [...tools];
}

export const call =
	(name: string, args: Parameters<typeof fauxToolCall>[1]): Step =>
	() =>
		fauxAssistantMessage(fauxToolCall(name, args));
export const say =
	(text: string): Step =>
	() =>
		fauxAssistantMessage(fauxText(text));

export interface Router {
	runtime(): Promise<ModelRuntime>;
	model(): Model<string>;
	scripts: Record<Actor, Step[]>;
	seen: Array<{ actor: Actor; sections: Record<string, string>; firstUser: string; tools: string[] }>;
}

export function createRouter(tmpDir: string, scripts: Partial<Record<Actor, Step[]>>): Router {
	const faux = fauxProvider();
	const all: Record<Actor, Step[]> = { main: [], reviewer: [], plain: [], ...scripts };
	const seen: Router["seen"] = [];
	const route = (context: { messages: unknown[] }): AssistantMessage => {
		const messages = context.messages as Msg[];
		const sections = sectionsOf(messages);
		const actor: Actor = sections[REVIEW_SECTION] ? "reviewer" : sections[PROMPT_SECTION] ? "main" : "plain";
		const ctx: Ctx = {
			actor,
			messages,
			sections,
			lastToolResult() {
				const m = [...messages].reverse().find((x) => x.role === "toolResult");
				return { text: m ? textOf(m.content) : "", isError: m?.isError === true, toolName: m?.toolName ?? "" };
			},
			firstUserText() {
				return textOf(messages.find((x) => x.role === "user")?.content);
			},
		};
		seen.push({ actor, sections, firstUser: ctx.firstUserText(), tools: toolsOf(messages) });
		const step = all[actor].shift();
		return step ? step(ctx) : fauxAssistantMessage(fauxText(`[faux] no script left for ${actor}`));
	};
	faux.setResponses(Array.from({ length: 200 }, () => route as never));
	let runtime: Promise<ModelRuntime> | undefined;
	return {
		runtime: () =>
			(runtime ??= ModelRuntime.create({
				authPath: join(tmpDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			}).then((r) => {
				r.registerNativeProvider(faux.provider);
				return r;
			})),
		model: () => faux.getModel(),
		scripts: all,
		seen,
	};
}
