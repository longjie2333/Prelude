-- M1 core tables (docs/pi-testmode-plan.md §6)

CREATE TABLE intents (
  id          TEXT PRIMARY KEY,
  raw         TEXT NOT NULL,
  ir_json     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  report_path TEXT,
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);

CREATE TABLE missions (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES intents(id),
  parent_id        TEXT REFERENCES missions(id),
  role             TEXT NOT NULL,
  objective        TEXT NOT NULL,
  spec_json        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'interrupted', 'completed', 'partial', 'blocked', 'failed', 'aborted')),
  interrupt_reason TEXT CHECK (interrupt_reason IN ('crash', 'network', 'shutdown')),
  risk_tier        TEXT NOT NULL,
  budget_json      TEXT NOT NULL,
  cost_json        TEXT NOT NULL DEFAULT '{}',
  envelope_json    TEXT,
  error            TEXT,
  session_path     TEXT,
  run_dir          TEXT NOT NULL,
  owner_pid        INTEGER,
  heartbeat_at     TEXT,
  resume_count     INTEGER NOT NULL DEFAULT 0,
  notified_at      TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT
);
CREATE INDEX missions_intent ON missions(intent_id);
CREATE INDEX missions_status ON missions(status);

CREATE TABLE tool_journal (
  mission_id    TEXT NOT NULL REFERENCES missions(id),
  tool_call_id  TEXT NOT NULL,
  tool          TEXT NOT NULL,
  input_digest  TEXT NOT NULL,
  effect_class  TEXT NOT NULL CHECK (effect_class IN ('read_only', 'idempotent', 'side_effecting')),
  status        TEXT NOT NULL CHECK (status IN ('started', 'finished')),
  is_error      INTEGER,
  result_digest TEXT,
  result_ref    TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  PRIMARY KEY (mission_id, tool_call_id)
);

CREATE TABLE evidence (
  sha256     TEXT PRIMARY KEY,
  mission_id TEXT,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE test_runs (
  id                  TEXT PRIMARY KEY,
  mission_id          TEXT NOT NULL REFERENCES missions(id),
  tool_call_id        TEXT,
  command             TEXT NOT NULL,
  cwd                 TEXT NOT NULL,
  exit_code           INTEGER,
  duration_ms         INTEGER,
  stdout_sha          TEXT,
  stderr_sha          TEXT,
  verdict             TEXT CHECK (verdict IN ('pass', 'fail', 'inconclusive', 'error')),
  verdict_note        TEXT,
  artifact_shas_json  TEXT NOT NULL DEFAULT '[]',
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX test_runs_mission ON test_runs(mission_id);

CREATE TABLE frozen_artifacts (
  path       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  frozen_at  TEXT NOT NULL,
  PRIMARY KEY (mission_id, path)
);

CREATE TABLE approvals (
  id         TEXT PRIMARY KEY,
  mission_id TEXT,
  tier       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  scope      TEXT NOT NULL CHECK (scope IN ('once', 'session', 'always')),
  decided_at TEXT NOT NULL
);
CREATE INDEX approvals_subject ON approvals(subject);

CREATE TABLE audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  event        TEXT NOT NULL,
  tool         TEXT,
  input_digest TEXT,
  decision     TEXT,
  reason       TEXT
);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
