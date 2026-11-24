-- Asset metadata for harvested source media (PDF figures, video frames,
-- article images). Bytes live in the RE_ASSETS R2 bucket under `assets/<id>`;
-- this table records provenance so assets can be audited and re-linked
-- without listing the bucket.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT,
  source_url TEXT,
  caption TEXT,
  page INTEGER,
  timestamp_ms INTEGER,
  content_type TEXT,
  byte_length INTEGER,
  created_at TEXT
);
