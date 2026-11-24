/**
 * The plan panel's logic, kept out of its components: where a plan stands,
 * who makes each item and how long that took here before, and what a whole
 * plan adds up to. Times come only from past runs on this computer
 * (make/makeTime.ts); nothing is guessed, and nothing here names a format.
 */
import type { AgentPick, FormatDescriptor, Item, JsonObject, PlanView, Provider } from "../api/types";
import type { MakingState } from "../design/Making";
import { findFormat } from "../design/formatLook";
import { rowPick } from "../make/madeBy";
import { timeResult, totalWords, type LoadedTimes, type MakeTimeResult, type TimeWords } from "../make/makeTime";
import { agentField, defaultEffortId, defaultModelId, timeKey, turnKindOf, type MakerPick } from "../make/makerKey";
import { minutesOf } from "./planModel";
import { timeBucket } from "./timing";

/** Where a plan is, as the panel draws it. */
export type Phase = "draft" | "running" | "stopped" | "done" | "discarded";

export function phaseOf(view: Pick<PlanView, "plan">): Phase {
  switch (view.plan.status) {
    case "draft":
    case "approved":
      return "draft";
    case "running":
      return "running";
    // A failed plan stopped on something it could not make: Try again on that item, or change who makes what is left.
    case "cancelled":
    case "failed":
      return "stopped";
    case "done":
      return "done";
    default:
      return "discarded";
  }
}

/** The one word beside the plan's title, in the progress look's own states. */
export function statusWords(phase: Phase): { text: string; state: MakingState } {
  switch (phase) {
    case "draft":
      return { text: "Not started", state: "stopped" };
    case "running":
      return { text: "Making", state: "making" };
    case "stopped":
      return { text: "Stopped", state: "stopped" };
    case "done":
      return { text: "All made", state: "done" };
    default:
      return { text: "Discarded", state: "stopped" };
  }
}

/** A pick in short words: "Z Mid · medium", the model's and the effort's own labels (the provider's defaults when none is picked). */
export function pickWords(pick: MakerPick, providers: readonly Provider[], turnKind: "chat" | "work" = "work"): string {
  const p = providers.find((x) => x.id === pick.agent);
  if (!p) return pick.model ?? pick.agent;
  const modelId = pick.model ?? defaultModelId(p, turnKind);
  const model = (modelId && p.models.find((m) => m.id === modelId)?.label) || modelId || p.label;
  const effortId = pick.effort ?? defaultEffortId(p, turnKind);
  const effort = effortId ? p.efforts.find((e) => e.id === effortId)?.label : undefined;
  return effort ? `${model} · ${effort.toLowerCase()}` : model;
}

export interface ItemMaker {
  format?: FormatDescriptor;
  /** Who makes it; undefined for a format made without the person's agent, or when nobody is picked. */
  maker?: MakerPick;
  /** Who reviews it; null when nobody does (off, or a format with no reviewer). */
  reviewer: MakerPick | null;
  /** The maker's time and then the reviewer's; absent for a format made without an agent. */
  parts?: MakeTimeResult[];
}

function roleTime(times: LoadedTimes, format: FormatDescriptor, settings: JsonObject, pick: MakerPick | undefined, providers: readonly Provider[], role: "maker" | "reviewer"): MakeTimeResult {
  const p = pick && providers.find((x) => x.id === pick.agent);
  // Nobody picked, or an agent no longer on this computer: nothing has run with it here.
  if (!pick || !p) return times === undefined ? { status: "loading" } : { status: "none" };
  const scope = role === "reviewer" ? `${format.id}.review` : format.id;
  const bucket = timeBucket(format, { ...format.defaults, ...settings });
  return timeResult(times, timeKey(scope, p, pick, turnKindOf(format, role), bucket));
}

/**
 * Who makes and reviews an item, read the way the make sheet reads it
 * (make/madeBy.ts), and the times each took here before for its exact pick
 * and length. A reviewer left open with no default reviews with the maker's pick.
 */
export function itemMaker(item: Pick<Item, "type" | "settings">, formats: readonly FormatDescriptor[], providers: readonly Provider[], picks: Record<string, AgentPick> | undefined, times: LoadedTimes): ItemMaker {
  const format = findFormat(formats, item.type);
  if (!format || !agentField(format, "maker")) return { ...(format ? { format } : {}), reviewer: null };
  const maker = rowPick(format, item.settings, "maker", picks).pick ?? undefined;
  let reviewer: MakerPick | null = null;
  if (agentField(format, "reviewer")) {
    const r = rowPick(format, item.settings, "reviewer", picks);
    reviewer = r.from === "none" ? (maker ?? null) : r.pick;
  }
  const parts = [roleTime(times, format, item.settings, maker, providers, "maker")];
  if (reviewer) parts.push(roleTime(times, format, item.settings, reviewer, providers, "reviewer"));
  return { format, ...(maker ? { maker } : {}), reviewer, parts };
}

/** An item's time in words: "about 6 min", or "no time yet"; undefined while loading or for a format made without an agent. */
export function itemTimeWords(m: ItemMaker): TimeWords | undefined {
  return m.parts ? totalWords(m.parts) : undefined;
}

/**
 * The time to make a set of items, one after another: "about 22 min" when
 * every part has a past run here, "no time yet" when any has none, and
 * undefined while loading or when none of them is made with an agent.
 */
export function planTimeWords(makers: ReadonlyArray<ItemMaker | undefined>): TimeWords | undefined {
  const parts = makers.flatMap((m) => m?.parts ?? []);
  return parts.length ? totalWords(parts) : undefined;
}

/** Items still to make: in the plan, not made and not skipped. */
export function leftToMake(items: readonly Item[]): Item[] {
  return items.filter((i) => i.enabled && !i.outputId && i.status !== "skipped" && i.status !== "done");
}

/**
 * How long the ticked things take to watch or listen to: the sum of each
 * item's length in minutes, said only when every item that has a length
 * has one set (an Auto length is decided when it is made).
 */
export function watchMinutes(items: readonly Item[], formats: readonly FormatDescriptor[]): number | undefined {
  let total = 0;
  for (const item of items) {
    if (!item.enabled) continue;
    const format = findFormat(formats, item.type);
    if (!format?.settings.some((f) => f.kind === "number" && f.unit === "min")) continue;
    const minutes = minutesOf(format, item.settings);
    if (minutes === undefined) return undefined;
    total += minutes;
  }
  return total > 0 ? total : undefined;
}

/**
 * Who makes the ticked items, by shape, in plan order: "videos Z Mid ·
 * medium, reviewed by Z Mid · low". A shape whose items differ says "a mix".
 */
export function makersByShape(items: readonly Item[], makers: ReadonlyMap<string, ItemMaker>, providers: readonly Provider[]): Array<{ shape: string; words: string }> {
  const out = new Map<string, string>();
  for (const item of items) {
    const m = makers.get(item.id);
    if (!item.enabled || !m?.maker || !m.format) continue;
    const shape = m.format.plural ?? `${m.format.label}s`;
    const reviewed = agentField(m.format, "reviewer") ? (m.reviewer ? `, reviewed by ${pickWords(m.reviewer, providers, turnKindOf(m.format, "reviewer"))}` : ", no review") : "";
    const words = `${pickWords(m.maker, providers, turnKindOf(m.format, "maker"))}${reviewed}`;
    const had = out.get(shape);
    out.set(shape, had !== undefined && had !== words ? "a mix" : words);
  }
  return [...out].map(([shape, words]) => ({ shape, words }));
}

/** Whether every ticked item is made by the person's defaults, with nothing picked for it alone. */
export function allDefaults(items: readonly Item[], formats: readonly FormatDescriptor[], picks: Record<string, AgentPick> | undefined): boolean {
  return items.every((item) => {
    const format = findFormat(formats, item.type);
    if (!item.enabled || !format) return true;
    return (["maker", "reviewer"] as const).every((role) => !agentField(format, role) || rowPick(format, item.settings, role, picks).from !== "own");
  });
}
