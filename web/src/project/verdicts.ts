import type { Verdict } from "../api/types";

/**
 * The groups of a teach-back (engine/docs/api.md, "Reply blocks"), in the
 * order shown, each with its heading and the mark beside its points. The
 * headings are the engine's own words for the block's plain `text`.
 */
export const VERDICT_GROUPS: ReadonlyArray<{ verdict: Verdict; heading: string; mark: string }> = [
  { verdict: "right", heading: "What you got right", mark: "✓" },
  { verdict: "missing", heading: "What you left out", mark: "+" },
  { verdict: "wrong", heading: "What the sources say differently", mark: "✗" },
];
