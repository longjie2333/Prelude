/** Path normalization for the policy gate (plan §12: case, separators, realpath). */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function realpathOfLongestExistingPrefix(abs: string): string {
	let current = abs;
	const tail: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return abs;
		tail.unshift(basename(current));
		current = parent;
	}
	let real: string;
	try {
		real = realpathSync.native(current);
	} catch {
		real = current;
	}
	return tail.length ? join(real, ...tail) : real;
}

/** Absolute, symlink-resolved, case-folded (where the FS is case-insensitive) path. */
export function canonicalPath(p: string, cwd: string, home = homedir()): string {
	let raw = p.trim();
	if (raw.startsWith("@")) raw = raw.slice(1);
	if (raw === "~") raw = home;
	else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(home, raw.slice(2));
	// Git Bash style /c/Users/... on Windows
	if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(raw)) raw = `${raw[1]}:${raw.slice(2)}`;
	const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
	const real = realpathOfLongestExistingPrefix(abs);
	return CASE_INSENSITIVE ? real.toLowerCase() : real;
}

/** True when `child` is `parent` or inside it. Both must be canonical. */
export function isInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}
