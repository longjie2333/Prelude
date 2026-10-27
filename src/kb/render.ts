/**
 * Generates each category's `SKILL.md` from its lessons and tools (plan M2-4, D-4). The model
 * reads this, never the JSON; on a merge conflict the file is simply regenerated.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Category, categoryDir, type Lesson, listCategories, listLessons } from "./lessons.ts";

export interface ToolEntry {
	name: string;
	summary: string;
	deprecated: boolean;
}

export function listTools(kbDir: string, category: string): ToolEntry[] {
	const dir = join(categoryDir(kbDir, category), "scripts");
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const readme = join(dir, d.name, "README.md");
			const text = existsSync(readme) ? readFileSync(readme, "utf8") : "";
			const summary =
				text
					.split(/\r?\n/)
					.map((l) => l.trim())
					.find((l) => l && !l.startsWith("#")) ?? "";
			return { name: d.name, summary, deprecated: /^\s*(deprecated|已废弃)/im.test(text) };
		});
}

function lessonBlock(l: Lesson): string {
	const projects = new Set(l.evidence.map((e) => e.project)).size;
	const lines = [`### ${l.title}`, "", `- 适用：${l.applies_when}`];
	if (l.not_applies_when.length) lines.push(`- 不适用：${l.not_applies_when.join("；")}`);
	lines.push(`- 做法：${l.guidance}`, `- 证据：${l.evidence.length} 条，来自 ${projects} 个项目（${l.id}）`);
	return lines.join("\n");
}

export function renderSkill(category: Category, lessons: Lesson[], tools: ToolEntry[]): string {
	const confirmed = lessons.filter((l) => l.status === "confirmed");
	const candidates = lessons.filter((l) => l.status === "candidate");
	const live = tools.filter((t) => !t.deprecated);
	const description = `Prelude ${category.dimension} 类别经验：${category.description}`.slice(0, 1024);
	const parts = [
		"---",
		`name: ${category.name}`,
		`description: ${JSON.stringify(description)}`,
		"---",
		"",
		`<!-- 由 Prelude 根据 lessons/*.json 生成，不要手改；修改经验用 kb_lesson_revise。 -->`,
		"",
		`# ${category.name}`,
		"",
		category.description,
		"",
		"## 经验",
		"",
		confirmed.length ? confirmed.map(lessonBlock).join("\n\n") : "暂无已确认的经验。",
		"",
		"## 待验证",
		"",
		"只在一个项目中被证实过。用之前先确认适用条件；本次再次证实就用 kb_lesson_revise 追加证据，遇到反例就追加不适用条件。",
		"",
		candidates.length ? candidates.map(lessonBlock).join("\n\n") : "无。",
		"",
		"## 工具",
		"",
		live.length ? live.map((t) => `- \`scripts/${t.name}/\`：${t.summary || "见 README.md"}`).join("\n") : "无。",
		"",
	];
	return parts.join("\n");
}

export function renderCategory(kbDir: string, category: Category): string {
	const path = join(categoryDir(kbDir, category.name), "SKILL.md");
	writeFileSync(path, renderSkill(category, listLessons(kbDir, category.name), listTools(kbDir, category.name)));
	return path;
}

export function renderAll(kbDir: string): string[] {
	return listCategories(kbDir).map((c) => renderCategory(kbDir, c));
}
