-- A source the person removed while something still points at it (a plan
-- item, something made from it, a citation in a chat reply): the row stays
-- so those keep working and can say the source was removed, but lists,
-- chats and new plan items no longer see it. NULL for a live source. The
-- row is deleted for good once nothing points at it. Additive only.
ALTER TABLE sources ADD COLUMN removed_at TEXT;
CREATE INDEX sources_owner_removed ON sources (owner_id, removed_at);
