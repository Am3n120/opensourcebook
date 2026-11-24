/**
 * Every kind of reason a plan cannot be approved or started, in one place.
 * Each issue has a stable `code` a client may branch on, a full `message`
 * that names the item by its title, and a `short` one that does not, for
 * showing on the item's own row (engine/docs/api.md, "Plan view").
 */
import type { PlanNode } from "./repositories/plans";

/** Issues about one item: the words after its title, and how they join it. */
const ITEM_ISSUES = {
  /** The item branches from an item that is not in the plan. */
  branch_parent_missing: { join: " ", words: () => "branches from an item that is not in this plan" },
  /** The item branches from an item on the same or a later stage. */
  branch_parent_not_earlier: { join: " ", words: (parent: string) => `must be in a later stage than ${parent}, the item it branches from` },
  /** The item's condition is one no resolver reads; the resolver says why. */
  condition_invalid: { join: ": ", words: (why: string) => why },
  /** The item has a condition but no earlier item to test it on. */
  condition_without_parent: { join: " ", words: () => "has a condition but no earlier item to test it on" },
  /** The item uses (by an edge) an item that is not in the plan. */
  edge_source_missing: { join: " ", words: () => "uses an item that is not in this plan" },
  /** The item uses (by an edge) an item on the same or a later stage. */
  edge_source_not_earlier: { join: " ", words: (from: string) => `must be in a later stage than ${from}, which it uses` },
  /** The item's format has no engine yet (declared only, or unknown). */
  format_not_ready: { join: ": ", words: (type: string) => `Open Sourcebook can't make a ${type} yet` },
  /** The item's format can make it, but not right now with these settings; the format says why and what to do. */
  cannot_make_now: { join: ": ", words: (why: string) => why },
  /** The item is enabled but reads no source. */
  no_sources: { join: " ", words: () => "reads no sources: pick at least one" },
  /** The item is not in a state the action needs (a retry of an item that has not failed). */
  item_status: { join: " ", words: (state: string) => state },
} as const;

/** Issues about the whole plan. */
const PLAN_ISSUES = {
  /** The estimate is over the plan's budget. */
  over_budget: (estimate: number, budget: number) => `the estimated cost $${estimate.toFixed(2)} is over the plan budget $${budget.toFixed(2)}`,
  /** No item would run. */
  no_enabled_items: () => "the plan has no enabled items",
  /** The plan is not in a state the action needs (Start of a plan that is not approved). */
  plan_status: (state: string) => state,
} as const;

export type ItemIssueCode = keyof typeof ITEM_ISSUES;
export type WholePlanIssueCode = keyof typeof PLAN_ISSUES;
export type PlanIssueCode = ItemIssueCode | WholePlanIssueCode;

/** Every code, for docs and tests. */
export const PLAN_ISSUE_CODES: readonly PlanIssueCode[] = [...(Object.keys(ITEM_ISSUES) as ItemIssueCode[]), ...(Object.keys(PLAN_ISSUES) as WholePlanIssueCode[])];

/**
 * One reason a plan cannot start. `message` names the item by its title;
 * `short` says the same without it; `itemId` is the item it is about,
 * absent for an issue about the whole plan.
 */
export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  short: string;
  itemId?: string;
}

type Args<F> = F extends (...args: infer A) => string ? A : never;

/** An item as issues name it: its title in quotes. */
export function named(node: Pick<PlanNode, "title">): string {
  return `"${node.title}"`;
}

export function itemIssue<C extends ItemIssueCode>(code: C, node: Pick<PlanNode, "id" | "title">, ...args: Args<(typeof ITEM_ISSUES)[C]["words"]>): PlanIssue {
  const entry = ITEM_ISSUES[code];
  const words = (entry.words as (...values: unknown[]) => string)(...args);
  return { code, message: `${named(node)}${entry.join}${words}`, short: sentence(words), itemId: node.id };
}

export function planIssue<C extends WholePlanIssueCode>(code: C, ...args: Args<(typeof PLAN_ISSUES)[C]>): PlanIssue {
  const words = (PLAN_ISSUES[code] as (...values: unknown[]) => string)(...args);
  return { code, message: words, short: sentence(words) };
}

/** The messages of a list of issues, as `issues` on the wire. */
export function issueMessages(issues: PlanIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

function sentence(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
