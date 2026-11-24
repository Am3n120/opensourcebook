-- Durable job storage for the Open Sourcebook engine Worker.
-- The complete SourceJob is stored in payload_json; idempotency_key carries
-- `${clientToken}:${idempotencyKey}` and is unique so concurrent create
-- requests resolve to a single job.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs (updated_at);
