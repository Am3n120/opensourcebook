import type { Json, JsonObject } from "../api/types";
import { parseInline } from "./inlineMarks";

/** One block of a card: an object with a string `type` (engine/src/cards/blocks.ts). */
export type Block = JsonObject & { type: string };

/** Where a card's content came from (engine/docs/flashcards.md, "Cite"). */
export interface Cite {
  sourceId: string;
  spot?: string;
  locator?: { page?: number; endPage?: number; slide?: number; startMs?: number; cell?: string; charStart?: number; charEnd?: number };
  quote?: string;
  block?: number;
}

/** One card of a set (engine/docs/flashcards.md, "Card"): a front, and a back it turns over to. */
export interface Card {
  id: string;
  kind: string;
  section?: string;
  front: Block[];
  back: Block[];
  cites: Cite[];
}

/** Blocks a card has a cite on, and its cites: what `placedMarks` places marks over. */
export interface Cited {
  blocks: Block[];
  cites: Cite[];
}

const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const isObj = (v: Json | undefined): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

export function asBlocks(value: Json | undefined): Block[] {
  return arr(value).filter((b): b is Block => isObj(b) && typeof b.type === "string");
}

const citesOf = (v: Json | undefined): Cite[] => arr(v).filter(isObj).filter((c) => typeof c.sourceId === "string") as unknown as Cite[];

/**
 * The cards of a set, read defensively: a card with an empty front is dropped.
 * A payload still in the older shape of screens (`bits`) is read as cards that
 * are only read, so nothing stored fails to open; the engine serves cards.
 */
export function asCards(payload: JsonObject): Card[] {
  if (!Array.isArray(payload.cards) && Array.isArray(payload.bits)) {
    return arr(payload.bits)
      .filter(isObj)
      .map((b, i) => ({ id: `c${i + 1}`, kind: "explain", ...(typeof b.section === "string" && b.section ? { section: b.section } : {}), front: asBlocks(b.blocks), back: [], cites: citesOf(b.cites) }))
      .filter((c) => c.front.length > 0);
  }
  return arr(payload.cards)
    .filter(isObj)
    .map((c, i) => ({
      id: typeof c.id === "string" ? c.id : `c${i + 1}`,
      kind: typeof c.kind === "string" ? c.kind : "recall",
      ...(typeof c.section === "string" && c.section ? { section: c.section } : {}),
      front: asBlocks(c.front),
      back: asBlocks(c.back),
      cites: citesOf(c.cites),
    }))
    .filter((c) => c.front.length > 0);
}

/** Blocks that ask and know their answer: answering one marks the card. */
export const ASKS = new Set(["quiz", "fillInBlank", "matching", "orderExercise", "labelPicture", "drawLine"]);

/**
 * How a card is marked, from its sides alone (the engine's `markOf`): by its
 * answer when it asks, by the person when it turns over (a back, or a hidden
 * part), and not at all when it is only read.
 */
export type CardMark = "answer" | "self" | "none";
export function markOf(card: Pick<Card, "front" | "back">): CardMark {
  if (card.front.some((b) => ASKS.has(b.type))) return "answer";
  if (card.back.length > 0 || card.front.some((b) => b.type === "cloze")) return "self";
  return "none";
}

/** A card's blocks, front then back, as its cites count them. */
export function cited(card: Card): Cited {
  return { blocks: [...card.front, ...card.back], cites: card.cites };
}

/** Body text without its inline marks (**bold**, `code`, links), for a one-line name. */
function plainText(text: string): string {
  return parseInline(text)
    .map((run) => run.text)
    .join("");
}

/** A card's name for the list beside the player: its first words, a gap shown as "…", else its section. */
export function cardTitle(card: Card, index: number): string {
  const h = card.front.find((b) => typeof b.text === "string" || typeof b.question === "string" || typeof b.prompt === "string" || typeof b.term === "string");
  const raw = (h?.text ?? h?.question ?? h?.prompt ?? h?.term) as string | undefined;
  const s = raw === undefined ? undefined : plainText(raw.replace(/\[\[([^[\]]+)\]\]/g, "…")).replace(/\s+/g, " ").trim();
  if (s) return s.length > 56 ? `${s.slice(0, 54)}…` : s;
  return card.section ?? `Card ${index + 1}`;
}

/** Where in a source a cite points, in a few words: "p. 4", "slide 3", "1:20". */
export function spotText(cite: Cite): string {
  const l = cite.locator ?? {};
  if (l.page !== undefined) return l.endPage && l.endPage !== l.page ? `pp. ${l.page}–${l.endPage}` : `p. ${l.page}`;
  if (l.slide !== undefined) return `slide ${l.slide}`;
  if (l.startMs !== undefined) {
    const s = Math.floor(l.startMs / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  if (l.cell) return `cell ${l.cell}`;
  return cite.spot && cite.spot !== "passage" ? cite.spot : "";
}

/** A fixed order for `n` things that is not their written order: the same every time the card is drawn. */
export function mixedOrder(n: number, seed: string): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  for (let i = n - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const j = (h >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Never the order the answer is in: that would give it away.
  if (n > 1 && order.every((v, i) => v === i)) order.push(order.shift()!);
  return order;
}

/**
 * A card's cites, numbered, by the block each mark sits at: the block it
 * supports (counted front then back), or, for a cite of the whole card (and
 * every cite of an output made before cites were placed), its last block of words.
 */
export function placedMarks(bit: Cited): Map<number, Array<{ cite: Cite; n: number }>> {
  const byBlock = new Map<number, Array<{ cite: Cite; n: number }>>();
  const words = bit.blocks.map((b, i) => (WORDS.has(b.type) ? i : -1)).filter((i) => i >= 0);
  const end = words.at(-1) ?? bit.blocks.length - 1;
  for (const mark of numberCites(bit.cites)) {
    const b = mark.cite.block;
    // A heading names a card; it holds no claim, so a cite placed on it marks the words under it.
    const placed = typeof b === "number" && b >= 0 && b < bit.blocks.length ? b : end;
    const words = TITLES.has(bit.blocks[placed]!.type) ? bit.blocks.findIndex((x, i) => i > placed && !TITLES.has(x.type)) : placed;
    const at = words >= 0 ? words : end;
    byBlock.set(at, [...(byBlock.get(at) ?? []), mark]);
  }
  return byBlock;
}

const TITLES = new Set(["heading", "subheading", "kicker"]);
const WORDS = new Set(["text", "quote", "callout", "definition", "bullets", "numbered"]);

/** A thing's cites, each once, numbered in the order they first appear. */
export function numberCites(cites: readonly Cite[]): Array<{ cite: Cite; n: number }> {
  const seen = new Map<string, { cite: Cite; n: number }>();
  for (const cite of cites) {
    const key = `${cite.sourceId}|${cite.locator?.charStart ?? ""}|${cite.quote ?? ""}`;
    if (!seen.has(key)) seen.set(key, { cite, n: seen.size + 1 });
  }
  return [...seen.values()];
}
