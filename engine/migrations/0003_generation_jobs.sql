-- Generation jobs: one row per unit of queued work, for any Studio type.
-- Replaces the August `jobs` table, which kept the whole job as one JSON blob
-- and lost cancels to a read-merge-write race.
--
-- Conventions for this and later migrations:
--   * ids are TEXT (UUIDs), timestamps are TEXT in ISO-8601 UTC.
--   * Value sets that will grow (status, stage, kind, type) are documented
--     here and validated in code, not in CHECK constraints: SQLite cannot
--     alter a CHECK without rebuilding the table.
--
-- Every write is a compare-and-set:
--   UPDATE generation_jobs SET ..., version = version + 1
--   WHERE id = ? AND version = ?
-- A writer whose version is stale re-reads and decides again, so a progress
-- write can never undo a cancel.

CREATE TABLE generation_jobs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  -- Client-chosen; a repeated request returns the existing job.
  idempotency_key TEXT NOT NULL,
  -- What the job does: 'output' (run an engine). Room for 'extract' etc.
  kind            TEXT NOT NULL DEFAULT 'output',
  -- Studio type for kind = 'output'.
  type            TEXT,
  -- What it is for. All NULL-able: a quick-mode single has no plan or node.
  -- Plain columns, not foreign keys: these tables arrive in 0004 and a job
  -- row must outlive the things it points at as a record of spend.
  project_id      TEXT,
  plan_id         TEXT,
  node_id         TEXT,
  source_id       TEXT,
  -- Set when the job finishes and its output row is written.
  output_id       TEXT,
  -- queued | running | done | failed | cancelled | dead
  -- 'dead': the queue gave up after max retries (dead-letter consumer).
  status          TEXT NOT NULL DEFAULT 'queued',
  -- Engine-reported stage name, free text for display.
  stage           TEXT NOT NULL DEFAULT 'queued',
  -- 0...1, never moves backwards within one attempt.
  progress        REAL NOT NULL DEFAULT 0,
  -- Incremented each time a consumer picks the job up.
  attempt         INTEGER NOT NULL DEFAULT 0,
  -- Compare-and-set counter, see above.
  version         INTEGER NOT NULL DEFAULT 0,
  retryable       INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  -- The request as received (quick mode: source text, URL, upload id).
  input_json      TEXT NOT NULL DEFAULT '{}',
  -- Saved step results for resume (engine blueprint, extraction, research).
  state_json      TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX generation_jobs_status ON generation_jobs (status, updated_at);
CREATE INDEX generation_jobs_node ON generation_jobs (node_id);
CREATE INDEX generation_jobs_plan ON generation_jobs (plan_id, status);
CREATE INDEX generation_jobs_owner ON generation_jobs (owner_id, created_at);
