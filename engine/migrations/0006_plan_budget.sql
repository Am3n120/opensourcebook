-- An optional spending cap for a whole plan, in USD. Start refuses a plan
-- whose estimate is over it, and each item's job is capped at what is left.
-- NULL means no cap. Additive only.
ALTER TABLE plans ADD COLUMN budget_usd REAL;
