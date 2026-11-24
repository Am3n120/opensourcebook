/** Helpers formats share to say how big a made output is (`FormatDefinition.size`). */
import type { MadeSize } from "./types";

/** A count of things in the format's own word, singular for one or less (half a page); undefined for none. */
export function countSize(count: number, singular: string, plural: string): MadeSize | undefined {
  return Number.isFinite(count) && count > 0 ? { count, unit: count <= 1 ? singular : plural } : undefined;
}

/** How long something plays: whole minutes from a minute on, else seconds; undefined when the length is not known. */
export function playingSize(durationMs: unknown): MadeSize | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return seconds < 60 ? { count: seconds, unit: "s" } : { count: Math.round(seconds / 60), unit: "min" };
}
