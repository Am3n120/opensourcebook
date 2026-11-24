import type { OutputSummary } from "../api/types";
import { FEED_ORDERS, dueFirst, newestUnfinished, orderFeed, type FeedEntry } from "./order";

const at = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, "0")}:00.000Z`;
function entry(id: string, minute: number, extra: Partial<FeedEntry> & { planId?: string } = {}): FeedEntry {
  const { planId, ...rest } = extra;
  const output: OutputSummary = { id, type: "flashcards", title: id, schemaVersion: 1, createdAt: at(minute), updatedAt: at(minute), ...(planId ? { planId, itemId: `i-${id}` } : {}) };
  return { output, done: false, ...rest };
}
const ids = (list: FeedEntry[]) => list.map((e) => e.output.id);

test("unfinished things come first, then finished ones", () => {
  const list = [entry("old-done", 1, { done: true }), entry("new", 5), entry("new-done", 9, { done: true }), entry("old", 2)];
  expect(ids(newestUnfinished.order(list))).toEqual(["new", "old", "new-done", "old-done"]);
});

test("the newest plan comes first, and a plan keeps its own order", () => {
  const list = [
    entry("a2", 3, { planId: "A", place: { level: 1, ord: 0 } }),
    entry("a1", 4, { planId: "A", place: { level: 0, ord: 0 } }),
    entry("b1", 6, { planId: "B", place: { level: 0, ord: 0 } }),
    entry("b2", 7, { planId: "B", place: { level: 0, ord: 1 } }),
    entry("alone", 5),
  ];
  // Plan B made something last (minute 7), then the one outside a plan (5), then plan A (4).
  expect(ids(newestUnfinished.order(list))).toEqual(["b1", "b2", "alone", "a1", "a2"]);
});

test("a plan's finished things go to the end with the other finished ones", () => {
  const list = [entry("a1", 1, { planId: "A", place: { level: 0, ord: 0 }, done: true }), entry("a2", 2, { planId: "A", place: { level: 0, ord: 1 } }), entry("x", 3)];
  expect(ids(orderFeed(list))).toEqual(["x", "a2", "a1"]);
});

test("the feed reads its order from the list, and an unknown one falls back to the first", () => {
  expect(FEED_ORDERS.map((o) => o.id)).toEqual(["due-first", "newest-unfinished"]);
  const reverse = { id: "reverse", label: "Reverse", about: "Backwards.", order: (l: readonly FeedEntry[]) => [...l].reverse() };
  const list = [entry("a", 1), entry("b", 2)];
  expect(ids(orderFeed(list, "reverse", [newestUnfinished, reverse]))).toEqual(["a", "b"].reverse());
  expect(ids(orderFeed(list, "nope"))).toEqual(["b", "a"]);
  expect(orderFeed([], undefined)).toEqual([]);
});

test("cards due for review come up first, most due first, finished or not; the rest keep the other order", () => {
  const list = [
    entry("new", 9),
    entry("old-done", 1, { done: true, due: 2 }),
    entry("mid", 5, { due: 7 }),
    entry("a1", 3, { planId: "A", place: { level: 0, ord: 0 }, done: true }),
  ];
  expect(ids(dueFirst().order(list))).toEqual(["mid", "old-done", "new", "a1"]);
  // With nothing due it is the other order exactly.
  const none = list.map((e) => ({ ...e, due: 0 }));
  expect(ids(dueFirst().order(none))).toEqual(ids(newestUnfinished.order(none)));
  // It wraps any order.
  const reverse = { id: "reverse", label: "Reverse", about: "Backwards.", order: (l: readonly FeedEntry[]) => [...l].reverse() };
  expect(ids(dueFirst(reverse).order(list))).toEqual(["mid", "old-done", "a1", "new"]);
  expect(dueFirst(reverse).about).toMatch(/^Flashcards with cards due for review come first, most due first; then: backwards\.$/);
});
