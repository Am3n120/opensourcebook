-- A day a stage is meant to be gone through by, when the person gives one
-- ("quiz me on chapter 2 by Friday"). A calendar day with no time or zone,
-- YYYY-MM-DD, as the person's own calendar has it; the app that shows it
-- says which day is today. A stage with no row has no date, which is most
-- stages: a plan is ordered, not scheduled, unless the person asks.
-- Like a label, a date is display and reminders only: it never changes what
-- is made or in what order, so it may change after Start (missed days are
-- moved on). Additive only.
CREATE TABLE plan_stage_dates (
  plan_id TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  level   INTEGER NOT NULL,
  due_on  TEXT NOT NULL,
  PRIMARY KEY (plan_id, level)
);
