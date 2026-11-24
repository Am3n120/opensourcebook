-- Small settings kept per owner, one JSON value per key (for example whether first-time setup is done).
CREATE TABLE IF NOT EXISTS owner_settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
