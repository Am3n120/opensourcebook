import type { Json, OutputSummary } from "../api/types";

/** One thing in the feed: what was made, and where it sits. */
export interface FeedEntry {
  output: OutputSummary;
  projectTitle?: string;
  planTitle?: string;
  /** Its item's place in its plan: stage, then position. Absent outside a plan. */
  place?: { level: number; ord: number };
  done: boolean;
  progress?: Json;
  /** How many of its cards are due for review now (a set of flashcards, from its kept progress); absent for anything else. */
  due?: number;
}

/**
 * A way to order the feed. The feed reads the list below and never names one,
 * so another (by topic, spaced, chosen by the person) is one more entry
 * (docs/STRUCTURE.md, "Read the list, never name the member").
 */
export interface FeedOrder {
  id: string;
  label: string;
  /** The rule in one plain sentence, for the person. */
  about: string;
  order(entries: readonly FeedEntry[]): FeedEntry[];
}

const time = (e: FeedEntry) => Date.parse(e.output.createdAt) || 0;
const groupOf = (e: FeedEntry) => (e.output.planId ? `plan:${e.output.planId}` : `one:${e.output.id}`);

/**
 * Unfinished things first, then finished ones. Within each, the plan made most
 * recently comes first, and a plan's things stay in plan order, so a later one
 * can build on an earlier one; a thing made outside a plan stands alone.
 */
export const newestUnfinished: FeedOrder = {
  id: "newest-unfinished",
  label: "Newest, unfinished first",
  about: "What you have not finished comes first, newest plan first, each plan in its own order; what you finished comes after.",
  order(entries) {
    const bucket = (done: boolean) => {
      const groups = new Map<string, FeedEntry[]>();
      for (const e of entries) {
        if (e.done !== done) continue;
        const key = groupOf(e);
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
      const newest = (list: FeedEntry[]) => Math.max(...list.map(time));
      return [...groups.values()]
        .sort((a, b) => newest(b) - newest(a))
        .flatMap((list) =>
          [...list].sort((a, b) => (a.place && b.place ? a.place.level - b.place.level || a.place.ord - b.place.ord : 0) || time(a) - time(b)),
        );
    };
    return [...bucket(false), ...bucket(true)];
  },
};

/**
 * Cards due for review come up first: every thing with cards due now, the
 * most due first, finished or not; then the rest in another order (by
 * default the one above). Due cards from every set come back this way
 * without the feed knowing what a set or a card is.
 */
export function dueFirst(then: FeedOrder = newestUnfinished): FeedOrder {
  return {
    id: "due-first",
    label: "Due cards first",
    about: `Flashcards with cards due for review come first, most due first; then: ${then.about.charAt(0).toLowerCase()}${then.about.slice(1)}`,
    order(entries) {
      const due = entries.filter((e) => (e.due ?? 0) > 0).sort((a, b) => (b.due ?? 0) - (a.due ?? 0) || time(b) - time(a));
      return [...due, ...then.order(entries.filter((e) => !((e.due ?? 0) > 0)))];
    },
  };
}

export const FEED_ORDERS: readonly FeedOrder[] = [dueFirst(), newestUnfinished];

/** The feed in the named order, else the first one. */
export function orderFeed(entries: readonly FeedEntry[], id?: string, orders: readonly FeedOrder[] = FEED_ORDERS): FeedEntry[] {
  const order = orders.find((o) => o.id === id) ?? orders[0];
  return order ? order.order(entries) : [...entries];
}
