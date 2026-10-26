/**
 * Applicability judge (agent-core §7.4, plan M2-3). Pure and deterministic: hard conditions with
 * three-valued logic, then the exception list in order (first match wins), soft affinity as a
 * score. M3's cornerstone replay reuses this function.
 */
import type { Applicability, Fingerprint, Predicate, TemplateException } from "./schema.ts";

export type Tri = "true" | "false" | "unknown";

export interface Judgement {
	result: Tri;
	/** The exception that fired, if any (its action shapes how the template is used). */
	exception?: TemplateException;
	/** Probes to run because a deciding facet is unknown. */
	probes: Array<{ facet: string; probe: string }>;
	/** Facets that were unknown where they mattered. */
	unknown: string[];
	/** Soft affinity in [0, 1]. */
	score: number;
	reasons: string[];
}

/** `a` is `b` or below it in a `/`-hierarchy (`jvm/spring-boot` is under `jvm`). */
function isUnder(a: string, b: string): boolean {
	if (b.endsWith("/*")) b = b.slice(0, -2);
	return a === b || a.startsWith(`${b}/`);
}

export function evalPredicate(p: Predicate, fp: Fingerprint): Tri {
	const entry = fp[p.facet];
	if (p.op === "exists") return entry ? "true" : "unknown";
	if (!entry) return "unknown";
	const have = entry.values;
	const targets = p.values ?? (p.value !== undefined ? [p.value] : []);
	const any = (f: (v: string, t: string) => boolean) => have.some((v) => targets.some((t) => f(v, t)));
	switch (p.op) {
		case "eq":
			return have.length === 1 && targets.length === 1 && have[0] === targets[0] ? "true" : "false";
		case "ne":
			return have.every((v) => !targets.includes(v)) ? "true" : "false";
		case "in":
			return any(isUnder) ? "true" : "false";
		case "not_in":
			return any(isUnder) ? "false" : "true";
		case "contains":
			return targets.every((t) => have.includes(t)) ? "true" : "false";
		case "under":
			return have.every((v) => targets.some((t) => isUnder(v, t))) ? "true" : "false";
	}
	return "unknown";
}

/** Kleene conjunction. */
export function all(results: readonly Tri[]): Tri {
	if (results.includes("false")) return "false";
	if (results.includes("unknown")) return "unknown";
	return "true";
}

export function describePredicate(p: Predicate): string {
	const v = p.values ? `[${p.values.join(", ")}]` : (p.value ?? "");
	return `${p.facet} ${p.op}${v ? ` ${v}` : ""}`;
}

export function judge(app: Applicability, fp: Fingerprint): Judgement {
	const reasons: string[] = [];
	const unknown = new Set<string>();
	const probes = new Map<string, string>();
	const probeFor = (facet: string) => app.unknown_handling.find((u) => u.facet === facet)?.probe;
	const noteUnknown = (p: Predicate) => {
		unknown.add(p.facet);
		const probe = probeFor(p.facet);
		if (probe) probes.set(p.facet, probe);
	};

	const hardResults = app.hard.map((p) => {
		const r = evalPredicate(p, fp);
		if (r === "false") reasons.push(`hard ${describePredicate(p)} is false`);
		if (r === "unknown") noteUnknown(p);
		return r;
	});
	let result = all(hardResults);

	let score = 1;
	if (app.soft.length > 0) {
		const total = app.soft.reduce((s, x) => s + x.weight, 0) || 1;
		const got = app.soft.reduce((s, x) => {
			const r = evalPredicate(x.when, fp);
			return s + (r === "true" ? x.weight : r === "unknown" ? x.weight / 2 : 0);
		}, 0);
		score = got / total;
	}

	let fired: TemplateException | undefined;
	if (result !== "false") {
		for (const ex of app.exceptions) {
			const cond = all(ex.when.map((p) => evalPredicate(p, fp)));
			if (cond === "true") {
				fired = ex;
				reasons.push(`exception ${ex.id} fires: ${ex.because}`);
				if (ex.action === "exclude") result = "false";
				if (ex.action === "require_probe" && ex.probe) {
					for (const p of ex.when) probes.set(p.facet, ex.probe);
					if (result === "true") result = "unknown";
				}
				break;
			}
			if (cond === "unknown") {
				// The exception may apply: the deciding facets must be probed before relying on the template.
				for (const p of ex.when) if (evalPredicate(p, fp) === "unknown") noteUnknown(p);
				if (result === "true") result = "unknown";
				reasons.push(
					`exception ${ex.id} undecided (${ex.when
						.filter((p) => evalPredicate(p, fp) === "unknown")
						.map((p) => p.facet)
						.join(", ")} unknown)`,
				);
				break;
			}
		}
	}
	return {
		result,
		exception: fired,
		probes: [...probes].map(([facet, probe]) => ({ facet, probe })),
		unknown: [...unknown],
		score,
		reasons,
	};
}
