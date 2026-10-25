-- M2 project layer: project templates (same shape as global), experience, capability gaps.

CREATE TABLE templates (
  id           TEXT PRIMARY KEY,
  layer        TEXT NOT NULL CHECK (layer IN ('global', 'project')),
  type         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'stable', 'deprecated', 'retired')),
  head_version INTEGER NOT NULL,
  seed         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE template_versions (
  template_id      TEXT NOT NULL REFERENCES templates(id),
  version          INTEGER NOT NULL,
  spec_json        TEXT NOT NULL,
  body_md          TEXT NOT NULL,
  changelog        TEXT NOT NULL,
  created_by_delta TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE VIRTUAL TABLE templates_fts USING fts5(template_id UNINDEXED, title, summary, intent_patterns, tokenize = 'trigram');

CREATE TABLE template_facets (
  template_id TEXT NOT NULL,
  facet       TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (template_id, facet, value)
);
CREATE INDEX template_facets_lookup ON template_facets(facet, value);

CREATE TABLE edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('specializes', 'composes', 'refers', 'alternative_to', 'precedes', 'conflicts_with', 'redirects_to', 'derived_from', 'overrides', 'requires', 'implemented_by')),
  attrs_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX edges_dst ON edges(dst, kind);

CREATE TABLE episodes (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT NOT NULL UNIQUE REFERENCES missions(id),
  intent_id        TEXT NOT NULL,
  sut_key          TEXT,
  fingerprint_json TEXT NOT NULL,
  plan_json        TEXT NOT NULL,
  deviations_json  TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX episodes_sut ON episodes(sut_key, created_at);

CREATE TABLE template_uses (
  episode_id  TEXT NOT NULL REFERENCES episodes(id),
  template_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('applied', 'cited', 'retrieved_unused')),
  slot        TEXT,
  PRIMARY KEY (episode_id, template_id, role)
);

CREATE TABLE cornerstones (
  template_id      TEXT NOT NULL,
  exception_id     TEXT,
  episode_id       TEXT NOT NULL REFERENCES episodes(id),
  fingerprint_json TEXT NOT NULL,
  PRIMARY KEY (template_id, episode_id)
);

CREATE TABLE capability_gaps (
  id                  TEXT PRIMARY KEY,
  requested_by        TEXT NOT NULL REFERENCES missions(id),
  cap_id              TEXT NOT NULL,
  spec_json           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('open', 'acquiring', 'resolved', 'failed')),
  toolsmith_mission_id TEXT,
  provider_sha        TEXT,
  created_at          TEXT NOT NULL,
  resolved_at         TEXT
);

CREATE TABLE retrievals (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES intents(id),
  query            TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  hit_level        TEXT NOT NULL,
  cards_json       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

ALTER TABLE intents ADD COLUMN hit_level TEXT;

-- Project-layer providers (skills under <repo>/.pi/testmode/skills). Same shape as g.providers;
-- cap_id refers to g.capabilities (cross-database, so no foreign key).
CREATE TABLE providers (
  sha256            TEXT PRIMARY KEY,
  cap_id            TEXT NOT NULL,
  layer             TEXT NOT NULL CHECK (layer IN ('global', 'project')),
  kind              TEXT NOT NULL CHECK (kind IN ('skill', 'mcp', 'cli')),
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  path_or_config_json TEXT NOT NULL,
  trust             TEXT NOT NULL CHECK (trust IN ('quarantined', 'candidate', 'verified', 'pinned')),
  conformance_score REAL,
  provenance_json   TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  verified_at       TEXT
);
CREATE INDEX providers_cap ON providers(cap_id, trust);
