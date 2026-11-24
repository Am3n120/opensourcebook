import type { Condition, Item, ItemInput, ItemPatch, ItemSource, JsonObject } from "../api/types";
import { diffItem, parseCondition } from "./planModel";

/** The item form's state: strings where an input holds text. */
export interface Draft {
  type: string;
  title: string;
  prompt: string;
  settings: JsonObject;
  sources: ItemSource[];
  parentId: string;
  conditionText: string;
  enabled: boolean;
}

export function draftOf(item: Item): Draft {
  return {
    type: item.type,
    title: item.title,
    prompt: item.prompt ?? "",
    settings: item.settings,
    sources: item.sources,
    parentId: item.parentId ?? "",
    conditionText: item.condition ? JSON.stringify(item.condition) : "",
    enabled: item.enabled,
  };
}

export const EMPTY: Draft = { type: "", title: "", prompt: "", settings: {}, sources: [], parentId: "", conditionText: "", enabled: true };

type Result<T> = { value: T } | { error: string };

/** The engine prices every item by its format, so the form sends no estimate. */
function common(draft: Draft): Result<{ condition: Condition | null }> {
  const parsed = parseCondition(draft.parentId ? draft.conditionText : "");
  if (!parsed.ok) return { error: parsed.message };
  return { value: { condition: parsed.condition } };
}

export function toInput(draft: Draft, level: number): Result<ItemInput> {
  const c = common(draft);
  if ("error" in c) return c;
  return {
    value: {
      type: draft.type,
      title: draft.title.trim(),
      level,
      ...(draft.prompt.trim() ? { prompt: draft.prompt } : {}),
      settings: draft.settings,
      sources: draft.sources,
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(c.value.condition ? { condition: c.value.condition } : {}),
      enabled: draft.enabled,
    },
  };
}

export function toPatch(before: Draft, after: Draft): Result<ItemPatch> {
  const c = common(after);
  if ("error" in c) return c;
  const b = common(before);
  const shape = (d: Draft, x: { condition: Condition | null }) => ({
    type: d.type,
    title: d.title.trim(),
    prompt: d.prompt,
    settings: d.settings,
    sources: d.sources,
    parentId: d.parentId || null,
    condition: x.condition,
  });
  return { value: diffItem(shape(before, "error" in b ? c.value : b.value), shape(after, c.value)) as ItemPatch };
}

/** A key that remounts the details when the item changes on the server, so the form shows what was saved. */
export function itemKey(item: Item): string {
  return `${item.id}:${JSON.stringify(draftOf(item))}`;
}
