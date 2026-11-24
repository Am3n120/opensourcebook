-- The name an uploaded file came with, kept on the source so it can be named
-- by it (sources/title.ts) when nothing better was read from the file and
-- the person gave it no name. NULL for anything but an upload, and for an
-- upload sent without a name. Additive only.
ALTER TABLE sources ADD COLUMN file_name TEXT;
