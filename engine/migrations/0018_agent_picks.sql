-- Remembered agent, model, and effort picks per owner and scope (for example a format like video).
CREATE TABLE IF NOT EXISTS agent_picks (
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  effort TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, scope)
);
