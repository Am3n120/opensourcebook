/**
 * A set of flashcards, schema version 3 (engine/docs/flashcards.md is the
 * contract). A set is an ordered list of cards; each card is one screen that
 * does one job for the learner: a front to answer from memory and a back to
 * check against, a sentence with its key part hidden, a question to answer,
 * or, when the set needs it, one point explained. The kinds of card are a
 * registry (kinds.ts); blocks are the vocabulary in blocks.ts. This file holds
 * the types, the block families, the size of one side and the helpers every
 * reader of a card shares; validate.ts checks a set against them.
 *
 * Sets stored before cards (a version 2 byte of bits, a version 1 page) are
 * served as cards at read time (upgrade.ts); nothing stored is rewritten.
 */
import type { SourceLocator } from "../studio/types";
import type { ByteBlock, ByteType } from "./blocks";

export const CARD_SET_SCHEMA_VERSION = 3;

/** One block of a card. The vocabulary is the one chat replies and older outputs share (blocks.ts). */
export type CardBlock = ByteBlock;

export interface CardSet {
  schemaVersion: typeof CARD_SET_SCHEMA_VERSION;
  id: string;
  title: string;
  subtitle: string;
  /** What the source was (a paper, a video, a note); kept from the source's metadata. */
  sourceKind: ByteType;
  sourceDomain?: string;
  author?: string;
  tags: string[];
  excerpt?: string;
  durationText?: string;
  cards: Card[];
  /** The maker's own words on why the set is a different size from the one planned (the sources held less, say). */
  sizeNote?: string;
  /** Set only on a set served from an older stored output at read time: that output's schema version. */
  upgradedFrom?: number;
}

/**
 * One card. `kind` names an entry of the card kinds (kinds.ts); a client that
 * does not know a kind draws the card from its sides alone: a back to turn
 * over to, a hidden part to reveal, a question that answers itself.
 */
export interface Card {
  /** Unique within the set and stable once written: progress on the card is kept by it. The engine writes c1, c2, ... */
  id: string;
  kind: string;
  /** The group the card belongs to in the set (a topic, a part of the source); neighbouring cards share it. */
  section?: string;
  /** What the person sees first. */
  front: CardBlock[];
  /** What the card turns over to: the answer to check yourself against. Absent on a card with nothing to turn over. */
  back?: CardBlock[];
  cites: Cite[];
}

/**
 * What a cited spot is (DECISIONS #39). Open: an unknown value reads as
 * `passage`. Today the engine writes passage, image, moment and cell.
 */
export type CiteSpot = string;
export const CITE_SPOTS = ["passage", "paragraph", "image", "graph", "table", "cell", "moment"] as const;

export interface Cite {
  sourceId: string;
  spot: CiteSpot;
  chunkId?: string;
  locator?: SourceLocator;
  /** A harvested asset (`/v1/assets/<assetId>`) for an image, graph or moment. */
  assetId?: string;
  /** Copied word for word from the passage; validation checks it is there. */
  quote?: string;
  /**
   * The block this grounds, counted over the front and then the back
   * (`cardBlocks`), so a cite on the back is shown only once the card is
   * turned over. Absent for the whole card.
   */
  block?: number;
}

/** Most units one side of a card may cost: one screen (engine/docs/flashcards.md, "Fits one screen"). */
export const SIDE_BUDGET = 900;
export const MAX_BLOCKS_PER_SIDE = 6;
/** Every block costs at least one line, and each line-like part after the first adds one. */
const LINE_UNITS = 40;
const LARGE_AREA_UNITS = 350;
const SMALL_AREA_UNITS = 120;

export const MEDIA_BLOCKS: ReadonlySet<string> = new Set(["image", "figure", "gallery", "carousel", "clip", "video", "embed", "map"]);
export const CHART_BLOCKS: ReadonlySet<string> = new Set([
  "lineChart",
  "barChart",
  "areaChart",
  "stackedBar",
  "pie",
  "scatter",
  "heatmap",
  "histogram",
  "radar",
  "gauge",
  "metrics",
]);
/** Blocks that ask something and know the answer: answering one marks the card. */
export const ASK_BLOCKS: ReadonlySet<string> = new Set(["quiz", "fillInBlank", "matching", "orderExercise", "labelPicture", "drawLine"]);
/** Blocks that hide part of themselves until the card is turned over. */
export const HIDING_BLOCKS: ReadonlySet<string> = new Set(["cloze"]);
/**
 * Blocks a card never holds: page layout with no meaning on one screen, a
 * page header, listening (outside the feed, #38), a card or a reveal inside
 * a card (the card itself turns over), and tools that are not for study.
 * Older outputs that hold them still draw.
 */
export const BLOCKS_NOT_ON_A_CARD: ReadonlySet<string> = new Set([
  "toc",
  "continuation",
  "spacer",
  "divider",
  "hero",
  "audio",
  "audioClip",
  "flashcards",
  "reveal",
  "checklist",
  "servingsScaler",
  "timer",
]);

/** A block that takes a side's main place; a side has at most one. */
export function isFeatureBlock(type: string): boolean {
  return MEDIA_BLOCKS.has(type) || CHART_BLOCKS.has(type) || ASK_BLOCKS.has(type) || type === "table" || type === "prosCons";
}

/** Every block of a card, front then back: what a cite's `block` counts over. */
export function cardBlocks(card: Pick<Card, "front" | "back">): CardBlock[] {
  return [...(Array.isArray(card.front) ? card.front : []), ...(Array.isArray(card.back) ? card.back : [])];
}

/** Which side the block at `index` of `cardBlocks(card)` is on. */
export function sideOf(card: Pick<Card, "front">, index: number): "front" | "back" {
  return index < (Array.isArray(card.front) ? card.front.length : 0) ? "front" : "back";
}

/**
 * How the person marks a card, read from its sides alone, so every client
 * (and every kind, registered or not) agrees: a card that asks is marked by
 * its answer; a card with a back or a hidden part is marked by the person,
 * got it or not yet, once turned over; any other card is only read.
 */
export type CardMark = "answer" | "self" | "none";
export function markOf(card: Pick<Card, "front" | "back">): CardMark {
  const front = Array.isArray(card.front) ? card.front : [];
  if (front.some((block) => ASK_BLOCKS.has(String(block?.type)))) return "answer";
  if ((Array.isArray(card.back) && card.back.length > 0) || front.some((block) => HIDING_BLOCKS.has(String(block?.type)))) return "self";
  return "none";
}

/** What one side costs against `SIDE_BUDGET`. */
export function sideCost(blocks: readonly CardBlock[]): number {
  return blocks.reduce((total, block) => total + blockCost(block), 0);
}

/** cost(block) = max(40, text) + lines + area. */
export function blockCost(block: CardBlock): number {
  if (!block || typeof block !== "object") return LINE_UNITS;
  return Math.max(LINE_UNITS, shownText(block)) + extraLines(block) * LINE_UNITS + area(block.type);
}

function area(type: string): number {
  // A picture to label and a grid to draw on take a picture's room.
  if (MEDIA_BLOCKS.has(type) || (CHART_BLOCKS.has(type) && type !== "metrics") || type === "labelPicture" || type === "drawLine") return LARGE_AREA_UNITS;
  if (type === "metrics" || type === "linkPreview" || type === "bigStat") return SMALL_AREA_UNITS;
  return 0;
}

/** Keys whose strings are not shown as words: addresses, ids and enum values. */
const UNSHOWN_KEYS = new Set([
  "type",
  "url",
  "imageURL",
  "posterURL",
  "youtubeID",
  "id",
  "style",
  "color",
  "platform",
  "language",
  "systemIcon",
  "html",
  "domain",
  "unit",
]);

/** Characters of every string the block shows, at any depth (a reveal counts the blocks inside it). */
export function shownText(value: unknown, key?: string): number {
  if (key && UNSHOWN_KEYS.has(key)) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + shownText(entry), 0);
  if (value && typeof value === "object") {
    return Object.entries(value).reduce<number>((total, [entryKey, entry]) => total + shownText(entry, entryKey), 0);
  }
  return 0;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Line-like parts after the first: list items, table rows, code lines, options, pairs. */
function extraLines(block: CardBlock): number {
  const lines = (() => {
    switch (block.type) {
      case "bullets":
      case "numbered":
      case "checklist":
      case "timeline":
      case "orderExercise":
        return count(block.items);
      case "table":
        return count(block.rows) + 1;
      case "code":
        return typeof block.text === "string" ? block.text.split("\n").length : 0;
      case "quiz":
        return count(block.options);
      case "fillInBlank":
        return count(block.options);
      case "matching":
        return count(block.pairs);
      case "labelPicture":
        return count(block.marks);
      case "servingsScaler":
        return count(block.ingredients);
      case "metrics":
        return count(block.stats);
      case "prosCons":
        return count(block.pros?.items) + count(block.cons?.items);
      case "reveal":
        return Array.isArray(block.blocks) ? block.blocks.reduce((total, inner) => total + 1 + extraLines(inner), 0) : 0;
      default:
        return 0;
    }
  })();
  return Math.max(0, lines - 1);
}
