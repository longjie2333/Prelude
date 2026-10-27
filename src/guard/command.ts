/**
 * Best-effort shell command analysis for the gate (plan M1-5), adapted from pi-testmode
 * src/kernel/command.ts (commit f5d01c7). Not a security boundary (design §9): on Windows it is the
 * only layer; elsewhere the OS sandbox is.
 *
 * Changes from the old version: a bare `localhost` or IP without a port or scheme is not a network
 * target (it fired on `grep localhost config`); installs are keyed by package, not by command line.
 */
import { parseHost } from "./scope.ts";

export interface CommandAnalysis {
	/** Set when the command must never run in test mode. */
	dangerous?: string;
	/** Dependency installs, keyed by manager and package (`npm:autocannon`, `pip:requests`). */
	installs: string[];
	/** Hosts the command names, `host` or `host:port`. */
	hosts: string[];
	/** Files the command redirects output into (`> file`, `>> file`, `tee file`, `Out-File`). */
	writeTargets: string[];
	/** A security scanner or attack tool the command runs (M3-2). */
	scanner?: string;
	/** Installs a program on this host (M3-4: packaged programs go to a sandbox, VM or emulator). */
	hostInstall?: string;
}

/** Security scanners and attack tools: they need `security-check` in scope.json (M3-2). */
const SCANNERS =
	/(?<![\w./-])(nuclei|zap(?:\.sh|\.bat|-cli|-baseline\.py|-full-scan\.py|-api-scan\.py)?|owasp-zap|zaproxy|sqlmap|nikto|nmap|masscan|ffuf|gobuster|feroxbuster|dirb|dirsearch|wfuzz|hydra|medusa|wpscan|arachni|testssl(?:\.sh)?|sslyze|commix|xsstrike|dalfox)(?=\s|$|\.exe)/i;

/** Running an installer on this host. `adb install` is not one: it installs on a device. */
const HOST_INSTALL: Array<[RegExp, string]> = [
	[/\bmsiexec(\.exe)?\b/i, "msiexec"],
	[/\b(Add-AppxPackage|Add-AppPackage)\b/i, "Add-AppxPackage"],
	[
		/(^|[;&|]\s*|\bStart-Process\s+|\bstart\s+|&\s*)(["']?)[^\s"';&|]+\.(msi|msix|msixbundle|appx|appxbundle)\2(?=\s|$)/i,
		"a Windows package",
	],
	[
		/(^|[;&|]\s*|\bStart-Process\s+|\bstart\s+|&\s*)(["']?)[^\s"';&|]*(setup|install)[^\s"';&|\\/]*\.exe\2(?=\s|$)/i,
		"an installer .exe",
	],
	[/\.exe["']?\s+(?:\S+\s+)*(\/S|\/silent|\/verysilent|\/quiet|\/qn)(?=\s|$)/i, "a silent install"],
];

const DANGEROUS: Array<[RegExp, string]> = [
	[/\bsudo\b|\bdoas\b|\brunas\b/i, "privilege escalation"],
	[
		/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME|\*|\.\.?)(\s|$|\/\s|\/\*)/i,
		"recursive delete of a root, home, or parent directory",
	],
	[/\bRemove-Item\b[^|;]*-Recurse[^|;]*\s([a-z]:\\?|~|\\|\/)(\s|$)/i, "recursive delete of a drive or home"],
	[/\b(mkfs(\.\w+)?|fdisk|diskpart|format\s+[a-z]:)\b/i, "disk formatting"],
	[/\bdd\b[^|;]*\bof=\/dev\//i, "raw device write"],
	[/\b(shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b/i, "host power control"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
	[/\bchmod\s+(-R\s+)?777\s+\//i, "world-writable root"],
	[/\bgit\s+push\b/i, "git push leaves the test environment"],
	[/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, "destroys working tree changes"],
	[/\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/i, "pipes a download into a shell"],
	[
		/\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
		"pipes a download into PowerShell",
	],
	[/\breg\s+delete\b/i, "registry delete"],
	// Whole-filesystem scans hang for many minutes and are never needed for a test (old real-model runs).
	[
		/\b(find|du|ls|grep|rg|tree)\s+(-\S+\s+)*(?:(?!-)[^\s/~$]\S*\s+)?(["']?)(\/|[a-z]:(?:\\|\/)?|~|\$HOME|\/c|\/mnt\/[a-z])\3(?=\s|$)/i,
		"scans a whole filesystem or home directory",
	],
	[/\bGet-ChildItem\b[^|;]*-Recurse[^|;]*\s(["']?)([a-z]:\\?|~|\\)\1(\s|$)/i, "scans a whole drive or home directory"],
];

/** Manager, the command that installs, and how many leading words to skip before package names. */
const INSTALLS: Array<{ manager: string; re: RegExp; first?: boolean }> = [
	{ manager: "npm", re: /\bnpm\s+(?:i|install|add|ci)\b([^;&|\n]*)/i },
	{ manager: "pnpm", re: /\bpnpm\s+(?:i|install|add)\b([^;&|\n]*)/i },
	{ manager: "yarn", re: /\byarn\s+(?:add|install)\b([^;&|\n]*)/i },
	{ manager: "bun", re: /\bbun\s+(?:i|install|add)\b([^;&|\n]*)/i },
	{ manager: "npx", re: /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+([^;&|\n]*)/i, first: true },
	{ manager: "uvx", re: /\buvx\s+([^;&|\n]*)/i, first: true },
	{ manager: "pip", re: /\b(?:pip3?|uv\s+pip)\s+install\b([^;&|\n]*)/i },
	{ manager: "uv", re: /\buv\s+(?:add|tool\s+install)\b([^;&|\n]*)/i },
	{ manager: "pipx", re: /\bpipx\s+(?:install|run)\b([^;&|\n]*)/i, first: true },
	{ manager: "go", re: /\bgo\s+(?:install|get)\b([^;&|\n]*)/i },
	{ manager: "cargo", re: /\bcargo\s+install\b([^;&|\n]*)/i },
	{ manager: "gem", re: /\bgem\s+install\b([^;&|\n]*)/i },
	{ manager: "system", re: /\b(?:brew|winget|choco|scoop|apt|apt-get)\s+install\b([^;&|\n]*)/i },
	{ manager: "docker", re: /\bdocker\s+(?:pull|run)\b([^;&|\n]*)/i, first: true },
];

function packagesOf(rest: string, first: boolean): string[] {
	// `KEY=value` is an env assignment, `requests==2.0` a pinned package. A redirect (`2>&1`,
	// `> log`) ends the argument list: a real run read `2>` as a second package and blocked it.
	const words: string[] = [];
	for (const w of rest.trim().split(/\s+/)) {
		if (/^\d*[<>]/.test(w)) break;
		if (w && !w.startsWith("-") && !/^[A-Za-z_]\w*=(?!=)/.test(w)) words.push(w);
	}
	return first ? words.slice(0, 1) : words;
}

function extractInstalls(cmd: string): string[] {
	const out = new Set<string>();
	for (const { manager, re, first } of INSTALLS) {
		const m = cmd.match(re);
		if (!m) continue;
		const pkgs = packagesOf(m[1] ?? "", first === true);
		if (pkgs.length === 0) out.add(`${manager}:(project dependencies)`);
		for (const p of pkgs) out.add(`${manager}:${p.replace(/^["']|["']$/g, "")}`);
	}
	return [...out];
}

/**
 * Network targets named in free text: URLs with a scheme, and `localhost:port` / `ip:port`. A bare
 * host without a port is not a target; it is too often just a word in a grep or a config value.
 * Domains without a scheme are skipped too: `name.ts:42` looks the same.
 */
export function extractHosts(text: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()`\\]+/gi)) {
		if (/^(file|data|javascript|about|mailto):/i.test(m[0])) continue;
		const h = parseHost(m[0]);
		if (h) found.add(h.port ? `${h.host}:${h.port}` : h.host);
	}
	for (const m of text.matchAll(/(?<![\w.:/@-])(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?![\w.:-])/gi)) {
		found.add(`${m[1].toLowerCase()}:${m[2]}`);
	}
	return [...found];
}

/**
 * Shell text with quoted strings and comments blanked out, so a `>` inside `"accepted > 5"`,
 * `node -e "...=>..."`, or `# a -> b` is not taken for a redirect. A quoted redirect target
 * (`> "out file"`) stays visible: only quotes not directly after `>` are blanked.
 */
function unquoted(cmd: string): string {
	let out = "";
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === '"' || ch === "'") {
			const end = cmd.indexOf(ch, i + 1);
			const stop = end < 0 ? cmd.length : end + 1;
			out += />\s*$/.test(out) ? cmd.slice(i, stop) : " ".repeat(stop - i);
			i = stop;
		} else if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
			const end = cmd.indexOf("\n", i);
			const stop = end < 0 ? cmd.length : end;
			out += " ".repeat(stop - i);
			i = stop;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

function extractWriteTargets(raw: string): string[] {
	const cmd = unquoted(raw);
	const targets: string[] = [];
	// Not part of `2>&1`, `=>`, `->`, `>=`, or `-gt`-style arithmetic.
	for (const m of cmd.matchAll(/(?<![0-9&=\-<>])>>?(?![=&>])\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|"'<>()]+))/g))
		targets.push(m[1] ?? m[2] ?? m[3]);
	for (const m of raw.matchAll(/\btee\s+(?:-a\s+)?(["']?)([^\s;&|"']+)\1/g)) targets.push(m[2]);
	for (const m of raw.matchAll(
		/\b(Out-File|Set-Content|Add-Content)\b[^|;]*?(?:-(?:File)?Path\s+)?(["']?)([^\s;|"'-][^\s;|"']*)\2/gi,
	))
		targets.push(m[3]);
	return targets.filter(
		(t) => !/^\/dev\/(null|stdout|stderr)$/i.test(t) && t.toLowerCase() !== "nul" && t !== "$null",
	);
}

function segments(cmd: string): string[] {
	return cmd.split(/&&|\|\||;|\||\n/).filter((s) => s.trim());
}

/** Launchers whose next word is the program that actually runs. */
const LAUNCHER =
	/^(npx|pnpx|bunx|uvx|pipx\s+run|python3?(\s+-m)?|py(\s+-m)?|node|bash|sh|pwsh|powershell(\s+-\S+)*|&|docker|docker\s+run(\s+-{1,2}\S+)*)$/i;

/** The scanner a segment runs, judged by its program name, not by words in its arguments. */
function scannerOf(segment: string): string | undefined {
	const words = segment
		.trim()
		.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "")
		.split(/\s+/);
	for (let i = 0; i < words.length && i < 12; i++) {
		const program =
			words[i]
				.replace(/^["']|["']$/g, "")
				.split(/[\\/]/)
				.pop() ?? "";
		const m = program.match(SCANNERS);
		if (m && m.index === 0 && m[0].length >= program.replace(/\.exe$/i, "").length) return m[1].toLowerCase();
		// Keep looking only while the words so far are a launcher (`docker run --rm image`, `python -m`).
		if (!LAUNCHER.test(words.slice(0, i + 1).join(" ")) && !/^projectdiscovery\/|^owasp\/|^zaproxy\//i.test(program))
			return undefined;
	}
	return undefined;
}

export function analyzeCommand(cmd: string): CommandAnalysis {
	return {
		dangerous: DANGEROUS.find(([re]) => re.test(cmd))?.[1],
		installs: extractInstalls(cmd),
		hosts: extractHosts(cmd),
		writeTargets: extractWriteTargets(cmd),
		scanner: segments(cmd).map(scannerOf).find(Boolean),
		hostInstall: segments(cmd)
			.filter((seg) => !/^\s*adb\b/i.test(seg))
			.map((seg) => HOST_INSTALL.find(([re]) => re.test(seg.trim()))?.[1])
			.find(Boolean),
	};
}
