-- A chat turn answered by the person's own agent through the connector on
-- their computer (engine/docs/api.md, "Your agent"; DECISIONS #53).
-- Additive only.

-- One row per turn handed to the agent. The reply message exists from the
-- start (its content says it is running); the row holds what the agent's
-- tool calls are scoped to and the hash of the token they carry.
CREATE TABLE agent_turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- The assistant message this turn fills in.
  message_id    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  -- The agent adapter that answers it (`claude`, `codex`).
  agent         TEXT NOT NULL,
  -- SHA-256 of the per-turn token the connector sends back; the token itself is never stored.
  token_hash    TEXT NOT NULL,
  -- running | done | failed | stopped
  state         TEXT NOT NULL,
  -- The message as the person sent it: text, mentions, the command it used.
  request_json  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE INDEX agent_turns_session ON agent_turns (session_id, started_at);

-- The steps the agent took in a turn, one per tool call, in order. What a
-- step adds to the reply (a plan card, a question, the reply's text) is
-- kept in result_json and assembled when the turn ends.
CREATE TABLE agent_steps (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES agent_turns (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  -- In plain words, for the person: "Searching Lecture 7".
  label       TEXT NOT NULL,
  -- running | done | failed
  state       TEXT NOT NULL,
  result_json TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  UNIQUE (turn_id, seq)
);
