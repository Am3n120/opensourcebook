import { putBack, queueFor } from "./sitting";
import { AGAIN_AFTER_MS, LEARNED_BOX, SCHEDULE, agoWords, boxes, comingBack, dueIn, isDue, memoriesOf, readMemory, standing, whenWords, type CardMemory } from "./spacing";
import type { Card } from "./blockData";

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 18, 9);

test("a missed card is due again in minutes; each got-it waits longer: 1, 3, 7, 16, then 35 days", () => {
  const missed = boxes.next(undefined, "missed", T);
  expect(missed).toEqual({ box: 0, due: T + AGAIN_AFTER_MS, seen: 1, missed: 1, last: T });
  let m: CardMemory | undefined;
  const gaps: number[] = [];
  for (let i = 0; i < 6; i++) {
    m = boxes.next(m, "got", T);
    gaps.push((m.due - T) / DAY);
  }
  expect(gaps).toEqual([1, 3, 7, 16, 35, 35]);
  expect(m).toMatchObject({ box: 5, seen: 6, missed: 0 });
  // A miss at any box starts it over, keeping the count of what was seen.
  expect(boxes.next(m, "missed", T)).toMatchObject({ box: 0, seen: 7, missed: 1 });
});

test("a card is learned from box 3, and the schedule in use is one function behind its interface", () => {
  expect(SCHEDULE).toBe(boxes);
  expect(boxes.learned(undefined)).toBe(false);
  expect(boxes.learned({ box: LEARNED_BOX - 1, due: T, seen: 2, missed: 0 })).toBe(false);
  expect(boxes.learned({ box: LEARNED_BOX, due: T, seen: 3, missed: 0 })).toBe(true);
  expect(boxes.about).toMatch(/a day, then 3, 7, 16 and 35 days/);
});

test("due means seen and its time has come; a new card is new, not due", () => {
  expect(isDue(undefined, T)).toBe(false);
  expect(isDue({ box: 1, due: T, seen: 1, missed: 0 }, T)).toBe(true);
  expect(isDue({ box: 1, due: T + 1, seen: 1, missed: 0 }, T)).toBe(false);
});

test("progress per card is read defensively, and a set's standing is counted from it", () => {
  const progress = { card: 3, cards: { c1: { box: 3, due: T + DAY, seen: 3, missed: 0 }, c2: { box: 0, due: T - 1, seen: 2, missed: 2 }, c3: "nope", c4: { box: 1 } } };
  const memories = memoriesOf(progress);
  expect(Object.keys(memories)).toEqual(["c1", "c2"]);
  expect(readMemory({ due: 5 })).toEqual({ box: 0, due: 5, seen: 1, missed: 0 });
  expect(memoriesOf({ bit: 2 })).toEqual({});
  expect(memoriesOf(null)).toEqual({});
  expect(standing(["c1", "c2", "c5"], memories, T)).toEqual({ cards: 3, new: 1, due: 1, learned: 1, nextDue: T + DAY });
  expect(dueIn(progress, T)).toBe(1);
  expect(dueIn(undefined, T)).toBe(0);
});

test("when cards come back is said in plain words, grouped, soonest first", () => {
  expect(whenWords(T + 10 * 60_000, T)).toBe("in 10 minutes");
  expect(whenWords(T + 40_000, T)).toBe("in a minute");
  expect(whenWords(T + 5 * 3_600_000, T)).toBe("in 5 hours");
  expect(whenWords(T + DAY, T)).toBe("tomorrow");
  expect(whenWords(T + 7 * DAY, T)).toBe("in 7 days");
  expect(whenWords(T - 1, T)).toBe("now");
  const memories = { a: { box: 1, due: T + DAY, seen: 1, missed: 0 }, b: { box: 2, due: T + 3 * DAY, seen: 2, missed: 0 }, c: { box: 1, due: T + DAY, seen: 1, missed: 0 }, d: { box: 0, due: T - 1, seen: 1, missed: 1 } };
  expect(comingBack(["a", "b", "c", "d", "e"], memories, T)).toEqual([["tomorrow", 2], ["in 3 days", 1]]);
});

test("a sitting goes through every card, or only the due ones, and a missed card comes back a few cards on, once", () => {
  const cards = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({ id, kind: "recall", front: [], back: [], cites: [] }) as Card);
  const memories = { c2: { box: 1, due: T - 1, seen: 1, missed: 0 }, c5: { box: 0, due: T - 1, seen: 1, missed: 1 }, c6: { box: 2, due: T + DAY, seen: 2, missed: 0 } };
  expect(queueFor(cards, memories, "all", T)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(queueFor(cards, memories, "review", T)).toEqual([1, 4]);
  expect(putBack([0, 1, 2, 3, 4, 5], 0, 0)).toEqual([0, 1, 2, 3, 0, 4, 5]);
  // Near the end it goes last; already waiting later, it is not added twice.
  expect(putBack([0, 1, 2], 2, 2)).toEqual([0, 1, 2, 2]);
  expect(putBack([0, 1, 2, 3, 0], 0, 0)).toEqual([0, 1, 2, 3, 0]);
});

test("a memory keeps when it was last marked, and says how long ago in plain words", () => {
  expect(readMemory({ due: 5, last: 3 })).toEqual({ box: 0, due: 5, seen: 1, missed: 0, last: 3 });
  expect(agoWords(T - 20_000, T)).toBe("just now");
  expect(agoWords(T - 5 * 60_000, T)).toBe("5 minutes ago");
  expect(agoWords(T - 3 * 3_600_000, T)).toBe("3 hours ago");
  expect(agoWords(T - DAY, T)).toBe("yesterday");
  expect(agoWords(T - 2 * DAY, T)).toBe("2 days ago");
});
