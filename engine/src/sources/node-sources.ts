/**
 * The August pipeline read exactly one source envelope. A plan item may have
 * several sources, each possibly narrowed to a range; this folds them into
 * the one envelope the prompts and evidence checks expect.
 */
import { depthRank, type ByteDepth } from "../cards/blocks";
import type { NodeSource, SourceChunk, SourceLocator } from "../studio/types";
import type { AccessLevel, SourceEnvelope } from "../types/source";

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, metadata: 1, partial: 2, full: 3 };

/** The text an item sees of one source: the whole extraction, or the chunks inside its range. */
export function sourceText(source: NodeSource): string {
  if (!source.range || source.chunks.length === 0) return source.envelope.text;
  return chunksInRange(source)
    .map((chunk) => chunk.text)
    .join("\n\n");
}

/** The source's chunks an item sees, in order: all of them, or those inside its range. */
export function chunksInRange(source: NodeSource): SourceChunk[] {
  const inside = source.range ? source.chunks.filter((chunk) => overlaps(chunk, source.range!)) : [...source.chunks];
  return inside.sort((a, b) => a.ord - b.ord);
}

export function mergeNodeSources(sources: NodeSource[]): SourceEnvelope {
  if (sources.length === 0) throw new Error("A byte needs at least one source.");
  if (sources.length === 1) {
    const [only] = sources;
    return only.range ? { ...only.envelope, text: sourceText(only) } : only.envelope;
  }

  const envelopes = sources.map((source) => source.envelope);
  const [first] = envelopes;
  const references = new Map<string, SourceEnvelope["references"][number]>();
  for (const envelope of envelopes) {
    for (const reference of envelope.references) if (!references.has(reference.url)) references.set(reference.url, reference);
  }
  const assets = envelopes.flatMap((envelope) => envelope.assets ?? []);
  const kinds = new Set(envelopes.map((envelope) => envelope.kind));
  return {
    // One source is "the" source for URL-based checks; the others are
    // reachable through their references.
    ...first,
    originalText: envelopes.map((envelope) => envelope.originalText).join("\n\n"),
    kind: kinds.size === 1 ? first.kind : "text",
    title: undefined,
    text: sources
      .map((source, index) => `Source ${index + 1}${source.envelope.title ? `: ${source.envelope.title}` : ""}\n${sourceText(source)}`)
      .join("\n\n"),
    references: [...references.values()],
    ...(assets.length > 0 ? { assets } : {}),
    metadata: {},
    accessLevel: envelopes.reduce<AccessLevel>(
      (best, envelope) => (ACCESS_RANK[envelope.accessLevel] > ACCESS_RANK[best] ? envelope.accessLevel : best),
      "none",
    ),
    depthCap: envelopes.reduce<ByteDepth>(
      (best, envelope) => (depthRank(envelope.depthCap) > depthRank(best) ? envelope.depthCap : best),
      "saveOnly",
    ),
    limitations: [...new Set(envelopes.flatMap((envelope) => envelope.limitations))],
  };
}

function overlaps(chunk: SourceChunk, range: SourceLocator): boolean {
  const at = chunk.locator;
  if (!at) return false;
  if (range.page !== undefined) return spansOverlap(at.page, at.endPage, range.page, range.endPage);
  if (range.slide !== undefined) return spansOverlap(at.slide, at.endSlide, range.slide, range.endSlide);
  if (range.startMs !== undefined || range.endMs !== undefined) {
    const start = range.startMs ?? 0;
    const end = range.endMs ?? Number.POSITIVE_INFINITY;
    const chunkStart = at.startMs ?? at.endMs;
    const chunkEnd = at.endMs ?? at.startMs;
    return chunkStart !== undefined && chunkEnd !== undefined && chunkStart < end && chunkEnd > start;
  }
  if (range.charStart !== undefined || range.charEnd !== undefined) {
    const start = range.charStart ?? 0;
    const end = range.charEnd ?? Number.POSITIVE_INFINITY;
    return at.charStart !== undefined && at.charEnd !== undefined && at.charStart < end && at.charEnd > start;
  }
  if (range.cell !== undefined) return at.cell === range.cell;
  return true;
}

/** Inclusive spans `start..end`; a missing end is the one page or slide. */
function spansOverlap(start: number | undefined, end: number | undefined, rangeStart: number, rangeEnd: number | undefined): boolean {
  if (start === undefined) return false;
  return start <= (rangeEnd ?? rangeStart) && (end ?? start) >= rangeStart;
}
