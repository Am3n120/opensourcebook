-- How long things took to make on this computer, one row per finished job (or chat turn),
-- keyed by the pick it was made on. A time is said only from rows with the exact same key.
CREATE TABLE IF NOT EXISTS make_times (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,          -- "chat", a format id, or "<format>.review"
  agent TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  bucket TEXT NOT NULL DEFAULT '',
  seconds REAL NOT NULL,
  job_id TEXT,                  -- the job, or the agent turn for the chat; a review's is "<job>.review"; one row per job
  made_at TEXT NOT NULL,
  UNIQUE (owner_id, job_id)
);
CREATE INDEX IF NOT EXISTS make_times_key ON make_times (owner_id, scope, agent, model, effort, bucket, made_at);
