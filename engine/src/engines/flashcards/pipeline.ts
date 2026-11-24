/**
 * The deterministic core every maker of a set shares: depth decisions for
 * Open Sourcebook's own writer, plan and section normalization, citations, assembly and
 * clean-up, evidence-URL and grounding checks, media salvage and tags.
 * Provider calls live in engine.ts.
 */
import { dedupeMediaURLs } from "../../dedupe-media";
import { isRecord } from "../../net";
import {
  BYTE_TYPES,
  DEPTH_TARGETS,
  depthRank,
  liftDepthCapForResearch,
  minDepth,
  type ByteBlock,
  type ByteDepth,
  type GenerationDepth,
  type SchemaError,
} from "../../cards/blocks";
import { CARD_SET_SCHEMA_VERSION, cardBlocks, markOf, type Card, type CardBlock, type CardSet, type Cite } from "../../cards/contract";
import { validateCardSet, type CardSetCheck, type CardSetRules } from "../../cards/validate";
import { learnerStrings, promptLabelLeaks, quoteInPassage, type Passage } from "../../sources/passages";
import type { NodeSource } from "../../studio/types";
import type { AssetRef, ResearchResult, SourceEnvelope } from "../../types/source";
import { PipelineError } from "../retry";
import { buildMetadataFromSource } from "./prompts";
import type { DraftCard, SectionDraft, StructurePlan, StructureSection } from "./types";

export function decideDepth(requestedDepth: GenerationDepth, source: SourceEnvelope): ByteDepth {
  // A title and channel are not something to teach from: the byte keeps the link and says why.
  if (onlyMetadata(source)) return "saveOnly";
  if (requestedDepth === "auto") return autoDepth(source);
  const requested = generationDepthToByteDepth(requestedDepth);
  // Research-backed requests (standard and deeper) may reach one tier past the
  // extraction cap: research contributes grounded evidence the source alone
  // does not carry. saveOnly caps are never lifted — see liftDepthCapForResearch.
  const cap = DEPTH_TARGETS[requestedDepth].research ? liftDepthCapForResearch(source.depthCap) : source.depthCap;
  return minDepth(requested, cap);
}

export function generationDepthToByteDepth(depth: Exclude<GenerationDepth, "auto">): ByteDepth {
  switch (depth) {
    case "saveOnly":
      return "saveOnly";
    case "light":
      return "light";
    case "standard":
      return "medium";
    case "deep":
      return "deep";
  }
}

/** How deep a fully readable text of this length can go, before any cap. */
export function depthForTextLength(textLength: number): ByteDepth {
  if (textLength === 0) return "saveOnly";
  if (textLength < 500) return "tiny";
  if (textLength < 2_000) return "light";
  if (textLength < 10_000) return "medium";
  if (textLength < 30_000) return "deep";
  return "veryDeep";
}

export function autoDepth(source: SourceEnvelope): ByteDepth {
  const textLength = source.text.trim().length;
  const evidenceDepth: ByteDepth =
    textLength === 0
      ? "saveOnly"
      : source.accessLevel === "metadata"
        ? "tiny"
        : source.accessLevel === "none"
          ? "saveOnly"
          : depthForTextLength(textLength);
  // An auto pick that lands on a research-enabled depth (medium and up) gets
  // the same one-tier lift past the extraction cap as an explicit request.
  const cap = depthRank(evidenceDepth) >= depthRank("medium") ? liftDepthCapForResearch(source.depthCap) : source.depthCap;
  return minDepth(evidenceDepth, cap);
}

/** True when every source gave only its title and details, or nothing: no text was read. */
export function onlyMetadata(source: SourceEnvelope): boolean {
  return source.accessLevel === "metadata" || source.accessLevel === "none";
}

const MAX_BYTE_TAGS = 8;

/** Well-known hosts read better as a short shelf tag than a bare hostname. */
const DOMAIN_TAG_ALIASES: Readonly<Record<string, string>> = {
  "arxiv.org": "arxiv",
  "github.com": "github",
  "instagram.com": "instagram",
  "reddit.com": "reddit",
  "tiktok.com": "tiktok",
  "wikipedia.org": "wikipedia",
  "youtu.be": "youtube",
  "youtube.com": "youtube",
};

/** Source kinds whose name is a useful shelf tag on its own; recipe reads better as the topic. */
const TYPE_TAG_HINTS: Partial<Record<CardSet["sourceKind"], string>> = {
  meeting: "meeting",
  paper: "paper",
  podcast: "podcast",
  recipe: "cooking",
  spreadsheet: "spreadsheet",
  thread: "thread",
  travel: "travel",
};

/** High-precision content signals — only tags a reader would agree with at a glance. */
const KEYWORD_TAG_HINTS: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: "ai", pattern: /\b(?:artificial intelligence|machine learning|large language models?|llms?)\b/i },
  { tag: "climate", pattern: /\b(?:climate change|global warming|carbon emissions?)\b/i },
  { tag: "programming", pattern: /\b(?:javascript|typescript|golang|kubernetes|python)\b/i },
  { tag: "space", pattern: /\b(?:nasa|spacex|lunar|mars)\b/i },
];

/** Every block of the set, card after card, front then back. */
export function allBlocks(set: CardSet): CardBlock[] {
  return (Array.isArray(set.cards) ? set.cards : []).flatMap((card) => (isRecord(card) ? cardBlocks(card) : []));
}

/**
 * Deterministic tag enrichment. Facts about the byte — its source kind,
 * source domain, and high-precision content keywords — tag first because
 * they cannot hallucinate; model tags fill the remaining slots in their given
 * order. Dedupe is case-insensitive keeping the first spelling, order is
 * stable, and the result is capped so cards stay scannable.
 */
export function enrichTags(byte: CardSet, source: SourceEnvelope): string[] {
  const blocks = allBlocks(byte);
  const derived: string[] = [];
  const typeTag = TYPE_TAG_HINTS[byte.sourceKind];
  if (typeTag) derived.push(typeTag);
  if (byte.sourceKind === "video" && blocks.some((block) => block?.type === "clip")) derived.push("video");
  const domain = domainTagFor(byte, source);
  if (domain) derived.push(domain);
  const sample = tagContentSample(byte, blocks);
  for (const hint of KEYWORD_TAG_HINTS) {
    if (hint.pattern.test(sample)) derived.push(hint.tag);
  }
  const merged: string[] = [];
  const seen = new Set<string>();
  const modelTags = Array.isArray(byte.tags) ? byte.tags : [];
  for (const tag of [...derived, ...modelTags]) {
    const cleaned = cleanString(tag);
    const key = cleaned?.toLowerCase();
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(cleaned);
    if (merged.length >= MAX_BYTE_TAGS) break;
  }
  return merged;
}

/// Hostname-derived shelf tag: an alias for well-known hosts, the bare domain
/// otherwise. Ports and IP literals are not tags.
function domainTagFor(byte: CardSet, source: SourceEnvelope): string | undefined {
  let host = cleanString(byte.sourceDomain) ?? cleanString(source.sourceDomain);
  if (!host && source.originalURL) {
    try {
      host = new URL(source.originalURL).hostname;
    } catch {
      host = undefined;
    }
  }
  const normalized = host?.toLowerCase().replace(/^www\./, "");
  if (!normalized || normalized.includes(":") || /^[\d.]+$/.test(normalized)) return undefined;
  return DOMAIN_TAG_ALIASES[normalized] ?? normalized;
}

/// Title, subtitle, and the byte's own prose — bounded — for keyword matching.
function tagContentSample(byte: CardSet, blocks: ByteBlock[]): string {
  const parts: string[] = [];
  const title = cleanString(byte.title);
  const subtitle = cleanString(byte.subtitle);
  if (title) parts.push(title);
  if (subtitle) parts.push(subtitle);
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text" && block.type !== "heading" && block.type !== "quote") continue;
    const text = cleanString(block.text);
    if (text) parts.push(text);
  }
  return parts.join("\n").slice(0, 2_000);
}

export function buildSetFromSections(source: SourceEnvelope, plan: StructurePlan, sections: SectionDraft[], item: ItemEvidence): CardSet {
  return prepareSet(
    {
      schemaVersion: CARD_SET_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      title: plan.title,
      subtitle: plan.subtitle,
      sourceKind: plan.type,
      ...(plan.sourceDomain ? { sourceDomain: plan.sourceDomain } : {}),
      ...(plan.author ? { author: plan.author } : {}),
      tags: plan.tags,
      ...(plan.excerpt ? { excerpt: plan.excerpt } : {}),
      ...(plan.durationText ? { durationText: plan.durationText } : {}),
      cards: sections.flatMap((section) => section.cards),
    },
    source,
    item,
  );
}

export function normalizeStructurePlan(value: unknown, source: SourceEnvelope): StructurePlan {
  const object = unwrapObject(value);
  const metadata = buildMetadataFromSource(source, inferSourceKind(source));
  const sectionsRaw = Array.isArray(object.sections) ? object.sections : [];
  const sections: StructureSection[] = sectionsRaw
    .map((section, index) => {
      const candidate = unwrapObject(section);
      const id = cleanString(candidate.id) ?? `section-${index + 1}`;
      const title = cleanString(candidate.title) ?? `Section ${index + 1}`;
      const purpose = cleanString(candidate.purpose) ?? "Teach the supported source evidence";
      const suggestedBlocks = Array.isArray(candidate.suggestedBlocks) ? candidate.suggestedBlocks.map(cleanString).filter((entry): entry is string => Boolean(entry)).slice(0, 12) : [];
      const range = (Array.isArray(candidate.passages) ? candidate.passages : [candidate.passages]).map(cleanString).filter((entry): entry is string => Boolean(entry));
      return { id, title, purpose, suggestedBlocks, ...(range.length > 0 ? { range } : {}) };
    })
    .filter((section, index, all) => all.findIndex((candidate) => candidate.id === section.id) === index);
  const type = isByteType(object.type) ? object.type : metadata.type;
  return {
    type,
    title: cleanString(object.title) ?? metadata.title,
    subtitle: cleanString(object.subtitle) ?? metadata.subtitle,
    ...(cleanString(object.sourceDomain) ?? metadata.sourceDomain ? { sourceDomain: cleanString(object.sourceDomain) ?? metadata.sourceDomain } : {}),
    ...(cleanString(object.author) ?? metadata.author ? { author: cleanString(object.author) ?? metadata.author } : {}),
    tags: Array.isArray(object.tags) ? object.tags.map(cleanString).filter((entry): entry is string => Boolean(entry)).slice(0, 20) : metadata.tags,
    ...(cleanString(object.excerpt) ?? metadata.excerpt ? { excerpt: cleanString(object.excerpt) ?? metadata.excerpt } : {}),
    ...(cleanString(object.durationText) ?? metadata.durationText ? { durationText: cleanString(object.durationText) ?? metadata.durationText } : {}),
    sections,
  };
}

/** One section as cards. The writer is asked for `cards`, each with its kind, front, back and cites. */
export function normalizeSectionDraft(value: unknown, section: Pick<StructureSection, "id" | "title">, item: ItemEvidence): SectionDraft {
  const object = unwrapObject(value);
  if (Array.isArray(object.cards)) {
    const cards = object.cards
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && Array.isArray(entry.front))
      .map((entry) => draftToCard(entry as unknown as DraftCard, section.title, item));
    if (cards.length > 0) return { sectionID: section.id, cards };
  }
  throw new PipelineError(`Section ${section.id} did not return a cards array`, "INVALID_SECTION_OUTPUT");
}

/// A section that exhausted its retries: one card that says so plainly, so
/// the set still delivers and the person knows a part is missing.
export function fallbackSectionDraft(section: StructureSection): SectionDraft {
  return {
    sectionID: section.id,
    cards: [
      {
        id: "",
        kind: "explain",
        section: section.title,
        front: [{ type: "text", text: "The cards for this part could not be written; the rest of the set is unaffected." }],
        cites: [],
      },
    ],
  };
}

/** What the engine knows about the item's evidence when it resolves citations. */
export interface ItemEvidence {
  /** Passages by prompt label (P1, P2, ...). */
  passages: Passage[];
  sources: NodeSource[];
}

function draftToCard(draft: DraftCard, section: string | undefined, item: ItemEvidence): Card {
  const front = Array.isArray(draft.front) ? draft.front : [];
  const back = Array.isArray(draft.back) && draft.back.length > 0 ? draft.back : undefined;
  return {
    id: typeof draft.id === "string" ? draft.id : "",
    kind: typeof draft.kind === "string" ? draft.kind : kindFromSides({ front, ...(back ? { back } : {}) }),
    ...(section ? { section } : {}),
    front,
    ...(back ? { back } : {}),
    cites: resolveCites(draft.cites, item, front.length + (back?.length ?? 0)),
  };
}

/** The plainest kind a card's sides make, for a writer that left `kind` out. */
export function kindFromSides(card: Pick<Card, "front" | "back">): string {
  const mark = markOf(card);
  if (mark === "answer") return "ask";
  if (mark === "none") return "explain";
  return card.front.some((block) => block.type === "cloze") ? "cloze" : "recall";
}

/**
 * Cites as a writer gives them ({ passage: "P3", quote, block }) become cites
 * that point at the spot: source, chunk, locator, and `cell` when the passage
 * is a sheet cell. Cites already in the payload shape are kept as they are.
 * An unknown passage label is dropped; a quote is kept as written, so the
 * grounding check can catch one that is not in its passage.
 */
export function resolveCites(raw: unknown, item: ItemEvidence, blockCount: number): Cite[] {
  if (!Array.isArray(raw)) return [];
  const byLabel = new Map(item.passages.map((passage) => [passage.label, passage]));
  const cites: Cite[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const block = Number.isInteger(entry.block) && (entry.block as number) >= 0 && (entry.block as number) < blockCount ? { block: entry.block as number } : {};
    const quote = cleanString(entry.quote);
    if (typeof entry.passage === "string") {
      const passage = byLabel.get(entry.passage.trim());
      if (!passage) continue;
      cites.push({ ...citeOfPassage(passage), ...(quote ? { quote } : {}), ...block });
      continue;
    }
    if (typeof entry.sourceId === "string" && typeof entry.spot === "string") {
      cites.push({
        sourceId: entry.sourceId,
        spot: entry.spot,
        ...(typeof entry.chunkId === "string" ? { chunkId: entry.chunkId } : {}),
        ...(isRecord(entry.locator) ? { locator: entry.locator as Cite["locator"] } : {}),
        ...(typeof entry.assetId === "string" ? { assetId: entry.assetId } : {}),
        ...(quote ? { quote } : {}),
        ...block,
      });
    }
  }
  return cites;
}

function citeOfPassage(passage: Passage): Cite {
  return {
    sourceId: passage.sourceId,
    spot: passage.locator?.cell ? "cell" : "passage",
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.locator && Object.keys(passage.locator).length > 0 ? { locator: passage.locator } : {}),
  };
}

/** The passage a cite points at: by chunk id, or by source and character range. */
export function passageOf(cite: Cite, passages: Passage[]): Passage | undefined {
  if (cite.chunkId) return passages.find((passage) => passage.chunkId === cite.chunkId);
  const at = cite.locator;
  if (at?.charStart === undefined || at.charEnd === undefined) return undefined;
  return passages.find((passage) => passage.id === `${cite.sourceId}@${at.charStart}-${at.charEnd}`);
}

/**
 * Cites the engine can write from the blocks alone: a harvested picture
 * points at its asset (and page), a clip of a recording at its moment. These
 * are exact where today's extraction is exact; nothing is guessed.
 */
export function mediaCites(blocks: ByteBlock[], item: ItemEvidence): Cite[] {
  const assets = new Map<string, { sourceId: string; asset: AssetRef }>();
  const recordings = new Map<string, string>();
  for (const source of item.sources) {
    for (const asset of source.envelope.assets ?? []) assets.set(asset.url, { sourceId: source.sourceId, asset });
    for (const url of [source.envelope.originalURL, source.envelope.canonicalURL]) if (url) recordings.set(urlKey(url), source.sourceId);
  }
  const cites: Cite[] = [];
  const assetCite = (url: string | undefined, block: number) => {
    const found = url ? assets.get(url) : undefined;
    if (!found) return;
    const { asset, sourceId } = found;
    const moment = asset.timestampMs !== undefined;
    cites.push({
      sourceId,
      spot: moment ? "moment" : "image",
      assetId: asset.id,
      ...(moment ? { locator: { startMs: asset.timestampMs } } : asset.page !== undefined ? { locator: { page: asset.page } } : {}),
      block,
    });
  };
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "figure":
      case "image":
      case "labelPicture":
        assetCite(block.url, index);
        break;
      case "gallery":
        for (const image of block.images ?? []) assetCite(image.url, index);
        break;
      case "carousel":
        for (const image of block.items ?? []) assetCite(image.url, index);
        break;
      case "clip": {
        const sourceId = recordings.get(urlKey(block.url));
        if (sourceId) {
          cites.push({
            sourceId,
            spot: "moment",
            locator: { startMs: block.startSeconds * 1000, ...(block.endSeconds !== undefined ? { endMs: block.endSeconds * 1000 } : {}) },
            block: index,
          });
        } else {
          assetCite(block.posterURL, index);
        }
        break;
      }
      default:
        break;
    }
  });
  return cites;
}

/**
 * The model never sees ByteStat.id (it is engine-internal) and often writes
 * `detail` for the schema's `delta` — metrics blocks were therefore invalid by
 * construction and died in validation (observed in production 2026-08-10, an
 * arXiv-HTML byte failed after 2 blind repair attempts). Assign missing ids
 * and fold `detail` into `delta` deterministically, before validation.
 */
export function normalizeMetricsStats(blocks: ByteBlock[]): void {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "metrics" && Array.isArray(block.stats)) {
      for (const stat of block.stats) {
        if (!stat || typeof stat !== "object") continue;
        if (typeof stat.id !== "string" || !stat.id.trim()) stat.id = crypto.randomUUID();
        const record = stat as unknown as Record<string, unknown>;
        if (record.delta === undefined && typeof record.detail === "string") {
          record.delta = record.detail;
        }
        delete record.detail;
      }
    }
    if (block.type === "reveal" && Array.isArray(block.blocks)) normalizeMetricsStats(block.blocks);
  }
}

/** A heading, subheading or kicker that says nothing but the bit's section label. */
function repeatsSection(block: ByteBlock | undefined, section: string): boolean {
  if (!block || (block.type !== "heading" && block.type !== "subheading" && block.type !== "kicker")) return false;
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return typeof block.text === "string" && words(block.text) === words(section);
}

/** Blocks whose text is plain (engine/docs/flashcards.md, "Inline marks"): a writer's ** or * around it is dropped. */
const PLAIN_TEXT_BLOCKS: ReadonlySet<string> = new Set(["kicker", "heading", "subheading"]);

export function stripMarksFromPlainText(blocks: ByteBlock[]): void {
  for (const block of blocks) {
    if (!block || typeof block !== "object" || !PLAIN_TEXT_BLOCKS.has(block.type)) continue;
    const record = block as unknown as { text?: unknown };
    if (typeof record.text === "string") record.text = record.text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1$2");
  }
}

/**
 * Every candidate and every repair answer passes through here: the version
 * and id are set, media appear once across the whole set, stats are
 * normalized, cards with an empty front go, the engine's media cites are
 * added, each card keeps its id (the person's progress is kept by it) and a
 * card without one gets the next free c1, c2, ..., and tags are enriched.
 */
export function prepareSet(value: CardSet, source: SourceEnvelope, item: ItemEvidence, preserveID?: string): CardSet {
  const clone = JSON.parse(JSON.stringify(value)) as CardSet;
  clone.schemaVersion = CARD_SET_SCHEMA_VERSION;
  clone.id = preserveID ?? clone.id;
  delete clone.upgradedFrom;
  // The one-appearance asset rule is enforced deterministically here, on every
  // candidate and repair answer — prompt guidance alone is probabilistic.
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const raw of Array.isArray(clone.cards) ? clone.cards : []) {
    if (!isRecord(raw) || !Array.isArray(raw.front)) continue;
    const front = dedupeMediaURLs(raw.front as ByteBlock[], seen);
    const back = Array.isArray(raw.back) ? dedupeMediaURLs(raw.back as ByteBlock[], seen) : [];
    if (front.length === 0) continue;
    for (const side of [front, back]) {
      normalizeMetricsStats(side);
      stripMarksFromPlainText(side);
    }
    const section = cleanString(raw.section);
    // Players show the section above every card, so a heading that only repeats it is dropped (cites move up with the blocks).
    let rawCites: unknown = raw.cites;
    if (section && front.length > 1 && repeatsSection(front[0], section)) {
      front.shift();
      rawCites = (Array.isArray(rawCites) ? rawCites : []).map((cite: unknown) =>
        isRecord(cite) && typeof cite.block === "number" ? (cite.block === 0 ? { ...cite, block: undefined } : { ...cite, block: cite.block - 1 }) : cite,
      );
    }
    const sides = { front, ...(back.length > 0 ? { back } : {}) };
    const all = cardBlocks(sides);
    const written = resolveCites(rawCites, item, all.length).filter((cite) => cite.spot !== "image" && cite.spot !== "moment");
    cards.push({
      id: typeof raw.id === "string" ? raw.id : "",
      kind: typeof raw.kind === "string" && raw.kind ? raw.kind : kindFromSides(sides),
      ...(section ? { section } : {}),
      ...sides,
      cites: [...written, ...mediaCites(all, item)],
    });
  }
  clone.cards = numberCards(cards);
  // Same philosophy for tags: model tags are creative but unreliable, so the
  // deterministic pass re-runs on every candidate and repair answer.
  clone.tags = enrichTags(clone, source);
  return clone;
}

/** Keeps every card's id that is already c<n> and unique, and gives the rest the next free ones, in order. */
export function numberCards(cards: Card[]): Card[] {
  const taken = new Set<string>();
  const kept = cards.map((card) => {
    const ok = /^c\d+$/.test(card.id) && !taken.has(card.id);
    if (ok) taken.add(card.id);
    return ok ? card.id : undefined;
  });
  let next = 1;
  return cards.map((card, index) => {
    let id = kept[index];
    if (!id) {
      while (taken.has(`c${next}`)) next += 1;
      id = `c${next}`;
      taken.add(id);
    }
    return { ...card, id };
  });
}

/** The next free card id after the ones given. */
export function nextCardNumber(cards: readonly Pick<Card, "id">[]): number {
  return cards.reduce((most, card) => Math.max(most, Number(/^c(\d+)$/.exec(card.id)?.[1] ?? 0)), 0) + 1;
}

/**
 * Everything checkable without the network: the set's contract, evidence
 * URLs per side, and grounding per card (every cite names one of the item's
 * sources, and a quote is in its passage word for word).
 */
export function validateCandidate(set: CardSet, allowedURLs: Set<string>, item: ItemEvidence, rules: CardSetRules = {}): CardSetCheck {
  const check = validateCardSet(set, rules);
  if (!Array.isArray(set?.cards)) return check;
  const errors = [...check.errors];
  const sourceIds = new Set(item.sources.map((source) => source.sourceId));
  set.cards.forEach((card, index) => {
    if (!isRecord(card)) return;
    for (const side of ["front", "back"] as const) {
      const blocks = card[side];
      if (!Array.isArray(blocks)) continue;
      errors.push(...validateEvidenceURLs(blocks, allowedURLs, `$.cards[${index}].${side}`));
      errors.push(...labelLeakErrors(blocks, `$.cards[${index}].${side}`, item.passages));
    }
    if (typeof card.section === "string") errors.push(...labelLeakErrors(card.section, `$.cards[${index}].section`, item.passages));
    if (!Array.isArray(card.cites)) return;
    card.cites.forEach((cite, citeIndex) => {
      const path = `$.cards[${index}].cites[${citeIndex}]`;
      if (!isRecord(cite) || typeof cite.sourceId !== "string") return;
      if (!sourceIds.has(cite.sourceId)) {
        errors.push({ path: `${path}.sourceId`, code: "unknown_source", message: "This cite names a source the item does not have" });
        return;
      }
      if (!cite.quote) return;
      const passage = passageOf(cite, item.passages);
      if (!passage) errors.push({ path, code: "unknown_passage", message: "This cite's quote is not tied to one of the item's passages" });
      else if (!quoteInPassage(cite.quote, passage)) {
        errors.push({ path: `${path}.quote`, code: "quote_not_in_passage", message: `The quote is not in passage ${passage.label} word for word; copy it exactly or drop the quote` });
      }
    });
  });
  return { errors, warnings: check.warnings };
}

/** Block fields that hold ids, styles or addresses, not words a person reads. */
const NOT_READ = new Set(["type", "id", "style", "language", "assetId", "youtubeID", "videoID", "provider"]);

function labelLeakErrors(value: unknown, path: string, passages: Passage[]): SchemaError[] {
  return learnerStrings(value, path, NOT_READ).flatMap(({ path: at, text }) => {
    const leaks = promptLabelLeaks(text, passages);
    return leaks.length === 0
      ? []
      : [{ path: at, code: "names_prompt_label", message: `Names ${leaks.map((term) => `"${term}"`).join(", ")}, words only the writer saw; the learner never sees labelled passages. Say what the source says instead` }];
  });
}

function validateEvidenceURLs(blocks: ByteBlock[], allowedURLs: Set<string>, path: string): SchemaError[] {
  const errors: SchemaError[] = [];
  const youtubeIDs = knownYouTubeIDs(allowedURLs);
  blocks.forEach((block, index) => {
    const blockPath = `${path}[${index}]`;
    if (!block || typeof block !== "object" || typeof block.type !== "string") return;
    if (block.type === "image" && block.url && !allowedURLs.has(urlKey(block.url))) {
      errors.push({ path: `${blockPath}.url`, code: "unapproved_url", message: "Media URL must be present in source or labeled supplemental evidence", expected: "evidence URL", actual: block.url });
    }
    if ((block.type === "audio" || block.type === "linkCard") && !allowedURLs.has(urlKey(block.url))) {
      errors.push({ path: `${blockPath}.url`, code: "unapproved_url", message: "URL must be present in source or labeled supplemental evidence", expected: "evidence URL", actual: block.url });
    }
    if (block.type === "video" && !youtubeIDs.has(block.youtubeID)) {
      errors.push({ path: `${blockPath}.youtubeID`, code: "unapproved_media", message: "YouTube ID must come from an evidence URL", expected: "evidence YouTube ID", actual: block.youtubeID });
    }
    if ((block.type === "figure" || block.type === "labelPicture") && block.url && !allowedURLs.has(urlKey(block.url))) {
      errors.push({ path: `${blockPath}.url`, code: "unapproved_url", message: "Media URL must be present in source or labeled supplemental evidence", expected: "evidence URL", actual: block.url });
    }
    if (block.type === "gallery" && Array.isArray(block.images)) {
      block.images.forEach((image, imageIndex) => {
        if (image && typeof image.url === "string" && !allowedURLs.has(urlKey(image.url))) {
          errors.push({ path: `${blockPath}.images[${imageIndex}].url`, code: "unapproved_url", message: "Media URL must be present in source or labeled supplemental evidence", expected: "evidence URL", actual: image.url });
        }
      });
    }
    if (block.type === "clip") {
      if (block.url && !allowedURLs.has(urlKey(block.url))) {
        errors.push({ path: `${blockPath}.url`, code: "unapproved_url", message: "Clip URL must be the source video URL or labeled supplemental evidence", expected: "evidence URL", actual: block.url });
      }
      if (block.posterURL && !allowedURLs.has(urlKey(block.posterURL))) {
        errors.push({ path: `${blockPath}.posterURL`, code: "unapproved_url", message: "Media URL must be present in source or labeled supplemental evidence", expected: "evidence URL", actual: block.posterURL });
      }
    }
    if (block.type === "reveal" && Array.isArray(block.blocks)) errors.push(...validateEvidenceURLs(block.blocks, allowedURLs, `${blockPath}.blocks`));
  });
  return errors;
}

/** Block types whose URL-bearing payload is media; salvage may strip only these. */
const SALVAGEABLE_MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set(["image", "video", "audio", "figure", "gallery", "clip"]);

interface SalvageOffense {
  container: ByteBlock[];
  index: number;
  block: ByteBlock;
  /** Remaining error path below the block, e.g. ".url" or ".images[2].url". */
  propertyPath: string;
}

/// Resolves a path below a card side's blocks, like [1].blocks[2].url, to the
/// offending block, its parent array, and the failing property below it.
function locateSalvageOffense(blocks: ByteBlock[], path: string): SalvageOffense | undefined {
  let rest = path;
  let container = blocks;
  for (;;) {
    const match = /^\[(\d+)\]/.exec(rest);
    if (!match) return undefined;
    const index = Number(match[1]);
    const block = container[index];
    if (!block || typeof block !== "object") return undefined;
    rest = rest.slice(match[0].length);
    if (rest.startsWith(".blocks[")) {
      if (block.type !== "reveal" || !Array.isArray(block.blocks)) return undefined;
      container = block.blocks;
      rest = rest.slice(".blocks".length);
      continue;
    }
    return { container, index, block, propertyPath: rest };
  }
}

/// Last-chance pass after repair. When every remaining error is an
/// unverifiable URL on a media block, drop exactly those blocks — pruning
/// single images out of galleries and dropping galleries that fall below the
/// 2-image minimum — and any card left with an empty front, so the caller can revalidate
/// once. Cites that pointed at a dropped block go with it. Returns undefined
/// when any error is not media, so real content is never stripped.
export function salvageUnverifiableMedia(set: CardSet, errors: SchemaError[]): { set: CardSet; removed: number } | undefined {
  if (errors.length === 0) return undefined;
  if (!errors.every((entry) => entry.code === "unapproved_url" || entry.code === "unapproved_media")) return undefined;
  const salvaged = JSON.parse(JSON.stringify(set)) as CardSet;
  const offenses = new Map<Card, SalvageOffense[]>();
  for (const entry of errors) {
    const match = /^\$\.cards\[(\d+)\]\.(front|back)(\[.*)$/.exec(entry.path);
    const card = match ? salvaged.cards[Number(match[1])] : undefined;
    const side = card && match ? (match[2] === "front" ? card.front : card.back) : undefined;
    const offense = side && match ? locateSalvageOffense(side, match[3]!) : undefined;
    if (!card || !offense || !SALVAGEABLE_MEDIA_BLOCK_TYPES.has(offense.block.type)) return undefined;
    offenses.set(card, [...(offenses.get(card) ?? []), offense]);
  }

  let removed = 0;
  for (const [bit, bitOffenses] of offenses) {
    const blockRemovals = new Map<ByteBlock[], Set<number>>();
    const markBlock = (container: ByteBlock[], index: number) => {
      const indices = blockRemovals.get(container) ?? new Set<number>();
      indices.add(index);
      blockRemovals.set(container, indices);
    };
    const prunedImages = new Map<ByteBlock, number>();
    for (const offense of bitOffenses) {
      const galleryImage = offense.block.type === "gallery" ? /^\.images\[(\d+)\]\.url$/.exec(offense.propertyPath) : null;
      if (offense.block.type === "gallery" && galleryImage && Array.isArray(offense.block.images)) {
        const dropIndex = Number(galleryImage[1]);
        if (dropIndex < offense.block.images.length) {
          offense.block.images = offense.block.images.filter((_, imageIndex) => imageIndex !== dropIndex);
          prunedImages.set(offense.block, (prunedImages.get(offense.block) ?? 0) + 1);
        }
        continue;
      }
      markBlock(offense.container, offense.index);
    }
    for (const offense of bitOffenses) {
      if (offense.block.type === "gallery" && Array.isArray(offense.block.images) && offense.block.images.length < 2) {
        markBlock(offense.container, offense.index);
      }
    }
    const isMarked = (container: ByteBlock[], index: number) => blockRemovals.get(container)?.has(index) ?? false;
    const counted = new Set<ByteBlock>();
    for (const offense of bitOffenses) {
      if (counted.has(offense.block) || isMarked(offense.container, offense.index)) continue;
      counted.add(offense.block);
      removed += prunedImages.get(offense.block) ?? 0;
    }
    // Indexes over the whole card, front then back, as cites count them.
    const topLevel = new Set<number>([...(blockRemovals.get(bit.front) ?? [])]);
    for (const index of blockRemovals.get(bit.back ?? []) ?? []) topLevel.add(bit.front.length + index);
    for (const [container, indices] of blockRemovals) {
      removed += indices.size;
      for (const index of [...indices].sort((a, b) => b - a)) container.splice(index, 1);
    }
    // Cites follow their block: dropped with it, or shifted to its new index.
    bit.cites = bit.cites
      .filter((cite) => cite.block === undefined || !topLevel.has(cite.block))
      .map((cite) => (cite.block === undefined ? cite : { ...cite, block: cite.block - [...topLevel].filter((index) => index < cite.block!).length }));
    if (bit.back && bit.back.length === 0) delete bit.back;
  }
  salvaged.cards = salvaged.cards.filter((card) => card.front.length > 0);
  if (salvaged.cards.length === 0) return undefined;
  return { set: salvaged, removed };
}

export function allowedEvidenceURLs(source: SourceEnvelope, research: ResearchResult | undefined): Set<string> {
  const urls = new Set<string>();
  for (const reference of source.references) urls.add(urlKey(reference.url));
  if (source.originalURL) urls.add(urlKey(source.originalURL));
  if (source.canonicalURL) urls.add(urlKey(source.canonicalURL));
  if (source.metadata.imageURL) urls.add(urlKey(source.metadata.imageURL));
  // Harvested asset paths (/v1/assets/<id>) are first-class evidence for the
  // figure/gallery/clip blocks; urlKey keeps relative paths verbatim.
  for (const asset of source.assets ?? []) urls.add(urlKey(asset.url));
  for (const reference of research?.references ?? []) urls.add(urlKey(reference.url));
  return urls;
}

function knownYouTubeIDs(urls: Set<string>): Set<string> {
  const IDs = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "youtu.be") {
        const id = parsed.pathname.slice(1).split(/[/?#]/)[0];
        if (id) IDs.add(id);
      }
      if (parsed.hostname.endsWith("youtube.com")) {
        const id = parsed.searchParams.get("v");
        if (id) IDs.add(id);
      }
    } catch {
      // Validation already rejects malformed evidence URLs.
    }
  }
  return IDs;
}

/** A provider answer as an object. */
function unwrapObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PipelineError("Provider returned a JSON value where an object was required", "INVALID_PROVIDER_OUTPUT");
  }
  return value as Record<string, any>;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isByteType(value: unknown): value is CardSet["sourceKind"] {
  return typeof value === "string" && (BYTE_TYPES as readonly string[]).includes(value);
}

export function inferSourceKind(source: SourceEnvelope): CardSet["sourceKind"] {
  if (isByteType(source.kind)) return source.kind;
  switch (source.kind) {
    case "youtube":
      return "video";
    case "pdf":
      return "paper";
    case "social":
      return "thread";
    case "web":
      return "article";
    case "text":
      return "note";
    default:
      return "other";
  }
}

export function urlKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
