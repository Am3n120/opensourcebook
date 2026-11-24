/**
 * When a flashcard comes back (engine/docs/flashcards.md, "Progress"). One
 * rule behind one interface, so a better schedule can replace it without
 * touching the player, the feed or the `opensourcebook` command, which all read this
 * file. Pure: no imports, no clock of its own (`now` is passed in), so the
 * command can load it as it is.
 *
 * The rule: a few boxes with growing gaps. "Not yet" puts a card in box 0,
 * due again in ten minutes (in the sitting it comes back a few cards later);
 * "got it" moves it up a box, due again after that box's gap: 1, 3, 7, 16
 * and then 35 days. A card is learned once it is in box 3 or higher, which
 * takes being got on three reviews spread over days, in a row.
 */

/** What is remembered about one card. A card with none is new. */
export interface CardMemory {
  /** 0 after a miss; one higher for each "got it" since. */
  box: number;
  /** When it is next due, in ms since 1970. */
  due: number;
  /** How many times it was marked. */
  seen: number;
  /** How many of those were "not yet". */
  missed: number;
  /** When it was last marked, in ms since 1970; absent on a memory kept before it was written. */
  last?: number;
}

export type Mark = "got" | "missed";

/** A spacing rule: what a mark does to a card's memory. */
export interface Schedule {
  id: string;
  /** The rule in one plain sentence, for the person. */
  about: string;
  next(memory: CardMemory | undefined, mark: Mark, now: number): CardMemory;
  /** Whether a card counts as learned. */
  learned(memory: CardMemory | undefined): boolean;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How soon a missed card is due again: after a short break, so it is met again today. */
export const AGAIN_AFTER_MS = 10 * MINUTE;
/** The gap after each "got it", by the box the card moves into (box 1 is one day, ...). */
export const BOX_GAPS_DAYS = [1, 3, 7, 16, 35] as const;
/** The box from which a card is learned. */
export const LEARNED_BOX = 3;

export const boxes: Schedule = {
  id: "boxes",
  about: "A card you miss comes back in a few minutes; each time you get it, it waits longer before coming back: a day, then 3, 7, 16 and 35 days.",
  next(memory, mark, now) {
    const seen = (memory?.seen ?? 0) + 1;
    const missed = (memory?.missed ?? 0) + (mark === "missed" ? 1 : 0);
    if (mark === "missed") return { box: 0, due: now + AGAIN_AFTER_MS, seen, missed, last: now };
    const box = Math.min(BOX_GAPS_DAYS.length, (memory?.box ?? 0) + 1);
    return { box, due: now + BOX_GAPS_DAYS[box - 1]! * DAY, seen, missed, last: now };
  },
  learned(memory) {
    return (memory?.box ?? 0) >= LEARNED_BOX;
  },
};

/** The schedule every client uses now. */
export const SCHEDULE: Schedule = boxes;

/** Whether a card is due now: it was seen, and its time has come. A new card is not due; it is new. */
export function isDue(memory: CardMemory | undefined, now: number): boolean {
  return memory !== undefined && memory.due <= now;
}

/** A card's memory as stored, read defensively; undefined for anything that is not one. */
export function readMemory(value: unknown): CardMemory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const due = n(v.due);
  if (due === undefined) return undefined;
  const last = n(v.last);
  return { box: Math.max(0, Math.floor(n(v.box) ?? 0)), due, seen: n(v.seen) ?? 1, missed: n(v.missed) ?? 0, ...(last !== undefined ? { last } : {}) };
}

/** Every card's memory in a kept progress (`{ cards: { [id]: memory } }`). */
export function memoriesOf(progress: unknown): Record<string, CardMemory> {
  const cards = progress && typeof progress === "object" && !Array.isArray(progress) ? (progress as Record<string, unknown>).cards : undefined;
  const out: Record<string, CardMemory> = {};
  if (cards && typeof cards === "object" && !Array.isArray(cards)) {
    for (const [id, value] of Object.entries(cards)) {
      const memory = readMemory(value);
      if (memory) out[id] = memory;
    }
  }
  return out;
}

/** How a set stands: counted over the cards that are marked (cards that are only read are left out). */
export interface SetStanding {
  cards: number;
  new: number;
  due: number;
  learned: number;
  /** When the next card not due now comes back, if any. */
  nextDue?: number;
}

export function standing(markable: readonly string[], memories: Record<string, CardMemory>, now: number, schedule: Schedule = SCHEDULE): SetStanding {
  let fresh = 0;
  let due = 0;
  let learned = 0;
  let nextDue: number | undefined;
  for (const id of markable) {
    const memory = memories[id];
    if (!memory) fresh += 1;
    else if (isDue(memory, now)) due += 1;
    else nextDue = Math.min(nextDue ?? Infinity, memory.due);
    if (schedule.learned(memory)) learned += 1;
  }
  return { cards: markable.length, new: fresh, due, learned, ...(nextDue !== undefined ? { nextDue } : {}) };
}

/** How many cards are due in a kept progress, without the set itself: what the feed orders by. */
export function dueIn(progress: unknown, now: number): number {
  return Object.values(memoriesOf(progress)).filter((memory) => isDue(memory, now)).length;
}

/** When something comes back, in a few plain words: "in 10 minutes", "tomorrow", "in 3 days". */
export function whenWords(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (ms < 90 * MINUTE) return minutes === 1 ? "in a minute" : `in ${minutes} minutes`;
  if (ms < 20 * 60 * MINUTE) return `in ${Math.round(ms / (60 * MINUTE))} hours`;
  const days = Math.round(ms / DAY);
  return days <= 1 ? "tomorrow" : `in ${days} days`;
}

/** The cards that are not due now grouped by when they come back, soonest first: [["tomorrow", 8], ["in 3 days", 3]]. */
export function comingBack(markable: readonly string[], memories: Record<string, CardMemory>, now: number): Array<[string, number]> {
  const groups = new Map<string, { at: number; n: number }>();
  for (const id of markable) {
    const memory = memories[id];
    if (!memory || memory.due <= now) continue;
    const words = whenWords(memory.due, now);
    const group = groups.get(words) ?? { at: memory.due, n: 0 };
    groups.set(words, { at: Math.min(group.at, memory.due), n: group.n + 1 });
  }
  return [...groups.entries()].sort((a, b) => a[1].at - b[1].at).map(([words, g]) => [words, g.n]);
}

/** How long ago something was, in a few plain words: "just now", "5 minutes ago", "yesterday", "2 days ago". */
export function agoWords(at: number, now: number): string {
  const ms = now - at;
  if (ms < MINUTE) return "just now";
  if (ms < 90 * MINUTE) {
    const minutes = Math.round(ms / MINUTE);
    return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  }
  if (ms < 20 * 60 * MINUTE) return `${Math.round(ms / (60 * MINUTE))} hours ago`;
  const days = Math.round(ms / DAY);
  return days <= 1 ? "yesterday" : `${days} days ago`;
}
