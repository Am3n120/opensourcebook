/**
 * What part of an item's passages one model call reads
 * (engine/docs/long-sources.md). A long source is stored whole; what keeps a
 * call small is choosing what it reads:
 *
 *   parts   the passages in order, in runs of about `PART_CHARS`, never
 *           across two sources and, where passages have pages, closing at a
 *           page turn when one is near.
 *   map     one line per part: its labels, pages, size and opening words,
 *           for a call that plans over the whole item without reading it.
 *   spread  passages taken evenly across all of them to fit a budget, so
 *           every part is represented rather than the first ones.
 *
 * Nothing here looks at the kind of source or its subject; structure comes
 * from the passages' own places (pages) or from the length of the text.
 */
import type { Passage } from "./passages";

/** A call reads every passage when they come to this or less (what a source used to be cut to). */
export const WHOLE_READ_CHARS = 24_000;
/** About how much text one part of a map stands for. */
export const PART_CHARS = 8_000;
/** About how long a map may be. */
export const MAP_CHARS = 12_000;

export interface Part {
  passages: Passage[];
  chars: number;
  sourceTitle?: string;
  /** First and last page, when the passages have pages. */
  pages?: { first: number; last: number };
}

export function charsOf(passages: Passage[]): number {
  return passages.reduce((sum, passage) => sum + passage.text.length, 0);
}

/** True when the passages are more than one call reads whole. */
export function isLong(passages: Passage[], budget = WHOLE_READ_CHARS): boolean {
  return charsOf(passages) > budget;
}

/** The passages in parts of about `partChars`, in order. */
export function partsOf(passages: Passage[], partChars = PART_CHARS): Part[] {
  const parts: Part[] = [];
  let open: Passage[] = [];
  let chars = 0;
  const close = () => {
    if (open.length === 0) return;
    const pages = open.map((passage) => passage.locator?.page).filter((page): page is number => page !== undefined);
    parts.push({
      passages: open,
      chars,
      ...(open[0].sourceTitle ? { sourceTitle: open[0].sourceTitle } : {}),
      ...(pages.length === open.length ? { pages: { first: Math.min(...pages), last: Math.max(...open.map((passage) => passage.locator?.endPage ?? passage.locator!.page!)) } } : {}),
    });
    open = [];
    chars = 0;
  };
  for (const passage of passages) {
    const last = open[open.length - 1];
    if (last) {
      const newSource = last.sourceId !== passage.sourceId;
      const pageTurn = last.locator?.page !== undefined && passage.locator?.page !== undefined && passage.locator.page !== last.locator.page;
      const full = chars + passage.text.length > partChars;
      // Near the size, a page turn is the place to close.
      if (newSource || full || (pageTurn && chars >= partChars * 0.6)) close();
    }
    open.push(passage);
    chars += passage.text.length;
  }
  close();
  return parts;
}

/**
 * The map of the passages for a prompt, within about `budgetChars`: per
 * source, one line per part with its labels, pages, size and a preview of its
 * opening. Labels are the passages' own, so a range named from the map
 * resolves to exactly those passages.
 */
export function renderMap(passages: Passage[], budgetChars = MAP_CHARS, partChars = PART_CHARS): string {
  // Many parts for the budget: make parts bigger rather than previews unreadable.
  const total = charsOf(passages);
  const size = Math.max(partChars, Math.ceil(total / Math.max(1, Math.floor(budgetChars / 160))));
  const parts = partsOf(passages, size);
  const preview = Math.max(80, Math.min(400, Math.floor(budgetChars / Math.max(1, parts.length)) - 70));
  const lines: string[] = [];
  let title: string | undefined | null = null;
  for (const part of parts) {
    if (part.sourceTitle !== title) {
      title = part.sourceTitle;
      lines.push(`Source${title ? ` "${title}"` : ""}:`);
    }
    const first = part.passages[0].label;
    const last = part.passages[part.passages.length - 1].label;
    const pages = part.pages ? (part.pages.first === part.pages.last ? `page ${part.pages.first}, ` : `pages ${part.pages.first}–${part.pages.last}, `) : "";
    const text = part.passages.map((passage) => passage.text).join(" ").replace(/\s+/g, " ").trim();
    lines.push(`- ${first === last ? first : `${first}–${last}`} (${pages}${part.chars.toLocaleString("en-US")} characters): ${text.slice(0, preview)}${text.length > preview ? "…" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Passages that fit `budgetChars`: all of them when they fit, else ones
 * taken evenly across all of them, in order, so the start, middle and end
 * are all read.
 */
export function spread(passages: Passage[], budgetChars: number): Passage[] {
  if (charsOf(passages) <= budgetChars) return passages;
  if (passages.length === 0) return [];
  const average = charsOf(passages) / passages.length;
  const want = Math.max(1, Math.min(passages.length, Math.floor(budgetChars / average)));
  const picked = new Set<number>();
  let used = 0;
  for (let step = 0; step < want; step += 1) {
    const index = want === 1 ? 0 : Math.round((step * (passages.length - 1)) / (want - 1));
    if (picked.has(index)) continue;
    const size = passages[index].text.length;
    if (picked.size > 0 && used + size > budgetChars) continue;
    picked.add(index);
    used += size;
  }
  return [...picked].sort((a, b) => a - b).map((index) => passages[index]);
}

/**
 * The passages a range names, in order: "P12-P40", "P12–P40", "P7", or a
 * list of those. Undefined when nothing in it names a known passage.
 */
export function passagesNamed(value: unknown, passages: Passage[]): Passage[] | undefined {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : [];
  const position = new Map(passages.map((passage, index) => [passage.label.toUpperCase(), index]));
  const chosen = new Set<number>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const match = /^\s*(P?\d+)\s*(?:(?:-|–|—|to)\s*(P?\d+))?\s*$/i.exec(entry);
    if (!match) continue;
    const label = (raw: string) => (raw.toUpperCase().startsWith("P") ? raw.toUpperCase() : `P${raw}`);
    const from = position.get(label(match[1]));
    const to = match[2] ? position.get(label(match[2])) : from;
    if (from === undefined || to === undefined) continue;
    for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) chosen.add(index);
  }
  if (chosen.size === 0) return undefined;
  return [...chosen].sort((a, b) => a - b).map((index) => passages[index]);
}

/** Labels as compact ranges, "P1–P9, P14". */
export function labelRanges(shown: Passage[], all: Passage[]): string {
  const position = new Map(all.map((passage, index) => [passage.id, index]));
  const indexes = shown.map((passage) => position.get(passage.id)).filter((index): index is number => index !== undefined).sort((a, b) => a - b);
  const runs: string[] = [];
  for (let start = 0; start < indexes.length; ) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end] + 1) end += 1;
    runs.push(start === end ? all[indexes[start]].label : `${all[indexes[start]].label}–${all[indexes[end]].label}`);
    start = end + 1;
  }
  return runs.join(", ");
}

/**
 * One line for a writer shown a spread rather than every passage it covers,
 * so nothing is written as if every word between them was read. Empty when
 * nothing was left out.
 */
export function spreadNote(shown: Passage[], covered: Passage[]): string {
  if (shown.length >= covered.length) return "";
  return `These ${shown.length} passages are a sample taken evenly across the ${covered.length} this covers (${charsOf(covered).toLocaleString("en-US")} characters); the ones between them were not shown to you. Write from what is shown, and do not guess what the rest says.`;
}
