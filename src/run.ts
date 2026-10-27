/**
 * One test run on disk (plan M1-6, D-2): `runs/<id>/state.json` and `runs/<id>/findings.jsonl`.
 * Repro scripts and evidence are frozen into `evidence/<sha256><ext>` when a finding is recorded
 * (D-13), so what gets verified is what was recorded, not a file the model edited afterwards.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { type ProjectPaths, type RunPaths, runPaths } from "./paths.ts";
import { nowIso, readJson, readJsonl, sha256, writeJson, writeJsonl } from "./util.ts";

export const PHASES = ["intake", "profile", "execute", "verify", "report", "retro"] as const;
export type Phase = (typeof PHASES)[number];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const FINDING_KINDS = ["defect", "suggestion"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface RunState {
	id: string;
	goal: string;
	startedAt: string;
	phase: Phase;
	history: Array<{ phase: Phase; at: string; note?: string }>;
	report?: { path: string; at: string };
	notesReminded?: boolean;
	/** Knowledge-base writes made in this run (retro check, plan M2-8). */
	kbWrites?: number;
	/** `kbWrites` at the last successful end sync; settling again pushes only when it differs. */
	kbSyncedWrites?: number;
	retroReminded?: boolean;
}

export interface FrozenFile {
	/** Path as the model gave it, relative to the project root when inside it. */
	source: string;
	/** Frozen copy, relative to the project root. */
	stored: string;
	sha256: string;
}

export type Verdict = "confirmed" | "rejected" | "not-reproduced";

export interface Verification {
	verdict: Verdict;
	at: string;
	rerun?: { runs: number; reproduced: number; rate: number; exitCodes: Array<number | null> };
	review?: { verdict: "confirmed" | "rejected"; reason: string };
}

export interface Finding {
	id: string;
	title: string;
	severity: Severity;
	kind: FindingKind;
	description: string;
	at: string;
	repro?: FrozenFile;
	evidence: FrozenFile[];
	verification?: Verification;
}

export class Run {
	readonly id: string;
	readonly paths: RunPaths;
	readonly project: ProjectPaths;

	constructor(project: ProjectPaths, id: string) {
		this.id = id;
		this.project = project;
		this.paths = runPaths(project, id);
	}

	static create(project: ProjectPaths, id: string, goal: string): Run {
		const run = new Run(project, id);
		const at = nowIso();
		run.writeState({ id, goal, startedAt: at, phase: "intake", history: [{ phase: "intake", at }] });
		return run;
	}

	state(): RunState {
		const s = readJson<RunState>(this.paths.stateFile);
		if (!s) throw new Error(`run state missing: ${this.paths.stateFile}`);
		return s;
	}

	writeState(state: RunState): void {
		writeJson(this.paths.stateFile, state);
	}

	updateState(fn: (s: RunState) => void): RunState {
		const s = this.state();
		fn(s);
		this.writeState(s);
		return s;
	}

	setPhase(phase: Phase, note?: string): RunState {
		return this.updateState((s) => {
			s.phase = phase;
			s.history.push({ phase, at: nowIso(), ...(note ? { note } : {}) });
		});
	}

	findings(): Finding[] {
		return readJsonl<Finding>(this.paths.findingsFile);
	}

	finding(id: string): Finding {
		const f = this.findings().find((x) => x.id === id);
		if (!f) throw new Error(`no finding ${id} in run ${this.paths.dir}`);
		return f;
	}

	/** Rewrites the file atomically; findings are few, and verification updates them in place. */
	saveFindings(findings: Finding[]): void {
		writeJsonl(this.paths.findingsFile, findings);
	}

	addFinding(
		input: Omit<Finding, "id" | "at" | "repro" | "evidence"> & { repro?: string; evidence?: string[] },
	): Finding {
		const findings = this.findings();
		const id = `f-${String(findings.length + 1).padStart(3, "0")}`;
		if (input.kind === "defect" && !input.repro)
			throw new Error("a defect needs a repro script (exit code non-zero = reproduced)");
		const finding: Finding = {
			id,
			title: input.title,
			severity: input.severity,
			kind: input.kind,
			description: input.description,
			at: nowIso(),
			repro: input.repro ? this.freeze(input.repro) : undefined,
			evidence: (input.evidence ?? []).map((e) => this.freeze(e)),
		};
		findings.push(finding);
		this.saveFindings(findings);
		return finding;
	}

	updateFinding(id: string, fn: (f: Finding) => void): Finding {
		const findings = this.findings();
		const f = findings.find((x) => x.id === id);
		if (!f) throw new Error(`no finding ${id}`);
		fn(f);
		this.saveFindings(findings);
		return f;
	}

	/** Copies a file into `evidence/<sha256><ext>` (content-addressed, so duplicates collapse). */
	freeze(path: string): FrozenFile {
		const root = this.project.root;
		const abs = isAbsolute(path) ? path : resolve(root, path);
		if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`not a file: ${path}`);
		const hash = sha256(readFileSync(abs));
		mkdirSync(this.project.evidenceDir, { recursive: true });
		const stored = join(this.project.evidenceDir, `${hash}${extname(abs).toLowerCase()}`);
		if (!existsSync(stored)) copyFileSync(abs, stored);
		return { source: rel(root, abs), stored: rel(root, stored), sha256: hash };
	}

	abs(projectRelative: string): string {
		return resolve(this.project.root, projectRelative);
	}
}

function rel(root: string, abs: string): string {
	const r = relative(root, abs);
	return (r.startsWith("..") || isAbsolute(r) ? abs : r).replace(/\\/g, "/");
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
	const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
	for (const f of findings)
		if (f.verification?.verdict !== "rejected" && f.verification?.verdict !== "not-reproduced") out[f.severity]++;
	return out;
}
