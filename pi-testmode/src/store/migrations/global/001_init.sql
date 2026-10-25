-- Global layer (docs/pi-testmode-plan.md §6). Template and capability tables arrive with M2.
CREATE TABLE IF NOT EXISTS layer_info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO layer_info (key, value) VALUES ('layer', 'global');
