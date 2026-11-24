-- The Studio data model (docs/VISION.md "Structure"): projects, sources,
-- chat sessions, plans and their nodes, outputs, and spend. Schema only in
-- Phase 1; the web Studio and the planning skill build on it in Phase 2.
-- Conventions are in 0003_generation_jobs.sql.

-- A project: a course, a paper, a topic. `category` is assigned
-- automatically (nothing fills it yet) and is shared with singles.
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  icon          TEXT,
  color_hex     INTEGER,
  category      TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX projects_owner ON projects (owner_id, updated_at);

-- The result of extracting one piece of content, cached by hash so the same
-- PDF or URL is never extracted twice, whichever projects it is added to.
-- content_hash: SHA-256 of the upload bytes, or of the canonical URL, or of
-- the pasted text.
CREATE TABLE source_extractions (
  content_hash  TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  -- pending | extracting | ready | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  -- full | partial | metadata | none (SourceEnvelope.accessLevel)
  access_level  TEXT,
  envelope_json TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Citable passages of an extraction. A citation points at one of these.
CREATE TABLE source_chunks (
  id           TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL REFERENCES source_extractions (content_hash) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  -- SourceLocator: page/endPage, slide/endSlide (inclusive spans),
  -- startMs/endMs, charStart/charEnd, cell.
  locator_json TEXT,
  UNIQUE (content_hash, ord)
);

-- A source as the user sees it: one item in a project's Sources panel, or in
-- the Inbox while project_id is NULL. Deleting a project sends its sources
-- back to the Inbox rather than destroying them.
CREATE TABLE sources (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  project_id   TEXT REFERENCES projects (id) ON DELETE SET NULL,
  content_hash TEXT NOT NULL REFERENCES source_extractions (content_hash),
  kind         TEXT NOT NULL,
  title        TEXT,
  url          TEXT,
  upload_id    TEXT,
  -- How it got here: upload | link | paste | share | discover | note
  origin       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX sources_project ON sources (project_id, created_at);
CREATE INDEX sources_owner_hash ON sources (owner_id, content_hash);

-- A saved chat. project_id is NULL for a chat that is not about a project
-- (the Feed's "chat about this bit").
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  project_id    TEXT REFERENCES projects (id) ON DELETE CASCADE,
  title         TEXT,
  -- Per-session state such as which sources are ticked.
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX sessions_project ON sessions (project_id, updated_at);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- Position in the session; created_at alone can tie.
  seq           INTEGER NOT NULL,
  -- user | assistant | tool | system
  role          TEXT NOT NULL,
  content_json  TEXT NOT NULL,
  -- @-mentions: albums, outputs, sources, past sessions pulled into context.
  mentions_json TEXT,
  -- Citations of an assistant answer, same shape as outputs.citations_json.
  citations_json TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

-- A plan: one coherent body of media for a project. Once kicked off it is
-- also the album its outputs appear in (one album per kick-off), so a plan
-- that has run is never edited; a changed plan is a new row pointing back
-- through supersedes_plan_id.
CREATE TABLE plans (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- The chat it was planned in; NULL for quick mode's one-node plans.
  session_id         TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  supersedes_plan_id TEXT REFERENCES plans (id) ON DELETE SET NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  title              TEXT,
  -- draft | approved | running | done | failed | cancelled
  -- (failed: it ran to the end and at least one node failed)
  status             TEXT NOT NULL DEFAULT 'draft',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  kicked_off_at      TEXT
);
CREATE INDEX plans_project ON plans (project_id, created_at);

-- One Studio item in a plan.
--   level: the stage. Nodes on one level run side by side and may not assume
--          each other; a node may assume every enabled node on lower levels.
--   ord:   position within the level, for display and for the player.
--   parent_id + condition_json: a branch ("if below 70% → fix, then retry").
--          The node runs only when the condition on its parent's result
--          holds. Shown by indentation.
CREATE TABLE plan_nodes (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES plan_nodes (id) ON DELETE CASCADE,
  level          INTEGER NOT NULL,
  ord            INTEGER NOT NULL,
  -- Studio type; must be registered in StudioTypeRegistry.
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  prompt         TEXT NOT NULL DEFAULT '',
  -- Type-specific settings, parsed by the type's parseSettings.
  settings_json  TEXT NOT NULL DEFAULT '{}',
  condition_json TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  est_cost_usd   REAL,
  -- pending | queued | running | done | failed | skipped | cancelled
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX plan_nodes_plan ON plan_nodes (plan_id, level, ord);

-- A node's own sources: a subset of what was ticked in the chat, optionally
-- narrowed to a range (a SourceLocator: a page span, a time span).
CREATE TABLE plan_node_sources (
  node_id    TEXT NOT NULL REFERENCES plan_nodes (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  range_json TEXT,
  PRIMARY KEY (node_id, source_id)
);

-- Relations between nodes beyond level order.
--   assumes: to_node may rely on from_node (explicit, across any levels).
--   fix_of:  to_node repairs what the learner missed in from_node; its input
--            is that node's result, not a file.
CREATE TABLE plan_edges (
  from_node TEXT NOT NULL REFERENCES plan_nodes (id) ON DELETE CASCADE,
  to_node   TEXT NOT NULL REFERENCES plan_nodes (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  PRIMARY KEY (from_node, to_node, kind)
);
CREATE INDEX plan_edges_to ON plan_edges (to_node);

-- One generated thing. In a project it belongs to a plan node; a single has
-- neither project nor node. Regenerating a node adds a row; the newest wins.
-- prompt, settings and sources are copied here at generation time so "view
-- prompt and sources" stays true after the plan is edited.
-- Large artifacts (video, audio, images) live in R2; payload_json refers to
-- them by asset id.
CREATE TABLE outputs (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  project_id     TEXT REFERENCES projects (id) ON DELETE SET NULL,
  node_id        TEXT REFERENCES plan_nodes (id) ON DELETE SET NULL,
  type           TEXT NOT NULL,
  -- OutputEngine.schemaVersion that wrote payload_json.
  schema_version INTEGER NOT NULL,
  title          TEXT NOT NULL,
  -- What later nodes are told this output covered.
  summary        TEXT NOT NULL DEFAULT '',
  -- Automatic category, for singles (a project's outputs use the project's).
  category       TEXT,
  payload_json   TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  prompt         TEXT,
  settings_json  TEXT,
  -- [{ sourceId, range? }] as actually used.
  sources_json   TEXT NOT NULL DEFAULT '[]',
  cost_usd       REAL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX outputs_project ON outputs (project_id, created_at);
CREATE INDEX outputs_node ON outputs (node_id, created_at);
CREATE INDEX outputs_owner ON outputs (owner_id, created_at);

-- One row per provider call (UsageEvent). project/plan/node are copied from
-- the job so cost per node, per album and per project is one indexed sum.
-- Chat spend has session_id and no job.
CREATE TABLE usage (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  job_id     TEXT,
  project_id TEXT,
  plan_id    TEXT,
  node_id    TEXT,
  session_id TEXT,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  task       TEXT,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  usd        REAL,
  latency_ms INTEGER,
  ok         INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_job ON usage (job_id);
CREATE INDEX usage_node ON usage (node_id);
CREATE INDEX usage_plan ON usage (plan_id);
CREATE INDEX usage_project ON usage (project_id, created_at);
CREATE INDEX usage_session ON usage (session_id);
