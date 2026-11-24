import type { FeedEntry } from "./order";
import { dueCount, feedProjects, inScope } from "./scope";

const entry = (id: string, projectId: string | undefined, done: boolean, projectTitle?: string): FeedEntry => ({
  output: { id, type: "quiz", title: id, schemaVersion: 1, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", ...(projectId ? { projectId } : {}) },
  ...(projectTitle ? { projectTitle } : {}),
  done,
});

const feed = [
  entry("a1", "pa", true, "Algebra"),
  entry("b1", "pb", false, "Biology"),
  entry("a2", "pa", false, "Algebra"),
  entry("loose", undefined, false),
  entry("b2", "pb", false, "Biology"),
  entry("c1", "pc", true, "Chemistry"),
];

test("every project with something in the feed, most left to do first, then by name", () => {
  expect(feedProjects(feed)).toEqual([
    { id: "pb", title: "Biology", count: 2, left: 2 },
    { id: "pa", title: "Algebra", count: 2, left: 1 },
    { id: "pc", title: "Chemistry", count: 1, left: 0 },
  ]);
});

test("narrowing to a project keeps the feed's order; no project is the whole feed", () => {
  expect(inScope(feed, "pa").map((e) => e.output.id)).toEqual(["a1", "a2"]);
  expect(inScope(feed, "nowhere")).toEqual([]);
  expect(inScope(feed).map((e) => e.output.id)).toEqual(feed.map((e) => e.output.id));
  expect(inScope(feed, null)).toHaveLength(feed.length);
});

test("what is due, and what a search finds in a title, project or plan, narrow the feed too", () => {
  const withDue = feed.map((e) => (e.output.id === "b2" ? { ...e, due: 4 } : e));
  expect(dueCount(withDue)).toBe(1);
  expect(inScope(withDue, null, { due: true }).map((e) => e.output.id)).toEqual(["b2"]);
  expect(inScope(withDue, "pa", { due: true })).toEqual([]);
  expect(inScope(feed, null, { search: " BIO " }).map((e) => e.output.id)).toEqual(["b1", "b2"]);
  expect(inScope(feed, null, { search: "loose" }).map((e) => e.output.id)).toEqual(["loose"]);
  expect(inScope(feed, "pa", { search: "bio" })).toEqual([]);
});
