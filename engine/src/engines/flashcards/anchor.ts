/**
 * A spot in a set of flashcards in words (`FormatDefinition.describeAnchor`):
 * the card the person is on, as the flashcards player keeps it (`{ card,
 * cards }`: the card's index and what is remembered of each card by id),
 * with its front and back, and how the person last marked it. The sides are
 * said from their blocks' own words, whatever their kind.
 */
import { markOf, type Card, type CardSet } from "../../cards/contract";
import type { AnchorWords, JsonValue } from "../../studio/types";

/** The words a side shows: every bit of text in its blocks, a hidden gap said as itself. */
export function sideWords(blocks: readonly unknown[] | undefined): string {
  const words: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      if (key && TEXT_KEYS.has(key) && value.trim()) words.push(value.replace(/\[\[([^\[\]]+)\]\]/g, "$1").trim());
      return;
    }
    if (Array.isArray(value)) for (const entry of value) walk(entry, key);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(blocks ?? []);
  return words.join(" ");
}

/** Keys whose strings are words a person reads on a card. */
const TEXT_KEYS = new Set(["text", "title", "caption", "label", "question", "answer", "options", "items", "term", "definition", "prompt", "cells", "header", "rows", "alt"]);

export function flashcardsAnchor(set: CardSet, at: JsonValue): AnchorWords | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at)) return undefined;
  const cards: Card[] = Array.isArray(set?.cards) ? set.cards : [];
  const index = typeof at.card === "number" && Number.isInteger(at.card) ? at.card : typeof at.bit === "number" && Number.isInteger(at.bit) ? at.bit : undefined;
  const card = index === undefined ? undefined : cards[index];
  if (!card) return undefined;
  const facts = [`Card ${index! + 1} of ${cards.length}${card.section ? ` (in ${card.section})` : ""}.`];
  const front = sideWords(card.front);
  if (front) facts.push(`Its front: ${front}`);
  const back = sideWords(card.back);
  if (back) facts.push(`Its back: ${back}`);
  const kept = at.cards && typeof at.cards === "object" && !Array.isArray(at.cards) ? at.cards[card.id] : undefined;
  const memory = kept && typeof kept === "object" && !Array.isArray(kept) ? kept : undefined;
  const mark = markOf(card);
  let said: string | undefined;
  if (mark === "none") facts.push("It is a card to read; it is not marked.");
  else if (!memory || typeof memory.seen !== "number" || memory.seen === 0) facts.push("They have not marked it yet.");
  else {
    const missed = typeof memory.missed === "number" ? memory.missed : 0;
    const last = typeof memory.box === "number" && memory.box > 0 ? "got it" : "not yet";
    said = last;
    facts.push(`They last marked it "${last}" (marked ${memory.seen} time${memory.seen === 1 ? "" : "s"}, "not yet" ${missed} of them).`);
  }
  for (const cite of card.cites ?? []) if (cite.quote) facts.push(`The card cites: "${cite.quote}"`);
  return { label: `card ${index! + 1}${said ? ` · ${said}` : ""}`, facts };
}
