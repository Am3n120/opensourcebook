-- A provider is in the person's list once they add it in Settings, or on
-- its own when the connector finds it installed and they never chose; it
-- leaves the list when they remove it (`added`: NULL = not chosen, 1 = added,
-- 0 = removed). Favorite models show first in the chat's picker, under the
-- star (engine/docs/api.md, "Providers"; DECISIONS #58). Additive only.
ALTER TABLE provider_settings ADD COLUMN added INTEGER;
ALTER TABLE provider_settings ADD COLUMN favorite_models_json TEXT NOT NULL DEFAULT '[]';
