/**
 * Older stored outputs, served as cards at read time (engine/docs/flashcards.md,
 * "Old outputs"). Pure: the same stored payload always gives the same cards,
 * and the stored row is never touched.
 *
 * - Version 1, a page: one list of blocks. `packBits` cuts it into screens.
 * - Version 2, a byte: a list of bits, each one screen of blocks.
 * - `toCardSet` serves either as version 3. A bit that held one card that
 *   flips becomes a front-and-back card, a bit that asks becomes a question
 *   card, and any other bit a card that is read, as it was.
 * - `cardsToPage` lays a set out as one version 1 page for the phone build
 *   that only knows pages (`/v1/jobs` `result`).
 */
import { isRecord } from "../net";
import { BYTE_DEPTHS, BYTE_TYPES, GENERATION_DEPTHS, type ByteBlock, type ByteDepth, type ByteType, type PagePayload } from "./blocks";
import {
  ASK_BLOCKS,
  CARD_SET_SCHEMA_VERSION,
  CHART_BLOCKS,
  MEDIA_BLOCKS,
  blockCost,
  sideCost,
  type Card,
  type CardSet,
  type Cite,
} from "./contract";

/** A screen of a version 2 byte. */
export interface LegacyBit {
  id: string;
  kind: string;
  section?: string;
  blocks: ByteBlock[];
  cites: Cite[];
}

/** A version 2 byte, as stored before cards. */
export interface LegacyByte {
  schemaVersion: 2;
  id: string;
  title: string;
  subtitle: string;
  sourceKind: ByteType;
  sourceDomain?: string;
  author?: string;
  tags: string[];
  excerpt?: string;
  durationText?: string;
  depth: ByteDepth;
  requestedDepth?: string;
  bits: LegacyBit[];
  sizeNote?: string;
  upgradedFrom?: number;
}

/** A version 2 screen's budget and limits, for cutting a page the way it was cut then. */
const BIT_BUDGET = 900;
const MAX_BLOCKS_PER_BIT = 6;
const BLOCKS_NOT_IN_A_BIT: ReadonlySet<string> = new Set(["toc", "continuation", "spacer", "divider", "hero", "audio", "audioClip"]);
const isFeatureBlock = (type: string) => MEDIA_BLOCKS.has(type) || CHART_BLOCKS.has(type) || ASK_BLOCKS.has(type) || ["checklist", "servingsScaler", "timer", "flashcards", "reveal", "table"].includes(type);
const bitCost = sideCost;
function bitKindOf(blocks: readonly ByteBlock[]): string {
  const types = blocks.map((block) => String(block?.type));
  if (types.some((type) => ASK_BLOCKS.has(type))) return "interactive";
  if (types.some((type) => type === "flashcards" || type === "reveal")) return "flip";
  if (types.some((type) => CHART_BLOCKS.has(type))) return "chart";
  if (types.includes("table")) return "table";
  if (types.some((type) => MEDIA_BLOCKS.has(type))) return "picture";
  return "plain";
}

/** Text blocks are cut to leave room for a heading beside them. */
const TEXT_PIECE_CHARS = 700;
const MAX_TAGS = 8;

/** True for a stored payload in the version 1 page shape. */
export function isPagePayload(value: unknown): value is PagePayload {
  return isRecord(value) && Array.isArray(value.blocks) && !Array.isArray(value.bits);
}

/**
 * Cuts blocks into bits: a new bit at each heading or kicker, and whenever
 * the next block would break the budget, the block limit or the one-feature
 * rule. A heading is never left alone at the end of a bit; it moves to the
 * next one. A block bigger than a bit on its own still gets a bit to itself.
 */
export function packBits(blocks: readonly ByteBlock[], options: { section?: string; startIndex?: number } = {}): LegacyBit[] {
  const groups: Array<{ section?: string; blocks: ByteBlock[] }> = [];
  let section = options.section;
  let current: ByteBlock[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const leading = current.findIndex((block) => !isTitleBlock(block));
    if (leading === -1) return; // only titles so far: they stay for the next block
    let tail = current.length;
    while (tail > 0 && isTitleBlock(current[tail - 1])) tail -= 1;
    groups.push({ ...(section ? { section } : {}), blocks: current.slice(0, tail) });
    current = current.slice(tail);
  };

  for (const block of blocks.flatMap(fitForBit)) {
    if ((block.type === "heading" || block.type === "kicker") && current.some((entry) => !isTitleBlock(entry))) flush();
    if (block.type === "heading" || block.type === "kicker") section = block.text.trim() || section;
    const next = [...current, block];
    const features = next.filter((entry) => isFeatureBlock(entry.type)).length;
    if (current.some((entry) => !isTitleBlock(entry)) && (next.length > MAX_BLOCKS_PER_BIT || bitCost(next) > BIT_BUDGET || features > 1)) {
      flush();
      current.push(block);
    } else {
      current = next;
    }
  }
  flush();
  // Titles with nothing after them still make a bit rather than vanish.
  if (current.length > 0) groups.push({ ...(section ? { section } : {}), blocks: current });

  const start = options.startIndex ?? 0;
  return groups.map((group, index) => ({
    id: `b${start + index + 1}`,
    kind: bitKindOf(group.blocks),
    ...(group.section ? { section: group.section } : {}),
    blocks: group.blocks,
    cites: [],
  }));
}

/** A stored version 1 page as the version 2 byte it was served as. `schemaVersion` is the stored row's. */
export function pageToByte(page: PagePayload, schemaVersion = 1): LegacyByte {
  const record = page as unknown as Record<string, unknown>;
  const blocks = Array.isArray(page.blocks) ? page.blocks.filter((block): block is ByteBlock => isRecord(block) && typeof block.type === "string") : [];
  const title = text(record.title) ?? "Saved source";
  let bits = packBits(blocks);
  if (bits.length === 0) bits = [{ id: "b1", kind: "plain", blocks: [{ type: "heading", text: title }], cites: [] }];
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, MAX_TAGS) : [];
  return {
    schemaVersion: 2,
    id: text(record.id) ?? crypto.randomUUID(),
    title,
    subtitle: text(record.subtitle) ?? text(record.sourceDomain) ?? "Saved source",
    sourceKind: (BYTE_TYPES as readonly string[]).includes(String(record.type)) ? (record.type as ByteType) : "other",
    ...optionalText(record, "sourceDomain"),
    ...optionalText(record, "author"),
    tags,
    ...optionalText(record, "excerpt"),
    ...optionalText(record, "durationText"),
    depth: (BYTE_DEPTHS as readonly string[]).includes(String(record.byteDepth)) ? (record.byteDepth as ByteDepth) : "light",
    ...((GENERATION_DEPTHS as readonly string[]).includes(String(record.depth)) ? { requestedDepth: String(record.depth) } : {}),
    bits,
    upgradedFrom: schemaVersion,
  };
}

/** True for a stored payload in the version 2 byte shape. */
export function isLegacyByte(value: unknown): value is LegacyByte {
  return isRecord(value) && Array.isArray(value.bits) && !Array.isArray(value.cards);
}

/** A version 2 bit as the card it is now: what it held decides the kind, and nothing it showed is lost. */
export function bitToCard(bit: LegacyBit, index: number): Card {
  const blocks = (Array.isArray(bit.blocks) ? bit.blocks : []).filter((block) => isRecord(block) && typeof block.type === "string");
  const cites = Array.isArray(bit.cites) ? bit.cites.filter(isRecord).map((cite) => ({ ...cite })) : [];
  const id = `c${index + 1}`;
  const section = typeof bit.section === "string" && bit.section.trim() ? { section: bit.section } : {};
  const deck = blocks.findIndex((block) => block.type === "flashcards" && Array.isArray(block.cards) && block.cards.length === 1);
  if (deck >= 0) {
    const card = (blocks[deck] as Extract<ByteBlock, { type: "flashcards" }>).cards[0]!;
    const front: ByteBlock[] = [...blocks.slice(0, deck), { type: "text", text: card.front }, ...blocks.slice(deck + 1)];
    // The card's own words keep their place, so every cite points at the same block it did.
    return { id, kind: "recall", ...section, front, back: [{ type: "text", text: card.back }], cites };
  }
  if (blocks.some((block) => ASK_BLOCKS.has(block.type))) return { id, kind: "ask", ...section, front: blocks, cites };
  return { id, kind: "explain", ...section, front: blocks, cites };
}

/**
 * Any stored payload of this format as a version 3 set: a page, a byte, or a
 * set already (returned as it is). Undefined for anything else.
 */
export function toCardSet(payload: unknown, schemaVersion: number): CardSet | undefined {
  if (isRecord(payload) && Array.isArray(payload.cards)) return payload as unknown as CardSet;
  const byte = isPagePayload(payload) ? pageToByte(payload, schemaVersion) : isLegacyByte(payload) ? payload : undefined;
  if (!byte) return undefined;
  const { bits, depth: _depth, requestedDepth: _requested, schemaVersion: _version, upgradedFrom, ...rest } = byte;
  return {
    ...rest,
    schemaVersion: CARD_SET_SCHEMA_VERSION,
    tags: Array.isArray(rest.tags) ? rest.tags : [],
    cards: (Array.isArray(bits) ? bits : []).filter(isRecord).map((bit, index) => bitToCard(bit as LegacyBit, index)),
    upgradedFrom: upgradedFrom ?? schemaVersion,
  };
}

/** A set laid out as one version 1 page, for the phone build that only knows pages: each card's front, then its back. */
export function cardsToPage(set: CardSet): PagePayload {
  const blocks: ByteBlock[] = [];
  for (const card of set.cards) {
    for (const block of card.front) blocks.push(block.type === "cloze" ? { type: "text", text: block.text.replace(/\[\[([^\[\]]+)\]\]/g, "**$1**") } : structuredClone(block));
    for (const block of card.back ?? []) blocks.push(structuredClone(block));
  }
  return {
    id: set.id,
    type: set.sourceKind,
    title: set.title,
    subtitle: set.subtitle,
    ...(set.sourceDomain ? { sourceDomain: set.sourceDomain } : {}),
    ...(set.author ? { author: set.author } : {}),
    timeAgo: "just now",
    tags: set.tags,
    status: { type: "ready" },
    ...(set.durationText ? { durationText: set.durationText } : {}),
    ...(set.excerpt ? { excerpt: set.excerpt } : {}),
    blocks,
    byteDepth: "light",
  };
}

function isTitleBlock(block: ByteBlock): boolean {
  return block.type === "heading" || block.type === "kicker" || block.type === "subheading";
}

/** One page block as zero or more blocks a bit may hold. */
function fitForBit(block: ByteBlock): ByteBlock[] {
  if (!BLOCKS_NOT_IN_A_BIT.has(block.type)) {
    if (block.type === "flashcards") return (Array.isArray(block.cards) ? block.cards : []).map((card) => ({ type: "flashcards", cards: [card] }));
    if (block.type === "text" && blockCost(block) > BIT_BUDGET) return splitText(block.text).map((piece) => ({ type: "text", text: piece }));
    return [block];
  }
  switch (block.type) {
    case "hero":
      return [{ type: "figure", url: block.url, ...(block.title || block.subtitle ? { caption: block.title ?? block.subtitle } : {}) }];
    case "audio":
      return [{ type: "linkCard", url: block.url, title: block.title, domain: hostOf(block.url) }];
    case "audioClip":
      return [{ type: "linkCard", url: block.url, title: block.title ?? "Audio", domain: hostOf(block.url) }];
    default:
      return [];
  }
}

/** Splits long text at paragraph ends, then sentence ends, into pieces that fit a bit. */
export function splitText(value: string, limit = TEXT_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = (part: string, joiner: string) => {
    if (!current) current = part;
    else if (current.length + joiner.length + part.length <= limit) current = `${current}${joiner}${part}`;
    else {
      pieces.push(current);
      current = part;
    }
  };
  for (const paragraph of value.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (paragraph.length <= limit) {
      push(paragraph, "\n\n");
      continue;
    }
    const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [paragraph];
    let joiner = "\n\n";
    for (const sentence of sentences.map((entry) => entry.trim()).filter(Boolean)) {
      // A sentence longer than a bit is cut at a word boundary.
      for (const part of sentence.length <= limit ? [sentence] : hardCut(sentence, limit)) {
        push(part, joiner);
        joiner = " ";
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function hardCut(value: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const at = space > limit / 2 ? space : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "link";
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalText(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = text(record[key]);
  return value ? { [key]: value } : {};
}
