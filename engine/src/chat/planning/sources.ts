/**
 * The sources a planner may use, as it sees them: each under a short label
 * (S1, S2, ...) with its passages numbered from 1, and a short preview of
 * each so it can cut the material into items. The planner names a range as
 * passage numbers; this file turns them into the `SourceLocator` an item's
 * range stores, from the passages' own locators, so the planner never
 * writes a locator itself.
 */
import { chunksInRange } from "../../sources/node-sources";
import type { NodeSource, SourceChunk, SourceLocator } from "../../studio/types";
import type { TurnSource } from "../context";

export interface MappedSource {
  label: string;
  source: TurnSource;
  /** The passages in order; passage n is `chunks[n - 1]`. */
  chunks: SourceChunk[];
}

export class SourceMap {
  readonly entries: MappedSource[];
  private readonly byLabel: Map<string, MappedSource>;
  private readonly byId: Map<string, MappedSource>;

  constructor(sources: TurnSource[]) {
    this.entries = sources.map((source, index) => ({
      label: `S${index + 1}`,
      source,
      // A source mentioned through an item keeps only that item's range.
      chunks: chunksInRange(source),
    }));
    this.byLabel = new Map(this.entries.map((entry) => [entry.label, entry]));
    this.byId = new Map(this.entries.map((entry) => [entry.source.sourceId, entry]));
  }

  get(label: string): MappedSource | undefined {
    return this.byLabel.get(label.trim().toUpperCase());
  }

  bySourceId(sourceId: string): MappedSource | undefined {
    return this.byId.get(sourceId);
  }

  /** The map for a prompt, within about `budgetChars`. */
  render(budgetChars: number, only?: (entry: MappedSource) => boolean): string {
    const shown = only ? this.entries.filter(only) : this.entries;
    const total = shown.reduce((sum, entry) => sum + Math.max(1, entry.chunks.length), 0);
    const perEntry = Math.floor(budgetChars / Math.max(1, total)) - 24;
    // Too many passages for a line each: show runs of them under their first one's preview.
    const group = perEntry >= 60 ? 1 : Math.ceil((total * 84) / Math.max(1, budgetChars));
    const preview = Math.min(240, Math.max(60, perEntry * group));
    const blocks: string[] = [];
    for (const entry of shown) {
      const chars =entry.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) || entry.source.envelope.text.length;
      const head = `${entry.label}: "${entry.source.title ?? "Untitled"}" (${entry.source.kind}, ${entry.chunks.length} passages, ${chars} characters)`;
      const lines: string[] = [];
      for (let start = 0; start < entry.chunks.length; start += group) {
        const end = Math.min(entry.chunks.length, start + group);
        const at = where(entry.chunks[start].locator);
        const text = entry.chunks[start].text.replace(/\s+/g, " ").trim();
        lines.push(`  #${start + 1}${end - start > 1 ? `–${end}` : ""}${at ? ` (${at})` : ""}: ${text.slice(0, preview)}${text.length > preview ? "…" : ""}`);
      }
      blocks.push([head, ...lines].join("\n"));
    }
    return blocks.join("\n\n");
  }

  /**
   * An item's source as stored: the source id, and a range when the planner
   * named passages short of the whole source. A message when the label or
   * the numbers are wrong.
   */
  resolve(ref: { source: string; from?: number; to?: number }): { sourceId: string; range?: SourceLocator } | string {
    const entry = this.get(ref.source);
    if (!entry) return `source "${ref.source}" is not one of ${this.entries.map((known) => known.label).join(", ") || "the listed sources"}`;
    const count = entry.chunks.length;
    const from = ref.from ?? 1;
    const to = ref.to ?? count;
    if (ref.from === undefined && ref.to === undefined) return wholeOrNarrowed(entry);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) {
      return `${entry.label} passages must be whole numbers from 1 to ${count}, from ≤ to (got ${ref.from ?? "start"}–${ref.to ?? "end"})`;
    }
    if (from === 1 && to === count) return wholeOrNarrowed(entry);
    const range = spanOf(entry.chunks.slice(from - 1, to));
    return range ? { sourceId: entry.source.sourceId, range } : { sourceId: entry.source.sourceId };
  }

  /** The passage numbers a stored range covers, for showing an existing item to the planner. */
  passagesOf(sourceId: string, range: SourceLocator | undefined): string {
    const entry = this.bySourceId(sourceId);
    if (!entry) return `a source not in this turn (${sourceId})`;
    if (!range) return entry.label;
    const inside = chunksInRange({ ...(entry.source as NodeSource), range });
    if (inside.length === 0) return entry.label;
    const first = entry.chunks.indexOf(inside[0]) + 1;
    const last = entry.chunks.indexOf(inside[inside.length - 1]) + 1;
    return first > 0 && last > 0 ? `${entry.label} #${first}–${last}` : entry.label;
  }
}

/** A source used whole; one the turn read through an item's range keeps that range. */
function wholeOrNarrowed(entry: MappedSource): { sourceId: string; range?: SourceLocator } {
  return entry.source.range ? { sourceId: entry.source.sourceId, range: entry.source.range } : { sourceId: entry.source.sourceId };
}

/** The smallest locator that covers these passages, in the unit their locators share. */
export function spanOf(chunks: SourceChunk[]): SourceLocator | undefined {
  const at = chunks.map((chunk) => chunk.locator ?? {});
  const all = (key: keyof SourceLocator) => at.every((locator) => locator[key] !== undefined);
  const nums = (key: keyof SourceLocator, fallback: keyof SourceLocator) => at.map((locator) => (locator[key] ?? locator[fallback]) as number);
  if (all("page")) return { page: Math.min(...nums("page", "page")), endPage: Math.max(...nums("endPage", "page")) };
  if (all("slide")) return { slide: Math.min(...nums("slide", "slide")), endSlide: Math.max(...nums("endSlide", "slide")) };
  if (all("startMs") && all("endMs")) return { startMs: Math.min(...nums("startMs", "startMs")), endMs: Math.max(...nums("endMs", "endMs")) };
  if (all("charStart") && all("charEnd")) return { charStart: Math.min(...nums("charStart", "charStart")), charEnd: Math.max(...nums("charEnd", "charEnd")) };
  return undefined;
}

/** How a passage's place reads in a preview. */
export function where(locator: SourceLocator | undefined): string {
  if (!locator) return "";
  if (locator.page !== undefined) return `page ${locator.page}${locator.endPage && locator.endPage !== locator.page ? `–${locator.endPage}` : ""}`;
  if (locator.slide !== undefined) return `slide ${locator.slide}`;
  if (locator.startMs !== undefined) return `${clock(locator.startMs)}${locator.endMs !== undefined ? `–${clock(locator.endMs)}` : ""}`;
  if (locator.cell) return `cell ${locator.cell}`;
  return "";
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Characters an item reads of a source, after its range. */
export function charsIn(source: NodeSource, range: SourceLocator | undefined): number {
  if (source.chunks.length === 0) return source.envelope.text.length;
  return chunksInRange({ ...source, range }).reduce((sum, chunk) => sum + chunk.text.length, 0);
}
