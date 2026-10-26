// Re-runs the evaluator on a copy of a smoke run's project.db: node smoke/reevaluate.ts <out-dir>
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateMission } from "../src/learning/evaluator.ts";
import { openStore } from "../src/store/db.ts";
import { listMissions } from "../src/store/repos.ts";

const out = process.argv[2] as string;
const src = join(out, "project", ".pi", "testmode");
const dir = mkdtempSync(join(tmpdir(), "pitm-reeval-"));
for (const f of ["project.db", "project.db-wal", "project.db-shm"]) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dir, f));
const store = openStore(join(dir, "project.db"), join(dir, "global.db"));
for (const m of listMissions(store).filter((x) => x.role === "executor" && x.envelope)) {
	const e = evaluateMission(store, m.id);
	// Verifier notes written before the integrity_issues contract was tightened (run 5) say "none found".
	const real = (e?.cheating ?? []).filter((c) => !/^verifier: (none found|minor)/i.test(c));
	console.log(m.id, m.status, "credibility", e?.credibility, "cheating", JSON.stringify(e?.cheating), "| excluding pre-fix verifier notes:", real.length ? JSON.stringify(real) : "none");
}
store.close();
