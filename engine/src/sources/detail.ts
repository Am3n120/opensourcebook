/**
 * How long a source is, from what reading it already found (engine/docs/api.md,
 * "Source (in lists)"): a PDF's pages, a deck's slides, a workbook's sheets,
 * a video's running time. Nothing is read again for it; a reading that did
 * not count anything says nothing.
 */
import { playingSize } from "../studio/size";

export interface SourceDetail {
  count: number;
  /** As a list shows it after the count, singular or plural to suit it ("pages", "slides", "min"). */
  unit: string;
}

/** The counts readings keep in their metadata, each with its unit; the first one a reading has is its detail. */
const COUNTS: ReadonlyArray<{ key: string; singular: string; plural: string }> = [
  { key: "pageCount", singular: "page", plural: "pages" },
  { key: "slideCount", singular: "slide", plural: "slides" },
  { key: "sheetCount", singular: "sheet", plural: "sheets" },
];

export function sourceDetail(metadata: Record<string, unknown> | undefined): SourceDetail | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  for (const { key, singular, plural } of COUNTS) {
    const count = Number(metadata[key]);
    if (Number.isInteger(count) && count > 0) return { count, unit: count === 1 ? singular : plural };
  }
  return playingSize(durationMs(metadata.durationText));
}

/** A running time written `m:ss` or `h:mm:ss`, as a video link's reading keeps it, in milliseconds. */
function durationMs(text: unknown): number | undefined {
  if (typeof text !== "string" || !/^\d+(?::\d{1,2}){1,2}$/.test(text.trim())) return undefined;
  const seconds = text.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** A reading's metadata as the list query reads it from the stored envelope (a JSON object, or nothing). */
export function metadataFromJson(json: string | null | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
