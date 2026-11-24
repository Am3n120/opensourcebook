-- Chats (engine/docs/api.md, "Chats"). 0004 already holds a chat
-- (`sessions`) and its messages; this adds what writing replies needs.
-- Additive only.

-- Set while Open Sourcebook writes a reply in the chat, so two turns in one chat cannot
-- interleave their messages. A mark older than a few minutes (a Worker that
-- died mid-turn) is taken over by the next turn. NULL when idle.
ALTER TABLE sessions ADD COLUMN busy_since TEXT;

-- The plans a chat made, newest first: the plan a follow-up message changes.
CREATE INDEX plans_session ON plans (session_id, created_at);
