-- The model and effort a chat turn was sent to the connector with
-- (engine/docs/api.md, "Making times"), so its reply's time is kept under
-- the pick it really ran on and not one read again from the chat later.
-- NULL for a turn begun before this was kept: no time is kept for it.
-- Additive only.
ALTER TABLE agent_turns ADD COLUMN pick_json TEXT;
