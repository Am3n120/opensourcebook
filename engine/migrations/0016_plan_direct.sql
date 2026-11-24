-- A plan made for one thing asked for on its own ("make a quiz on chapter 3",
-- /video ..., a make button): one item, started at once, with no card to
-- approve. Everything downstream (jobs, the Studio, the feed, progress) treats
-- it as any plan; the chat and the Studio show it as the thing it makes.
-- A remake of one (a follow-up such as "make it shorter") points back at the
-- one it was made from through supersedes_plan_id. Additive only.
ALTER TABLE plans ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;
