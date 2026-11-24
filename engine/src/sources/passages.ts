/**
 * The passages an item may cite or test: the item's sources cut into citable pieces.
 * A source's stored chunks (`source_chunks`) are used as they are, inside
 * the item's range; a source with none is cut here with the same chunker,
 * and its passages cite by character range with no chunk id.
 *
 * Prompts name passages by a short label (P1, P2, ...) in a fixed order, so
 * the same context always gives the same labels; the blueprint and payload
 * keep the passage id, which does not move.
 */
import { labelReader } from "../../../common/labels";
import { chunkText } from "./chunk";
import type { NodeSource, SourceLocator } from "../studio/types";
import { chunksInRange } from "./node-sources";

export interface Passage {
  /** The chunk id, or `<sourceId>@<charStart>-<charEnd>` for a source without stored chunks. */
  id: string;
  label: string;
  sourceId: string;
  sourceTitle?: string;
  chunkId?: string;
  locator?: SourceLocator;
  text: string;
}

export function buildPassages(sources: NodeSource[]): Passage[] {
  const passages: Passage[] = [];
  for (const source of sources) {
    const title = source.title?.trim() || source.envelope.title?.trim() || undefined;
    const base = { sourceId: source.sourceId, ...(title ? { sourceTitle: title } : {}) };
    if (source.chunks.length > 0) {
      for (const chunk of chunksInRange(source)) {
        if (!chunk.text.trim()) continue;
        passages.push({ ...base, id: chunk.id, label: "", chunkId: chunk.id, ...(chunk.locator ? { locator: chunk.locator } : {}), text: chunk.text });
      }
      continue;
    }
    for (const chunk of chunkText(source.envelope.text)) {
      const locator = chunk.locator ?? {};
      if (!chunk.text.trim() || !insideCharRange(locator, source.range)) continue;
      passages.push({ ...base, id: `${source.sourceId}@${locator.charStart ?? 0}-${locator.charEnd ?? chunk.text.length}`, label: "", locator, text: chunk.text });
    }
  }
  return passages.map((passage, position) => ({ ...passage, label: `P${position + 1}` }));
}

function insideCharRange(at: SourceLocator, range: SourceLocator | undefined): boolean {
  if (!range || (range.charStart === undefined && range.charEnd === undefined)) return true;
  const start = range.charStart ?? 0;
  const end = range.charEnd ?? Number.POSITIVE_INFINITY;
  return at.charStart !== undefined && at.charEnd !== undefined && at.charStart < end && at.charEnd > start;
}

/** Text compared for quotes and duplicates: case, spacing, quote marks and dashes do not matter. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears in the passage word for word (after `normalizeText`). */
export function quoteInPassage(quote: string, passage: Passage): boolean {
  const needle = normalizeText(quote);
  return needle.length > 0 && normalizeText(passage.text).includes(needle);
}

/** The longest a cited spot grows to when it is widened to whole sentences. */
export const MAX_CITE_SPOT = 400;

const SENTENCE_END_BEFORE = /(?:[.!?]+["”’)\]]*\s+|\n)(?![\s\S]*(?:[.!?]+["”’)\]]*\s+|\n))/;
const SENTENCE_END_AFTER = /[.!?]+["”’)\]]*(?=\s|$)|\n/;
/** Markdown marks at the start of a line (a heading, list or quote mark), not part of the sentence. */
const LINE_MARKS = /^(?:\s+|#{1,6}\s+|[-*+]\s+|>\s*|\d{1,3}[.)]\s+)+/;

/**
 * A checked quote widened to the whole sentences it sits in, so the spot a
 * reader highlights starts and ends on a sentence: still the passage's own
 * words, still passing `quoteInPassage`, and at most `MAX_CITE_SPOT`
 * characters (it widens only as far as fits; a quote already longer stays
 * as it is). A quote not found in the passage comes back unchanged.
 */
export function sentenceSpot(quote: string, passage: Passage): string {
  const text = passage.text;
  const at = locateQuote(quote, text);
  if (!at) return quote;
  const [start, end] = at;
  const before = SENTENCE_END_BEFORE.exec(text.slice(0, start));
  let wideStart = before ? before.index + before[0].length : 0;
  const marks = LINE_MARKS.exec(text.slice(wideStart, start));
  if (marks) wideStart += marks[0].length;
  const endsSentence = /[.!?]["”’)\]]*$/.test(text.slice(start, end));
  const after = endsSentence ? undefined : SENTENCE_END_AFTER.exec(text.slice(end));
  const wideEnd = endsSentence ? end : after ? end + after.index + (after[0] === "\n" ? 0 : after[0].length) : text.length;
  const fits = ([from, to]: [number, number]) => to - from <= MAX_CITE_SPOT;
  const span = ([[wideStart, wideEnd], [start, wideEnd], [wideStart, end]] as Array<[number, number]>).find(fits);
  if (!span) return quote;
  const spot = text.slice(span[0], span[1]).trim();
  return spot.length >= quote.length && quoteInPassage(spot, passage) ? spot : quote;
}

/** Where `quote` sits in `text`, compared as `normalizeText` does: [start, end) in `text`, or undefined. */
function locateQuote(quote: string, text: string): [number, number] | undefined {
  const needle = normalizeText(quote);
  if (!needle) return undefined;
  // The text normalized character by character, each kept character pointing back at its place.
  let flat = "";
  const from: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (flat.endsWith(" ")) continue;
      flat += " ";
      from.push(index);
      continue;
    }
    const lower = normalizeText(char) || char;
    for (const piece of lower) {
      flat += piece;
      from.push(index);
    }
  }
  const found = flat.indexOf(needle);
  if (found < 0) return undefined;
  return [from[found]!, from[found + needle.length - 1]! + 1];
}

/** Passages rendered for a prompt, each under its label and source. */
export function renderPassages(passages: Passage[]): string {
  return passages
    .map((passage) => `[${passage.label}] ${passage.sourceTitle ? `(${passage.sourceTitle}) ` : ""}\n${passage.text.trim()}`)
    .join("\n\n");
}

/**
 * What in text a person reads points at the material only the writer saw ("P4 says", "as passage 2 says", "the
 * excerpt above"): the item's own labels and passage ids, and any label word used as a pointer, by Open Sourcebook's one check
 * (`common/labels.ts`, the same the scenes service answers write_beat with). A word used as ordinary vocabulary ("final
 * passage of the bill") and anything the sources themselves use in the same sense (a "P4" visa, an exam's "passage 2")
 * is not a leak. `labels` adds labels the writer saw besides the passages' (a video's scene ids).
 */
export function promptLabelLeaks(text: string, passages: Passage[], labels: readonly string[] = []): string[] {
  if (!text) return [];
  return readerFor(passages, labels)(text);
}

const readers = new WeakMap<Passage[], Map<string, (text: string) => string[]>>();

/** One reader per item's passages (and extra labels), so the sources are read once however many strings are checked. */
function readerFor(passages: Passage[], labels: readonly string[]): (text: string) => string[] {
  let byLabels = readers.get(passages);
  if (!byLabels) readers.set(passages, (byLabels = new Map()));
  const key = labels.join("\n");
  let reader = byLabels.get(key);
  if (!reader) {
    const handed = [...passages.flatMap((passage) => [passage.label, passage.id]), ...labels];
    reader = labelReader(handed, passages.map((passage) => passage.text).join("\n"));
    byLabels.set(key, reader);
  }
  return reader;
}

/** Every string in a value a person reads, with its path; keys a person never reads (`skip`) are left out. */
export function learnerStrings(value: unknown, path: string, skip: ReadonlySet<string>): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry, position) => learnerStrings(entry, `${path}[${position}]`, skip));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => (skip.has(key) || /url$/i.test(key) ? [] : learnerStrings(entry, `${path}.${key}`, skip)));
  }
  return [];
}

/**
 * One line per source whose text was cut (`capSourceText`), for writers: how
 * much of it the passages are, so nothing is written as if they were the
 * whole source. Empty when nothing was cut.
 */
export function cutNotes(sources: NodeSource[]): string[] {
  return sources
    .filter((source) => source.envelope.metadata?.textCut === "true")
    .map((source) => {
      const title = source.title?.trim() || source.envelope.title?.trim() || "A source";
      const used = Number(source.envelope.metadata.textUsedChars) || source.envelope.text.length;
      const full = Number(source.envelope.metadata.textChars);
      return `"${title}" was cut: its passages are only the first ${used.toLocaleString("en-US")} of ${full ? full.toLocaleString("en-US") : "more"} characters. Do not write as if they were the whole source, and do not guess what the rest says.`;
    });
}
