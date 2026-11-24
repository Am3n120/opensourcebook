import type { Json } from "../api/types";

/** Where a cite opens: its source at the cited passage (`at`), with its words marked when it names them. */
export function citeLink(sourceId: string, quote?: string, locator?: { charStart?: number; charEnd?: number }): string {
  const params = new URLSearchParams();
  if (locator?.charStart !== undefined && locator.charEnd !== undefined) params.set("at", `${locator.charStart}-${locator.charEnd}`);
  if (quote) params.set("quote", quote);
  return `/sources/${encodeURIComponent(sourceId)}${params.size ? `?${params}` : ""}`;
}

/** A field of a kept progress (engine/docs/api.md, "Item"), when it is there and of the right kind. */
export function progressField<T>(progress: Json | undefined, key: string, is: (v: unknown) => v is T): T | undefined {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return undefined;
  const value = (progress as Record<string, unknown>)[key];
  return is(value) ? value : undefined;
}

export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
