/**
 * Static review of a Skill in quarantine (agent-core §9.4 "审查", §11.2; plan M2-6). Never
 * executes anything. Checks Agent Skills frontmatter, scans every text file for invisible
 * characters and instruction-like phrasing, and derives a declarative permission manifest.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SkillReport {
	ok: boolean;
	name?: string;
	description?: string;
	errors: string[];
	warnings: string[];
	manifest: { hosts: string[]; writes: string[]; exec: boolean; files: number; bytes: number };
}

const MAX_FILES = 50;
const MAX_BYTES = 512 * 1024;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Zero-width, bidi controls, BOM inside text, tag characters.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x200b, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0xfeff, 0xfeff],
	[0xe0000, 0xe007f],
];

function countInvisible(text: string): number {
	let n = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) as number;
		if (INVISIBLE_RANGES.some(([a, b]) => c >= a && c <= b)) n++;
	}
	return n;
}
const INJECTION = [
	/ignore (all |any )?(previous|prior|above) (instructions|messages)/i,
	/disregard (the |your )?(system|previous) (prompt|instructions)/i,
	/you are now\b/i,
	/<\/?(system|assistant)>/i,
	/do not (tell|inform) the user/i,
	/(exfiltrate|send) (the )?(secrets?|credentials?|tokens?|api keys?)/i,
	/忽略(之前|以上|前面)的?(所有)?(指令|提示)/,
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

function parseFrontmatter(text: string): Record<string, string> | undefined {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return undefined;
	const out: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
		if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return out;
}

export function validateSkill(dir: string): SkillReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const manifest = { hosts: [] as string[], writes: [] as string[], exec: false, files: 0, bytes: 0 };
	const skillFile = join(dir, "SKILL.md");
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		return { ok: false, errors: [`${dir} is not a directory`], warnings, manifest };
	if (!existsSync(skillFile)) return { ok: false, errors: ["SKILL.md is missing"], warnings, manifest };

	const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
	if (!fm) errors.push("SKILL.md has no frontmatter");
	const name = fm?.name;
	const description = fm?.description;
	if (!name) errors.push("frontmatter name is missing");
	else if (!NAME.test(name) || name.length > 64)
		errors.push(`name "${name}" must be lowercase letters, digits, and single hyphens (≤64 chars)`);
	if (!description) errors.push("frontmatter description is missing");
	else if (description.length > 1024) errors.push("description exceeds 1024 characters");
	if (fm?.["allowed-tools"])
		warnings.push("allowed-tools is ignored: tool authorization comes from the mission, not the skill (§11.2)");

	const hosts = new Set<string>();
	const writes = new Set<string>();
	for (const file of walk(dir)) {
		const rel = relative(dir, file).replaceAll("\\", "/");
		const size = statSync(file).size;
		manifest.files++;
		manifest.bytes += size;
		const buf = readFileSync(file);
		if (buf.includes(0)) {
			warnings.push(`${rel} is binary; not scanned`);
			continue;
		}
		const text = buf.toString("utf8");
		const invisible = countInvisible(text);
		if (invisible) errors.push(`${rel} contains ${invisible} invisible/bidi control character(s); remove them`);
		for (const re of INJECTION)
			if (re.test(text))
				errors.push(`${rel} contains instruction-like text aimed at the agent (${re.source.slice(0, 40)}…)`);
		for (const m of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)/gi)) hosts.add(m[1].toLowerCase());
		for (const m of text.matchAll(
			/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\(\s*["'`]([^"'`]+)/g,
		))
			writes.add(m[1]);
		if (/\b(child_process|execSync|spawnSync|execFile|spawn\(|exec\(|subprocess|os\.system)\b/.test(text))
			manifest.exec = true;
	}
	if (manifest.files > MAX_FILES) errors.push(`too many files (${manifest.files} > ${MAX_FILES})`);
	if (manifest.bytes > MAX_BYTES) errors.push(`too large (${manifest.bytes} bytes > ${MAX_BYTES})`);
	manifest.hosts = [...hosts].sort();
	manifest.writes = [...writes].sort();
	if (manifest.exec) warnings.push("spawns processes; runs only through the gated bash/test_run tools");
	return { ok: errors.length === 0, name, description, errors, warnings, manifest };
}
