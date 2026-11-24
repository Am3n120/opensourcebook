-- Which of the person's providers (their own agents: Claude Code, Codex,
-- later others) the chat may use, and which of each one's models show in
-- the chat's picker (engine/docs/api.md, "Providers"; DECISIONS #62). A row
-- exists only once the person changed something: no row means on, with
-- every model shown. Additive only.
CREATE TABLE provider_settings (
  owner_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  hidden_models_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, provider_id)
);
