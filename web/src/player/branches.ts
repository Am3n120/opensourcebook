import type { JsonObject } from "../api/types";
import type { Branch } from "./players";

/**
 * The branches a result takes: each whose condition reads a number in the
 * result (`{ metric, below }` or `{ metric, atLeast }`, engine/docs/api.md)
 * and holds for it. Any other kind (ask me) is the person's to answer, so it
 * is never said to be taken.
 */
export function branchesTaken(branches: readonly Branch[] | undefined, result: JsonObject): Branch[] {
  return (branches ?? []).filter((b) => holds(b.condition as JsonObject, result));
}

function holds(c: JsonObject, result: JsonObject): boolean {
  if (typeof c.metric !== "string") return false;
  const value = result[c.metric];
  if (typeof value !== "number") return false;
  if (typeof c.below === "number") return value < c.below;
  if (typeof c.atLeast === "number") return value >= c.atLeast;
  return false;
}

/** Why a taken branch was taken: "you scored under 70%". A score is a share from 0 to 1, said as a percentage. */
export function becauseWords(condition: Branch["condition"]): string {
  const c = condition as JsonObject;
  const pct = (v: number) => (c.metric === "score" && v >= 0 && v <= 1 ? `${Math.round(v * 100)}%` : undefined);
  if (typeof c.below === "number") {
    const p = pct(c.below);
    return p ? `you scored under ${p}` : `${String(c.metric)} was below ${c.below}`;
  }
  if (typeof c.atLeast === "number") {
    const p = pct(c.atLeast);
    return p ? `you scored ${p} or more` : `${String(c.metric)} was ${c.atLeast} or more`;
  }
  return "of your result";
}
