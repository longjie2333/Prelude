-- M2 global layer: templates, graph, facet vocabulary, capability registry (plan §6).

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

CREATE TABLE facets (
  name          TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('enum', 'hier', 'bool', 'set', 'number')),
  values_json   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL CHECK (status IN ('active', 'proposed')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);

CREATE TABLE capabilities (
  id                     TEXT PRIMARY KEY,
  io_schema_json         TEXT NOT NULL DEFAULT '{}',
  semantics              TEXT NOT NULL,
  conformance_suite_path TEXT,
  created_at             TEXT NOT NULL
);

CREATE TABLE providers (
  sha256            TEXT PRIMARY KEY,
  cap_id            TEXT NOT NULL REFERENCES capabilities(id),
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
