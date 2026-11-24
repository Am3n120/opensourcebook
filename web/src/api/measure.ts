import { kindWord } from "../sources/kindWords";
import type { Measure, Source } from "./types";

/** "12 cards": what the engine counted, in its own words. Nothing when it did not count. */
export function measureText(measure: Measure | undefined): string | undefined {
  return measure ? `${measure.count} ${measure.unit}` : undefined;
}

/** What a source is, and how long it is once the engine has read that ("PDF · 24 pages"); the kind alone when it counted nothing. */
export function sourceKind(source: Pick<Source, "kind" | "detail">): string {
  return [kindWord(source.kind), measureText(source.detail)].filter(Boolean).join(" · ");
}
