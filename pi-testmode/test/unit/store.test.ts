import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putEvidence, readEvidence, sweepOrphanEvidence } from "../../src/harness/evidence.ts";
import { openStore } from "../../src/store/db.ts";
import { audit, insertIntent, insertMission, journalFinish, journalStart, getJournal, listAudit } from "../../src/store/repos.ts";
import { sha256 } from "../../src/util.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
});
afterEach(() => p.cleanup());

describe("migrations", () => {
	it("records schema versions and attaches the global layer", () => {
		expect(p.store.schemaVersion()).toBe(2);
		expect(p.store.schemaVersion("g")).toBe(2);
		expect(p.store.get<{ value: string }>("SELECT value FROM g.layer_info WHERE key = 'layer'")?.value).toBe("global");
		expect(p.store.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
	});

	it("is idempotent on reopen", () => {
		p.store.close();
		const again = openStore(p.paths.projectDb, p.paths.globalDb);
		expect(again.schemaVersion()).toBe(2);
		again.close();
		p.store = openStore(p.paths.projectDb, p.paths.globalDb);
	});
});

describe("audit", () => {
	it("is append-only", () => {
		audit(p.store, { actor: "main", event: "x" });
		expect(() => p.store.run("UPDATE audit SET event = 'y'")).toThrow(/append-only/);
		expect(() => p.store.run("DELETE FROM audit")).toThrow(/append-only/);
		expect(listAudit(p.store)).toHaveLength(1);
	});
});

describe("transactions", () => {
	it("roll back on error and support nesting", () => {
		expect(() =>
			p.store.tx(() => {
				insertIntent(p.store, "i-1", "raw", {});
				p.store.tx(() => audit(p.store, { actor: "main", event: "nested" }));
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(p.store.get("SELECT * FROM intents")).toBeUndefined();
		expect(listAudit(p.store)).toHaveLength(0);
	});
});

describe("tool journal", () => {
	it("records started then finished, keyed by (mission, call)", () => {
		insertIntent(p.store, "i-1", "raw", {});
		insertMission(
			p.store,
			{ missionId: "m-1", intentId: "i-1", role: "executor", objective: "o", targets: [], testKinds: [], riskTier: "R2", riskReasons: [], budget: { tokens: 1, wallClockMs: 1 } },
			join(p.paths.runsDir, "m-1"),
		);
		journalStart(p.store, { missionId: "m-1", toolCallId: "c1", tool: "bash", inputDigest: "d", effectClass: "side_effecting" });
		journalStart(p.store, { missionId: "m-1", toolCallId: "c1", tool: "bash", inputDigest: "d", effectClass: "side_effecting" });
		expect(getJournal(p.store, "m-1", "c1")?.status).toBe("started");
		journalFinish(p.store, { missionId: "m-1", toolCallId: "c1", isError: false, resultDigest: "r", resultRef: "r" });
		expect(getJournal(p.store, "m-1", "c1")).toMatchObject({ status: "finished", isError: false, resultRef: "r" });
	});
});

describe("evidence", () => {
	it("is content-addressed and deduplicated", () => {
		const a = putEvidence(p.store, p.paths.evidenceDir, "hello", { missionId: null, kind: "stdout" });
		const b = putEvidence(p.store, p.paths.evidenceDir, "hello", { missionId: null, kind: "stdout" });
		expect(a.sha256).toBe(sha256("hello"));
		expect(b.path).toBe(a.path);
		expect(readEvidence(p.paths.evidenceDir, a.sha256)?.toString()).toBe("hello");
		expect(readEvidence(p.paths.evidenceDir, "../escape")).toBeUndefined();
	});

	it("sweeps unregistered files and temp files on startup", () => {
		putEvidence(p.store, p.paths.evidenceDir, "kept", { missionId: null, kind: "x" });
		const orphan = join(p.paths.evidenceDir, sha256("orphan"));
		const tmp = join(p.paths.evidenceDir, ".tmp-123-abc");
		writeFileSync(orphan, "orphan");
		writeFileSync(tmp, "partial");
		const old = new Date(Date.now() - 120_000);
		utimesSync(orphan, old, old);
		utimesSync(tmp, old, old);
		expect(sweepOrphanEvidence(p.store, p.paths.evidenceDir)).toBe(2);
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(join(p.paths.evidenceDir, sha256("kept")))).toBe(true);
	});
});
