/**
 * The planner model's JSON read into a `DraftPlan` (a new plan) or applied
 * to one as changes (an edit). Anything malformed becomes an issue in
 * words the model can fix on the next round; nothing is guessed.
 */
import { isRecord } from "../../net";
import { isDay } from "../../studio/days";
import type { JsonValue } from "../../studio/types";
import { edgeKind, settingsOf, type DraftEdge, type DraftItem, type DraftPlan, type DraftSource } from "./draft";
import type { SourceMap } from "./sources";

export interface ReadResult {
  draft: DraftPlan;
  reply: string;
  issues: string[];
}

/** Fields an item carries in a new plan and in an `add` op. */
interface ItemLinks {
  branchOf?: { item: string; condition: JsonValue };
  assumes: string[];
  inputs: Array<{ item: string; kind: string }>;
}

/**
 * `continues`, when the stages are added at the end of a plan that exists:
 * the level its last stage has, and its items by the refs the planner was
 * shown (I1, I2, ...), which the new items may name in their links.
 */
export function readNewPlan(raw: unknown, map: SourceMap, continues?: { lastLevel: number; refs: ReadonlyMap<string, string> }): ReadResult {
  const issues: string[] = [];
  const draft: DraftPlan = { labels: new Map(), dates: new Map(), items: [], edges: [] };
  if (!isRecord(raw)) return { draft, reply: "", issues: ["the answer was not a JSON object"] };
  if (typeof raw.title === "string" && raw.title.trim()) draft.title = raw.title.trim().slice(0, 200);
  if (typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 0) draft.budgetUsd = raw.budgetUsd;
  const stages = Array.isArray(raw.stages) ? raw.stages : [];
  if (stages.length === 0) issues.push('"stages" must be a non-empty list');
  const links = new Map<string, ItemLinks>();
  stages.forEach((stage, index) => {
    const level = (continues?.lastLevel ?? 0) + index + 1;
    if (!isRecord(stage) || !Array.isArray(stage.items) || stage.items.length === 0) {
      issues.push(`stage ${level} must have a non-empty "items" list`);
      return;
    }
    if (typeof stage.label === "string" && stage.label.trim()) draft.labels.set(level, stage.label.trim().slice(0, 200));
    if (stage.dueOn !== undefined && stage.dueOn !== null) {
      if (isDay(stage.dueOn)) draft.dates!.set(level, stage.dueOn);
      else issues.push(`stage ${level}: "dueOn" must be a day written YYYY-MM-DD`);
    }
    stage.items.forEach((entry, ord) => {
      const read = readItem(entry, `stage ${level} item ${ord + 1}`, map, issues);
      if (!read) return;
      draft.items.push({ ...read.item, level, ord });
      links.set(read.item.key, read.links);
    });
  });
  const resolve = (ref: string) => (draft.items.some((item) => item.key === ref) ? ref : continues?.refs.get(ref.trim().toUpperCase()));
  for (const [key, link] of links) applyLinks(draft, key, link, resolve, issues);
  return { draft, reply: typeof raw.reply === "string" ? raw.reply.trim() : "", issues };
}

/**
 * One item as the model wrote it. `key` must be new; the caller places the
 * item (level, ord).
 */
export function readItem(
  entry: unknown,
  where: string,
  map: SourceMap,
  issues: string[],
): { item: Omit<DraftItem, "level" | "ord">; links: ItemLinks } | undefined {
  if (!isRecord(entry)) {
    issues.push(`${where} must be an object`);
    return undefined;
  }
  const key = typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : undefined;
  if (!key) issues.push(`${where} needs a "key"`);
  const type = typeof entry.format === "string" ? entry.format.trim() : "";
  if (!type) issues.push(`${where} needs a "format"`);
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const sources = readSources(entry.sources, where, map, issues) ?? [];
  if (!key) return undefined;
  return {
    item: {
      key,
      existing: false,
      type,
      title,
      prompt: typeof entry.brief === "string" ? entry.brief.trim() : "",
      settings: settingsOf(entry.settings),
      sources,
      enabled: entry.enabled !== false,
    },
    links: readLinks(entry, where, issues),
  };
}

export function readSources(value: unknown, where: string, map: SourceMap, issues: string[]): DraftSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${where}: "sources" must be a list of { source, from?, to? }`);
    return [];
  }
  const out: DraftSource[] = [];
  for (const ref of value) {
    if (!isRecord(ref) || typeof ref.source !== "string") {
      issues.push(`${where}: each source is { "source": "S1", "from"?: n, "to"?: n }`);
      continue;
    }
    const resolved = map.resolve({
      source: ref.source,
      ...(typeof ref.from === "number" ? { from: ref.from } : {}),
      ...(typeof ref.to === "number" ? { to: ref.to } : {}),
    });
    if (typeof resolved === "string") issues.push(`${where}: ${resolved}`);
    else if (!out.some((known) => known.sourceId === resolved.sourceId)) out.push(resolved);
    else issues.push(`${where}: ${ref.source} is listed twice; give one run of passages per source`);
  }
  return out;
}

function readLinks(entry: Record<string, unknown>, where: string, issues: string[]): ItemLinks {
  const links: ItemLinks = { assumes: [], inputs: [] };
  if (entry.branchOf !== undefined && entry.branchOf !== null) {
    const branch = readBranch(entry.branchOf, where, issues);
    if (branch) links.branchOf = branch;
  }
  if (Array.isArray(entry.assumes)) for (const ref of entry.assumes) if (typeof ref === "string") links.assumes.push(ref.trim());
  if (Array.isArray(entry.inputs)) {
    for (const input of entry.inputs) {
      const kind = isRecord(input) ? edgeKind(input.kind) : undefined;
      if (!isRecord(input) || typeof input.item !== "string" || !kind) issues.push(`${where}: each input is { "item": "<key>", "kind": "<lower_snake word>" }`);
      else links.inputs.push({ item: input.item.trim(), kind });
    }
  }
  return links;
}

export function readBranch(value: unknown, where: string, issues: string[]): { item: string; condition: JsonValue } | undefined {
  if (!isRecord(value) || typeof value.item !== "string" || !isRecord(value.condition)) {
    issues.push(`${where}: "branchOf" is { "item": "<earlier item>", "condition": { "kind": ... } }`);
    return undefined;
  }
  return { item: value.item.trim(), condition: value.condition as JsonValue };
}

/** Sets an item's parent and edges from its links; `resolve` turns a reference into an item key. */
export function applyLinks(draft: DraftPlan, key: string, links: ItemLinks, resolve: (ref: string) => string | undefined, issues: string[]): void {
  const item = draft.items.find((candidate) => candidate.key === key);
  if (!item) return;
  const name = `item "${item.title || key}"`;
  if (links.branchOf) {
    const parent = resolve(links.branchOf.item);
    if (!parent) issues.push(`${name}: branchOf names "${links.branchOf.item}", which is not an item`);
    else {
      item.parentKey = parent;
      item.condition = links.branchOf.condition;
    }
  }
  const add = (from: string, kind: string) => {
    const resolved = resolve(from);
    if (!resolved) {
      issues.push(`${name}: "${from}" is not an item`);
      return;
    }
    const edge: DraftEdge = { from: resolved, to: key, kind };
    if (!draft.edges.some((known) => known.from === edge.from && known.to === edge.to && known.kind === edge.kind)) draft.edges.push(edge);
  };
  for (const ref of links.assumes) add(ref, "assumes");
  for (const input of links.inputs) add(input.item, input.kind);
}

export type { ItemLinks };
