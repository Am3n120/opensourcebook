-- Why a provider call failed, when it did: 'timeout' when the engine stopped
-- waiting for an answer the provider may still have produced and billed, so
-- the call's cost is unknown rather than zero. NULL for a call that
-- succeeded or for rows written before this column. Additive only.
ALTER TABLE usage ADD COLUMN error TEXT;
