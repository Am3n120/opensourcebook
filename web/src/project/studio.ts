import type { Item, PlanView } from "../api/types";
import { orderFeed, type FeedEntry } from "../feed/order";

/** The row in Make that starts a plan: always these words, whatever the shapes. */
export const PLAN_ROW = { title: "Plan a whole subject", sub: "Items in order, made one after another" };

/**
 * Which plans the Studio panel lists: only the ones that have started
 * (running, done or stopped), and every thing made at once (which starts
 * itself). A plan never started lives in the chat that made it, where it is
 * read, edited and started.
 */
export function inStudio(view: PlanView): boolean {
  return view.plan.kickedOffAt !== undefined;
}

/**
 * Plans never started that no chat made (through the API or a seed): no
 * chat holds them, so the project menu lists them, and one opens above the
 * open chat.
 */
export function unstartedOutsideChats(views: PlanView[]): PlanView[] {
  return views.filter((v) => v.plan.kickedOffAt === undefined && !v.plan.chatId && v.plan.status !== "discarded");
}

/**
 * Where a thing made at once stands, as its row in Made here shows it: made
 * (it has something to play), being made, failed or stopped before it made
 * anything, or none of these (it ended with nothing made, such as an item
 * left out).
 */
export type DirectState = "made" | "making" | "failed" | "stopped" | "other";

export function directState(view: PlanView): DirectState {
  const item = view.items[0];
  if (!item) return "other";
  if (item.status === "done" && item.outputId) return "made";
  if (item.status === "failed") return "failed";
  if (view.plan.status === "running") return "making";
  if (view.plan.status === "cancelled") return "stopped";
  return "other";
}

/** One thing in the Studio's order: its plan, its item, and what it made once it is made. */
export interface StudioEntry {
  view: PlanView;
  item: Item;
  outputId?: string;
}

/**
 * Every item of every plan in the Studio, in the feed's own order
 * (`feed/order.ts`), so going through the Studio's list is going through the
 * phone's feed. An item not made yet takes its place in it as well, so a
 * thing being made sits where it will be.
 */
export function studioOrder(views: readonly PlanView[]): StudioEntry[] {
  const byKey = new Map<string, StudioEntry>();
  const entries: FeedEntry[] = [];
  for (const view of views.filter(inStudio)) {
    const at = view.plan.kickedOffAt ?? view.plan.createdAt;
    for (const item of view.items) {
      if (!item.enabled || item.status === "skipped") continue;
      const id = item.outputId ?? `item:${item.id}`;
      byKey.set(id, { view, item, ...(item.outputId ? { outputId: item.outputId } : {}) });
      entries.push({
        output: { id, type: item.type, title: item.title, planId: view.plan.id, itemId: item.id, schemaVersion: 1, createdAt: at, updatedAt: at },
        place: { level: item.level, ord: item.ord },
        done: item.done,
      });
    }
  }
  return orderFeed(entries).map((entry) => byKey.get(entry.output.id)!);
}

/** The Studio's list: each plan once, where its first thing falls in the order; a thing made at once is its own row. */
export function studioRows(views: readonly PlanView[]): PlanView[] {
  const seen = new Set<string>();
  const rows: PlanView[] = [];
  for (const entry of studioOrder(views)) {
    if (seen.has(entry.view.plan.id)) continue;
    seen.add(entry.view.plan.id);
    rows.push(entry.view);
  }
  // A started plan with nothing to make (every item left out) still has its row, last.
  for (const view of views.filter(inStudio)) if (!seen.has(view.plan.id)) rows.push(view);
  return rows;
}

/** What plays one after another from the Studio: the made things, in the Studio's order. */
export function playOrder(views: readonly PlanView[]): StudioEntry[] {
  return studioOrder(views).filter((entry) => entry.outputId);
}
