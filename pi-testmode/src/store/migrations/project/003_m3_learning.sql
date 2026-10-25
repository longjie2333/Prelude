-- M3 learning (plan §6). Statistics and deltas live in project.db, including for global-layer
-- templates, so recording feedback, updating statistics, and committing a delta stay in one
-- SQLite transaction (M3-4 idempotency). Global templates are never edited from a project:
-- a project change to one is made through a project-layer override (agent-core §8.5).

CREATE TABLE feedback (
  id               TEXT PRIMARY KEY,
  episode_id       TEXT NOT NULL UNIQUE REFERENCES episodes(id),
  signals_json     TEXT NOT NULL,
  credibility      REAL NOT NULL,
  triage_class     TEXT NOT NULL CHECK (triage_class IN ('S', 'V', 'E', 'N', 'J', 'C', 'I', 'P', 'B', 'K', 'U')),
  attribution_json TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE template_stats (
  template_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  alpha       REAL NOT NULL DEFAULT 1,
  beta        REAL NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (template_id, cluster_key)
);

CREATE TABLE deltas (
  id               TEXT PRIMARY KEY,
  op               TEXT NOT NULL,
  target           TEXT NOT NULL,
  target_version   INTEGER,
  hypothesis_key   TEXT,
  payload_json     TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected', 'suspended')),
  gate_report_json TEXT,
  proposed_by      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  decided_at       TEXT
);
CREATE INDEX deltas_target ON deltas(target, status);
CREATE INDEX deltas_hypothesis ON deltas(hypothesis_key, status);

CREATE TABLE calibration_runs (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  precision    REAL NOT NULL,
  recall       REAL NOT NULL,
  details_json TEXT NOT NULL,
  drift        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE snapshots (
  id   TEXT PRIMARY KEY,
  ts   TEXT NOT NULL,
  path TEXT NOT NULL
);

ALTER TABLE intents ADD COLUMN learned_at TEXT;
