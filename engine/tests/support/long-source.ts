/**
 * A long source made in the test, never a committed file: numbered parts of
 * plain sentences, each part carrying one fact found nowhere else, so a test
 * can tell which part of the source a call read.
 */
import { chunkText } from "../../src/sources/chunk";
import type { NodeSource, SourceChunk } from "../../src/studio/types";
import { PAGE_BREAK, type SourceEnvelope } from "../../src/types/source";

export interface LongSourceOptions {
  /** About how many characters; the text is whole parts, so it ends near this. */
  chars: number;
  /** Characters per part (about). */
  partChars?: number;
  /** Put a page break between parts, as the PDF ladder does. */
  pages?: boolean;
  sourceId?: string;
  title?: string;
}

/** The sentence only part `n` says. */
export function factOf(n: number): string {
  return `The marker for part ${n} is tern${n}quill.`;
}

export function longText(options: LongSourceOptions): string {
  const partChars = options.partChars ?? 4_000;
  const parts: string[] = [];
  let length = 0;
  for (let n = 1; length < options.chars; n += 1) {
    const filler = `Part ${n} goes on about its own matter in plain words. `;
    const paragraphs: string[] = [];
    let size = 0;
    for (let p = 0; size < partChars; p += 1) {
      const paragraph = (p === 1 ? `${factOf(n)} ` : "") + filler.repeat(6).trim();
      paragraphs.push(paragraph);
      size += paragraph.length + 2;
    }
    const part = paragraphs.join("\n\n");
    parts.push(part);
    length += part.length;
  }
  return parts.join(options.pages ? PAGE_BREAK : "\n\n");
}

export function longEnvelope(options: LongSourceOptions): SourceEnvelope {
  const text = longText(options);
  return {
    originalText: "",
    originalURL: "https://example.com/long",
    canonicalURL: "https://example.com/long",
    kind: "article",
    title: options.title ?? "A long source",
    text,
    references: [{ url: "https://example.com/long", domain: "example.com", label: "source" }],
    metadata: {},
    accessLevel: "full",
    depthCap: "veryDeep",
    limitations: [],
    fetchedAt: "2026-11-13T00:00:00.000Z",
  };
}

/** A node source with stored chunks, as the runner loads it. */
export function longNodeSource(options: LongSourceOptions): NodeSource {
  const envelope = longEnvelope(options);
  const sourceId = options.sourceId ?? "src-long";
  const chunks: SourceChunk[] = chunkText(envelope.text).map((chunk, ord) => ({ id: `${sourceId}-c${ord}`, ord, text: chunk.text, ...(chunk.locator ? { locator: chunk.locator } : {}) }));
  return { sourceId, envelope, chunks };
}
