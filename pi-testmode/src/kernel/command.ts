/**
 * Best-effort shell command analysis for the policy gate. This is NOT a security boundary
 * (plan §12): network and filesystem boundaries belong to the sandbox or container.
 */
import { parseHost } from "./scope.ts";

export interface CommandAnalysis {
	/** Set when the command must never run. */
	dangerous?: string;
	/** Dependency installs, normalized (`npm install autocannon`). */
	installs: string[];
	/** Hosts the command names, `host` or `host:port`. */
	hosts: string[];
	/** HTTP calls that change state (non-GET method, request body, upload). */
	mutatingHttp: boolean;
	/** Every segment is a known read-only command and nothing is redirected to a file. */
	readOnly: boolean;
	/** Files the command redirects output into (`> file`, `>> file`, `tee file`). */
	writeTargets: string[];
}

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
	[/\bgit\s+push\b/i, "git push leaves the sandbox"],
	[/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, "destroys working tree changes"],
	[/\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/i, "pipes a download into a shell"],
	[
		/\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
		"pipes a download into PowerShell",
	],
	[/\breg\s+delete\b/i, "registry delete"],
	// Whole-filesystem scans: never needed for a mission and they hang for many minutes (real-model smoke runs).
	[
		/\b(find|du|ls|grep|rg|tree)\s+(-\S+\s+)*(?:(?!-)[^\s/~$]\S*\s+)?(["']?)(\/|[a-z]:(?:\\|\/)?|~|\$HOME|\/c|\/mnt\/[a-z])\3(?=\s|$)/i,
		"scans a whole filesystem or home directory",
	],
	[/\bGet-ChildItem\b[^|;]*-Recurse[^|;]*\s(["']?)([a-z]:\\?|~|\\)\1(\s|$)/i, "scans a whole drive or home directory"],
];

const INSTALLS: RegExp[] = [
	/\bnpm\s+(i|install|add|ci)\b[^;&|]*/i,
	/\bpnpm\s+(i|install|add|dlx)\b[^;&|]*/i,
	/\byarn\s+(add|install|dlx)\b[^;&|]*/i,
	/\bbun\s+(i|install|add)\b[^;&|]*/i,
	/\b(npx|pnpx|bunx|uvx)\s+[^;&|]*/i,
	/\bpip3?\s+install\b[^;&|]*/i,
	/\buv\s+(pip\s+install|add|tool\s+install)\b[^;&|]*/i,
	/\bpipx\s+(install|run)\b[^;&|]*/i,
	/\bgo\s+(install|get)\b[^;&|]*/i,
	/\bcargo\s+install\b[^;&|]*/i,
	/\bgem\s+install\b[^;&|]*/i,
	/\b(brew|winget|choco|scoop)\s+install\b[^;&|]*/i,
	/\bapt(-get)?\s+install\b[^;&|]*/i,
	/\bdocker\s+(pull|run)\b[^;&|]*/i,
];

const READ_ONLY_COMMANDS = new Set([
	"ls",
	"dir",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"rg",
	"find",
	"pwd",
	"echo",
	"printf",
	"which",
	"where",
	"type",
	"file",
	"stat",
	"du",
	"df",
	"env",
	"printenv",
	"date",
	"uname",
	"whoami",
	"hostname",
	"jq",
	"sort",
	"uniq",
	"cut",
	"tr",
	"awk",
	"xxd",
	"od",
	"sha256sum",
	"md5sum",
	"basename",
	"dirname",
	"realpath",
	"true",
	"test",
	"diff",
	"get-childitem",
	"get-content",
	"select-string",
	"get-item",
	"test-path",
	"get-location",
	"resolve-path",
	"get-filehash",
	"measure-object",
	"select-object",
	"where-object",
	"sort-object",
	"format-list",
	"format-table",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, RegExp> = {
	git: /^git\s+(status|log|diff|show|branch|rev-parse|ls-files|blame|describe|remote\s+-v)\b/i,
	npm: /^npm\s+(ls|list|view|info|outdated|--version|-v|config\s+get)\b/i,
	node: /^node\s+(--version|-v)\s*$/i,
	sed: /^sed\s+(?!.*\s-i)/i,
	curl: /^curl\b/i,
	wget: /^wget\s+(-q\s+)?-O\s*-\s/i,
};

function splitSegments(cmd: string): string[] {
	return cmd
		.split(/&&|\|\||;|\||\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function stripEnvPrefix(segment: string): string {
	return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

function isMutatingCurl(segment: string): boolean {
	if (!/^(curl|wget|http|https|xh|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(segment)) return false;
	if (/\s(-X|--request|-Method)\s*['"]?(POST|PUT|PATCH|DELETE)\b/i.test(segment)) return true;
	// Case-sensitive on purpose: curl's -D (dump headers) and -T are different from -d / -t.
	if (/\s(-d|-F|-T)(\s|=|['"])/.test(segment)) return true;
	return /\s(--data(-raw|-binary|-urlencode)?|--form|--upload-file|--json|-Body|--post-data)\b/i.test(segment);
}

function extractHosts(cmd: string): string[] {
	const found = new Set<string>();
	for (const m of cmd.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()`]+/gi)) {
		const h = parseHost(m[0]);
		if (h) found.add(h.port ? `${h.host}:${h.port}` : h.host);
	}
	for (const m of cmd.matchAll(/(?<![\w.:/-])(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?![\w.-])/gi)) {
		found.add(m[2] ? `${m[1].toLowerCase()}:${m[2]}` : m[1].toLowerCase());
	}
	return [...found];
}

/**
 * Shell text with quoted strings and comments blanked out, so a `>` inside `"accepted > 5"`,
 * `node -e "...=>..."`, or `# a -> b` is not taken for a redirect (real-model smoke run).
 * A quoted redirect target (`> "out file"`) stays visible: only quotes not directly after `>` are blanked.
 */
function unquoted(cmd: string): string {
	let out = "";
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === '"' || ch === "'") {
			const end = cmd.indexOf(ch, i + 1);
			const stop = end < 0 ? cmd.length : end + 1;
			// A quoted redirect target is kept verbatim (closing quote included); other strings are blanked.
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

export function analyzeCommand(cmd: string): CommandAnalysis {
	const dangerous = DANGEROUS.find(([re]) => re.test(cmd))?.[1];
	const installs: string[] = [];
	for (const re of INSTALLS) {
		const m = cmd.match(re);
		if (m) installs.push(m[0].trim().replace(/\s+/g, " "));
	}
	const segments = splitSegments(cmd).map(stripEnvPrefix);
	const mutatingHttp = segments.some(isMutatingCurl);
	const writeTargets = extractWriteTargets(cmd);
	const readOnly =
		writeTargets.length === 0 &&
		!mutatingHttp &&
		installs.length === 0 &&
		segments.every((seg) => {
			const word = seg.split(/\s+/)[0]?.toLowerCase() ?? "";
			if (READ_ONLY_COMMANDS.has(word)) return true;
			const sub = READ_ONLY_SUBCOMMANDS[word];
			return !!sub && sub.test(seg);
		});
	return { dangerous, installs, hosts: extractHosts(cmd), mutatingHttp, readOnly, writeTargets };
}
