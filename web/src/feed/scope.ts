import type { FeedEntry } from "./order";

/** A project the feed can be narrowed to, with how much of it is there. */
export interface FeedProject {
  id: string;
  title: string;
  /** Things of it in the feed. */
  count: number;
  /** Of those, the ones not finished yet. */
  left: number;
}

/**
 * The projects that have something in the feed, the one with most left to do
 * first, then by name. Things made outside a project are in the whole feed
 * only, so they are not a project to pick.
 */
export function feedProjects(entries: readonly FeedEntry[]): FeedProject[] {
  const byId = new Map<string, FeedProject>();
  for (const e of entries) {
    const id = e.output.projectId;
    if (!id) continue;
    const p = byId.get(id) ?? { id, title: e.projectTitle ?? "Project", count: 0, left: 0 };
    p.count += 1;
    if (!e.done) p.left += 1;
    byId.set(id, p);
  }
  return [...byId.values()].sort((a, b) => b.left - a.left || a.title.localeCompare(b.title));
}

/** How many things have cards due now: the number on the Due chip. */
export function dueCount(entries: readonly FeedEntry[]): number {
  return entries.filter((e) => (e.due ?? 0) > 0).length;
}

/**
 * The feed narrowed to one project, or to what has cards due now, and to
 * what a search finds in a thing's title, its project's or its plan's name;
 * keeping its order. Every project when none is named.
 */
export function inScope(entries: readonly FeedEntry[], projectId?: string | null, options: { due?: boolean; search?: string } = {}): FeedEntry[] {
  const words = (options.search ?? "").trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!projectId || e.output.projectId === projectId) &&
      (!options.due || (e.due ?? 0) > 0) &&
      (!words || [e.output.title, e.projectTitle, e.planTitle].some((t) => t?.toLowerCase().includes(words))),
  );
}
