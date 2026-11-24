-- Where the person stopped in an item, apart from its result: the bit of a
-- byte they were on, a quiz's answers so far, a video's time. The phone and
-- the web read and write the same row, so stopping on one and opening the
-- other carries on. Its shape belongs to the item's format, like the result,
-- but nothing reads it to decide a branch (engine/docs/api.md, "Progress").
-- Additive only.
ALTER TABLE item_results ADD COLUMN progress_json TEXT;
