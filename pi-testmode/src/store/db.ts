/**
 * SQLite store (plan I-3): `node:sqlite` behind a thin wrapper so the driver can be swapped.
 *
 * `project.db` is the main schema; `global.db` is migrated on its own connection and then
 * ATTACHed as `g`, so migrations never need schema-qualified names.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

const MIN_NODE = [22, 19] as const;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Row = Record<string, SQLInputValue>;
export type Params = Record<string, SQLInputValue | boolean | undefined>;

export interface Store {
	readonly db: DatabaseSync;
	run(sql: string, params?: Params): { changes: number; lastInsertRowid: number | bigint };
	get<T = Row>(sql: string, params?: Params): T | undefined;
	all<T = Row>(sql: string, params?: Params): T[];
	/** Runs `fn` in an IMMEDIATE transaction; nested calls join the outer transaction. */
	tx<T>(fn: () => T): T;
	schemaVersion(schema?: "main" | "g"): number;
	close(): void;
}

let sqliteModule: typeof import("node:sqlite") | undefined;

function loadSqlite(): typeof import("node:sqlite") {
	if (sqliteModule) return sqliteModule;
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
		throw new Error(
			`pi-testmode needs Node >= ${MIN_NODE.join(".")} for node:sqlite (running ${process.versions.node}).`,
		);
	}
	// Filter only the node:sqlite ExperimentalWarning (plan §12).
	const original = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (/SQLite is an experimental feature/.test(text)) return;
		return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	} finally {
		process.emitWarning = original;
	}
	return sqliteModule;
}

function normalizeParams(params?: Params): Record<string, SQLInputValue> {
	const out: Record<string, SQLInputValue> = {};
	if (!params) return out;
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) out[k] = null;
		else if (typeof v === "boolean") out[k] = v ? 1 : 0;
		else out[k] = v;
	}
	return out;
}

function openRaw(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}

function migrationFiles(layer: "project" | "global"): Array<{ version: number; sql: string; name: string }> {
	const dir = join(MIGRATIONS_DIR, layer);
	return readdirSync(dir)
		.filter((f) => /^\d+_.*\.sql$/.test(f))
		.sort()
		.map((name) => ({ version: Number.parseInt(name, 10), name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies pending migrations in order inside one transaction each; returns the resulting version. */
export function migrate(db: DatabaseSync, layer: "project" | "global"): number {
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
	let version = row ? Number(row.value) : 0;
	for (const m of migrationFiles(layer)) {
		if (m.version <= version) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(m.sql);
			db.prepare(
				"INSERT INTO meta (key, value) VALUES ('schema_version', $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			).run({ $v: String(m.version) });
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`Migration ${layer}/${m.name} failed: ${(err as Error).message}`);
		}
		version = m.version;
	}
	return version;
}

export function openStore(projectDbPath: string, globalDbPath: string): Store {
	const g = openRaw(globalDbPath);
	try {
		migrate(g, "global");
	} finally {
		g.close();
	}
	const db = openRaw(projectDbPath);
	migrate(db, "project");
	db.prepare("ATTACH DATABASE $p AS g").run({ $p: globalDbPath });
	return wrap(db);
}

function wrap(db: DatabaseSync): Store {
	let depth = 0;
	const store: Store = {
		db,
		run(sql, params) {
			const r = db.prepare(sql).run(normalizeParams(params));
			return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
		},
		get<T>(sql: string, params?: Params) {
			return db.prepare(sql).get(normalizeParams(params)) as T | undefined;
		},
		all<T>(sql: string, params?: Params) {
			return db.prepare(sql).all(normalizeParams(params)) as T[];
		},
		tx<T>(fn: () => T): T {
			if (depth > 0) {
				depth++;
				try {
					return fn();
				} finally {
					depth--;
				}
			}
			db.exec("BEGIN IMMEDIATE");
			depth = 1;
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			} finally {
				depth = 0;
			}
		},
		schemaVersion(schema = "main") {
			const row = db.prepare(`SELECT value FROM ${schema}.meta WHERE key = 'schema_version'`).get() as
				| { value: string }
				| undefined;
			return row ? Number(row.value) : 0;
		},
		close() {
			if (db.isOpen) db.close();
		},
	};
	return store;
}
