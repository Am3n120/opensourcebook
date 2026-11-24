/** One sitting with a set of flashcards: which cards come up, in what order, and a missed one put back. */
import type { Card } from "./blockData";
import { isDue, type CardMemory, type Mark } from "./spacing";
import type { Segment } from "./useChrome";

/** How many cards later a missed card comes back in the same sitting. */
export const AGAIN_IN_CARDS = 3;

export type Mode = "all" | "review";

/** A sitting: the cards in the order they come up now, a missed one put back in a few cards later. */
export interface Sitting {
  mode: Mode;
  queue: number[];
  at: number;
  /** What each place in the queue was marked, this sitting. */
  marked: Record<number, Mark>;
  ended: boolean;
}

/** The cards a sitting goes through: every card in order, or only those due now, in set order. */
export function queueFor(cards: readonly Card[], memories: Record<string, CardMemory>, mode: Mode, now: number): number[] {
  const all = cards.map((_, i) => i);
  return mode === "review" ? all.filter((i) => isDue(memories[cards[i]!.id], now)) : all;
}

/** A missed card back in the queue a few cards on (or at the end), unless it already comes up again later. */
export function putBack(queue: readonly number[], at: number, card: number): number[] {
  if (queue.slice(at + 1).includes(card)) return [...queue];
  const next = [...queue];
  next.splice(Math.min(next.length, at + 1 + AGAIN_IN_CARDS), 0, card);
  return next;
}

/** The sitting as the player's line: one piece per card, marked got it or not yet, passed, in view, or still to come. */
export function segmentsOf(sitting: Sitting): Segment[] {
  return sitting.queue.map((_, i) => {
    const m = sitting.marked[i];
    if (m === "got") return "good";
    if (m === "missed") return "warn";
    if (sitting.ended || i < sitting.at) return "done";
    return i === sitting.at ? "now" : "todo";
  });
}
