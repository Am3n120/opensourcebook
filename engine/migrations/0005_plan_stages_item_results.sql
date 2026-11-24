-- Plan schema additions (docs/VISION.md "The plan", docs/DECISIONS.md #26-28).
-- Additive only: no table or column in 0004 is renamed or changed. On screen a
-- plan node is an "item" and a level is a "stage" (docs/GLOSSARY.md).

-- An optional free-text label for a stage. A stage with no row has no label;
-- the stage itself is still plan_nodes.level. Labels are display only, so
-- they may change after Start like a plan's title.
CREATE TABLE plan_stages (
  plan_id TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  level   INTEGER NOT NULL,
  label   TEXT NOT NULL,
  PRIMARY KEY (plan_id, level)
);

-- What the person did with an item: the done tick and the result a branch
-- condition or a later item's input reads. One row per item.
--   done_at:     set when the person finished or swiped past the item; NULL
--                when it is not ticked (a row may hold a result without a
--                tick, such as the answer to an "ask me" branch).
--   result_json: whatever the item's player reports, e.g. a check's score
--                and what was missed. Its shape belongs to the format.
--   output_id:   the output the person went through, when known
--                (regenerating an item adds an output; the newest wins).
CREATE TABLE item_results (
  node_id     TEXT PRIMARY KEY REFERENCES plan_nodes (id) ON DELETE CASCADE,
  output_id   TEXT REFERENCES outputs (id) ON DELETE SET NULL,
  done_at     TEXT,
  result_json TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
