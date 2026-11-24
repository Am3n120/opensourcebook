-- What the person's agent has written so far of a call to a tool that shows
-- while it is written (the reply), before the call itself arrives
-- (engine/docs/api.md, "Your agent"). One per turn, replaced by each newer
-- draft; read only while the turn runs. Additive only.
ALTER TABLE agent_turns ADD COLUMN draft_json TEXT;
