/**
 * Cuts an extraction into citable passages (`source_chunks`). Each chunk
 * carries a SourceLocator so a citation or an item's range can point at it.
 *
 * Every chunk is located by character range. When the text carries page
 * breaks (`PAGE_BREAK`, which the PDF ladder writes between pages), no chunk
 * crosses one and each also carries its `page`. Transcripts are still cleaned
 * into prose without timestamps; a ladder that keeps other boundaries
 * supplies its own `Chunker`, and nothing else changes.
 */
import type { NewChunk } from "../studio/repositories/sources";
import type { SourceEnvelope } from "../types/source";


export type Chunker = (envelope: SourceEnvelope) => NewChunk[];

export interface ChunkOptions {
  /** A chunk closes once it reaches this size at a paragraph break. */
  targetChars?: number;
  /** No chunk is longer than this; a longer paragraph is cut at a sentence end or a space. */
  maxChars?: number;
}

const DEFAULT_TARGET_CHARS = 1_200;
const DEFAULT_MAX_CHARS = 2_000;

export const chunkEnvelope: Chunker = (envelope) => chunkText(envelope.text);

/**
 * Paragraph-aligned chunks of `text`, each with `charStart`/`charEnd` into it,
 * and its `page` when the text has page breaks.
 */
export function chunkText(text: string, options: ChunkOptions = {}): NewChunk[] {
  const target = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const max = Math.max(target, options.maxChars ?? DEFAULT_MAX_CHARS);
  if (!text.includes("\f")) return chunkSpan(text, { start: 0, end: text.length }, target, max);
  const chunks: NewChunk[] = [];
  let start = 0;
  let page = 1;
  for (let at = text.indexOf("\f"); ; at = text.indexOf("\f", start)) {
    const end = at < 0 ? text.length : at;
    chunks.push(...chunkSpan(text, { start, end }, target, max, page));
    if (at < 0) break;
    start = at + 1;
    page += 1;
  }
  return chunks;
}

function chunkSpan(text: string, within: Span, target: number, max: number, page?: number): NewChunk[] {
  const pieces = paragraphs(text, within).flatMap((span) => splitLong(text, span, max));

  const chunks: NewChunk[] = [];
  let open: Span | undefined;
  const close = () => {
    if (!open) return;
    chunks.push({ text: text.slice(open.start, open.end), locator: { ...(page !== undefined ? { page } : {}), charStart: open.start, charEnd: open.end } });
    open = undefined;
  };
  for (const piece of pieces) {
    if (open && piece.end - open.start > max) close();
    open = open ? { start: open.start, end: piece.end } : piece;
    if (open.end - open.start >= target) close();
  }
  close();
  return chunks;
}

interface Span {
  start: number;
  end: number;
}

/** Non-blank runs of text between blank lines inside `within`, trimmed, as offsets into `text`. */
function paragraphs(text: string, within: Span): Span[] {
  const spans: Span[] = [];
  const part = text.slice(within.start, within.end);
  const pattern = /\S[\s\S]*?(?=\n\s*\n|\s*$)/g;
  for (let match = pattern.exec(part); match; match = pattern.exec(part)) {
    spans.push({ start: within.start + match.index, end: within.start + match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return spans;
}

/** Cuts a span longer than `max` at the last sentence end, else the last space, else hard. */
function splitLong(text: string, span: Span, max: number): Span[] {
  const out: Span[] = [];
  let start = span.start;
  while (span.end - start > max) {
    const window = text.slice(start, start + max);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    const space = window.lastIndexOf(" ");
    const cut = sentence > max / 2 ? sentence + 1 : space > max / 2 ? space : max;
    out.push({ start, end: start + cut });
    start += cut;
    while (start < span.end && /\s/.test(text[start])) start += 1;
  }
  if (start < span.end) out.push({ start, end: span.end });
  return out;
}
