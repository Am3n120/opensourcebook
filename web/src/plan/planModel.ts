/**
 * The plan view's logic, kept out of the components: stages in run order,
 * branches by depth, the reorders an edit sends, and what an item's
 * settings form shows. Nothing here names a format or a condition kind.
 */
import type { AgentPick, Condition, Edge, EdgeKind, FormatDescriptor, IssueDetail, Item, JsonObject, Json, PlanStatus, PlanView, SettingField, Stage } from "../api/types";

export interface Row {
  item: Item;
  /** How far to indent: the number of parents above it (docs/DECISIONS.md #19). */
  depth: number;
  parent?: Item;
}

export interface StageGroup {
  level: number;
  /** 1-based position among the plan's stages, for "Stage 2". */
  number: number;
  label?: string;
  /** The day the person means to go through it by, YYYY-MM-DD. */
  dueOn?: string;
  rows: Row[];
}

/**
 * Why Start would refuse the plan, split by where each is said: an issue
 * about one item on that item's row (its `short` words), the rest under the
 * plan. An engine that sends no `issueDetails` has every issue under the plan.
 */
export function splitIssues(view: Pick<PlanView, "issues" | "issueDetails">): { plan: string[]; byItem: Map<string, IssueDetail[]> } {
  const byItem = new Map<string, IssueDetail[]>();
  if (!view.issueDetails) return { plan: view.issues, byItem };
  const plan: string[] = [];
  for (const d of view.issueDetails) {
    if (d.itemId) byItem.set(d.itemId, [...(byItem.get(d.itemId) ?? []), d]);
    else plan.push(d.message);
  }
  return { plan, byItem };
}

/**
 * The one fix an item's issue offers on its row, by the issue's `code`:
 * reading nothing opens the source picker, the rest open the item's editor.
 * A code this client does not know gets the editor too.
 */
export function issueFix(code: string): { label: string; toSources: boolean } {
  if (code === "no_sources") return { label: "Pick sources", toSources: true };
  if (code === "format_not_ready") return { label: "Change format", toSources: false };
  return { label: "Edit", toSources: false };
}

/** A plan that never ran and never will (cancelled before Start), or one that is over. */
/** The one wording for playing a made thing or a plan: Play, then the name of what opens. */
export const playLabel = (name: string): string => `Play ${name}`;

export function isFinished(status: PlanStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "discarded";
}

/** Item edits are allowed only before Start (engine/docs/api.md, "Editing items"). */
export function canEditItems(status: PlanStatus): boolean {
  return status === "draft" || status === "approved";
}

export function byRunOrder(a: Pick<Item, "level" | "ord">, b: Pick<Item, "level" | "ord">): number {
  return a.level - b.level || a.ord - b.ord;
}

/** Parents above an item, nearest first; stops on a missing parent or a loop. */
export function ancestors(items: readonly Item[], item: Item): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: Item[] = [];
  const seen = new Set([item.id]);
  let next = item.parentId ? byId.get(item.parentId) : undefined;
  while (next && !seen.has(next.id)) {
    out.push(next);
    seen.add(next.id);
    next = next.parentId ? byId.get(next.parentId) : undefined;
  }
  return out;
}

/** Groups items into stages by level, in run order, each row with its branch depth. */
export function buildStages(items: readonly Item[], stages: readonly Stage[]): StageGroup[] {
  const byLevel = new Map(stages.map((s) => [s.level, s]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const levels = [...new Set(items.map((i) => i.level))].sort((a, b) => a - b);
  return levels.map((level, index) => {
    const rows = items
      .filter((i) => i.level === level)
      .sort(byRunOrder)
      .map((item) => {
        const parent = item.parentId ? byId.get(item.parentId) : undefined;
        return { item, depth: ancestors(items, item).length, ...(parent ? { parent } : {}) };
      });
    const { label, dueOn } = byLevel.get(level) ?? {};
    return { level, number: index + 1, ...(label ? { label } : {}), ...(dueOn ? { dueOn } : {}), rows };
  });
}

export interface Placement {
  id: string;
  level: number;
  ord: number;
}

/** The placements that differ from the items as they are: what a reorder sends. */
function changed(items: readonly Item[], placements: Placement[]): Placement[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return placements.filter((p) => {
    const i = byId.get(p.id);
    return !i || i.level !== p.level || i.ord !== p.ord;
  });
}

function levelIds(items: readonly Item[], level: number, without?: string): string[] {
  return items
    .filter((i) => i.level === level && i.id !== without)
    .sort(byRunOrder)
    .map((i) => i.id);
}

function place(ids: string[], level: number): Placement[] {
  return ids.map((id, ord) => ({ id, level, ord }));
}

/** Moves an item one place up (-1) or down (+1) within its stage. */
export function moveWithinStage(items: readonly Item[], id: string, delta: -1 | 1): Placement[] {
  const item = items.find((i) => i.id === id);
  if (!item) return [];
  const ids = levelIds(items, item.level);
  const at = ids.indexOf(id);
  const to = at + delta;
  if (to < 0 || to >= ids.length) return [];
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return changed(items, place(ids, item.level));
}

/** Moves an item to the end of another stage (a level with no items starts a new one). */
export function moveToStage(items: readonly Item[], id: string, level: number): Placement[] {
  const item = items.find((i) => i.id === id);
  if (!item || item.level === level || level < 0) return [];
  const from = levelIds(items, item.level, id);
  const to = [...levelIds(items, level), id];
  return changed(items, [...place(from, item.level), ...place(to, level)]);
}

/**
 * The stage an item moves to with "earlier" (-1) or "later" (+1): the
 * neighbouring stage, or a new one before the first or after the last.
 * Undefined when the item is already alone at that end.
 */
export function neighbourLevel(items: readonly Item[], id: string, delta: -1 | 1): number | undefined {
  const item = items.find((i) => i.id === id);
  if (!item) return undefined;
  const levels = [...new Set(items.map((i) => i.level))].sort((a, b) => a - b);
  const next = levels[levels.indexOf(item.level) + delta];
  if (next !== undefined) return next;
  const alone = items.filter((i) => i.level === item.level).length === 1;
  if (alone) return undefined;
  if (delta === 1) return item.level + 1;
  return item.level > 0 ? item.level - 1 : undefined;
}

/** The level a new stage at the end takes. */
export function newStageLevel(items: readonly Item[]): number {
  return items.length === 0 ? 1 : Math.max(...items.map((i) => i.level)) + 1;
}

/** An item and every branch under it: what removing it removes too. */
export function withBranches(items: readonly Item[], id: string): Item[] {
  const out = items.filter((i) => i.id === id);
  for (let k = 0; k < out.length; k++) {
    const current = out[k]!;
    for (const child of items) if (child.parentId === current.id && !out.includes(child)) out.push(child);
  }
  return out;
}

/** Items a branch may hang under: on a lower stage, and not the item or its own branches. */
export function parentOptions(items: readonly Item[], item: Pick<Item, "level"> & { id?: string }): Item[] {
  const below = item.id ? new Set(withBranches(items, item.id).map((i) => i.id)) : new Set<string>();
  return items.filter((i) => i.level < item.level && !below.has(i.id)).sort(byRunOrder);
}

/** Items an edge into this item may come from: on a lower stage. */
export function edgeSources(items: readonly Item[], item: Item): Item[] {
  return items.filter((i) => i.level < item.level).sort(byRunOrder);
}

export function edgesOf(edges: readonly Edge[], itemId: string): { into: Edge[]; outOf: Edge[] } {
  return { into: edges.filter((e) => e.to === itemId), outOf: edges.filter((e) => e.from === itemId) };
}

/** A branch condition in words. Shapes the README documents read naturally; any other kind shows its fields. */
export function conditionText(condition: Condition | undefined, parentTitle?: string): string {
  if (!condition) return parentTitle ? `Under “${parentTitle}”` : "";
  const on = parentTitle ? ` on “${parentTitle}”` : "";
  const c = condition as JsonObject;
  // A score is a share from 0 to 1 (a quiz's grade); said as a percentage, the way a person reads a mark.
  const pct = (v: number) => (c.metric === "score" && v >= 0 && v <= 1 ? `${Math.round(v * 100)}%` : undefined);
  if (typeof c.metric === "string" && typeof c.below === "number") {
    const p = pct(c.below);
    return p ? `If you score under ${p}${on}` : `If ${c.metric} is below ${c.below}${on}`;
  }
  if (typeof c.metric === "string" && typeof c.atLeast === "number") {
    const p = pct(c.atLeast);
    return p ? `If you score ${p} or more${on}` : `If ${c.metric} is at least ${c.atLeast}${on}`;
  }
  if (condition.kind === "ask") return typeof c.question === "string" && c.question ? `Ask me: ${c.question}` : `Ask me${on}`;
  const rest = Object.entries(c)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
    .join(", ");
  return `If ${condition.kind}${rest ? ` (${rest})` : ""}${on}`;
}

/** How a link between items reads: the engine's label for its kind, else the kind in words. */
export function edgeKindLabel(kinds: readonly EdgeKind[], kind: string): string {
  const label = kinds.find((k) => k.id === kind)?.label;
  if (label) return label;
  const words = inWords(kind);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A code in words: "fix_of" and "fixOf" read "fix of". Used only for a link kind the engine does not list. */
export function inWords(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * What a person's run through an item reported, in the format's words: each
 * number its `reports` declares, in that order, named by its `label` and
 * shown by its `unit` (a `share` as a percentage). The rest of a result is
 * bookkeeping, and a format that declares none shows nothing.
 */
export function resultText(result: Json | undefined, format?: FormatDescriptor): string | undefined {
  if (result === undefined || result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const parts = (format?.reports ?? []).flatMap((report) => {
    const v = result[report.metric];
    if (typeof v !== "number") return [];
    const shown = report.unit === "share" && v >= 0 && v <= 1 ? `${Math.round(v * 100)}%` : String(v);
    return [`${report.label} ${shown}`];
  });
  return parts.length ? parts.join(" · ") : undefined;
}

/** Parses the condition editor's text: empty is none, else a JSON object with a string `kind`. */
export function parseCondition(text: string): { ok: true; condition: Condition | null } | { ok: false; message: string } {
  if (!text.trim()) return { ok: true, condition: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "The condition is not valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "The condition must be an object." };
  if (typeof (value as { kind?: unknown }).kind !== "string") return { ok: false, message: "The condition needs a \"kind\"." };
  return { ok: true, condition: value as Condition };
}

const KNOWN_KINDS = new Set(["choice", "choices", "number", "toggle", "text", "textList", "agent"]);

/**
 * The fields a settings form shows: not hidden, of a kind this client draws,
 * and, given the item's settings, only those whose `showWhen` holds (the
 * other setting's value, or its default when the item sets none).
 */
export function visibleFields(format: FormatDescriptor | undefined, settings?: JsonObject): SettingField[] {
  return (format?.settings ?? []).filter((f) => !f.hidden && KNOWN_KINDS.has(f.kind) && (!settings || !f.showWhen || showing(format, settings, f.showWhen)));
}

function showing(format: FormatDescriptor | undefined, settings: JsonObject, when: { key: string; in: string[] }): boolean {
  const value = fieldValue(format, settings, when.key);
  return typeof value === "string" && when.in.includes(value);
}

/** "%" and other signs sit against the number; a word unit gets a space. */
function withUnit(value: string, unit: string | undefined): string {
  if (!unit) return value;
  return /^[^\p{L}\p{N}]/u.test(unit) ? `${value}${unit}` : `${value} ${unit}`;
}

/**
 * Sentence-case labels joined into one phrase: "Multiple choice and worked,
 * step-checked". A later label's first letter goes lower case unless its
 * first word is written in capitals ("PDF"), which keeps a short code as it is.
 */
export function joinLabels(labels: readonly string[]): string {
  const shown = labels.map((l, k) => (k > 0 && /^\p{Lu}\p{Ll}/u.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l));
  return new Intl.ListFormat("en", { type: "conjunction" }).format(shown);
}

/** The special value a number holds, if it holds one ("0" is "Fit to the brief"). */
export function specialValue(field: SettingField, value: Json | undefined) {
  return field.kind === "number" ? field.specialValues?.find((v) => v.value === value) : undefined;
}

/** One setting's value in words, with the descriptor's labels: never a code. */
export function settingText(field: SettingField, value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  switch (field.kind) {
    case "choice":
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case "choices": {
      if (!Array.isArray(value)) return String(value);
      const words = new Map(field.options.map((o) => [o.value, o.label]));
      const shown = value.filter((v): v is string => typeof v === "string").map((v) => words.get(v) ?? v);
      return shown.length ? joinLabels(shown) : undefined;
    }
    case "toggle":
      return value ? "on" : "off";
    case "number": {
      if (typeof value !== "number") return String(value);
      const special = specialValue(field, value);
      if (special) return special.label;
      // A length in minutes reads as the card header and the engine say it: seconds under a minute.
      return field.unit === "min" ? durationText(value) : withUnit(String(value), field.unit);
    }
    case "textList": {
      if (!Array.isArray(value)) return String(value);
      const shown = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
      return shown.length ? new Intl.ListFormat(undefined, { type: "conjunction" }).format(shown) : undefined;
    }
    case "agent": {
      if (typeof value !== "string") return undefined;
      if (value === "auto" || value === "agent") return "Default";
      if (value.startsWith("agent:")) {
        const [, agent, ...rest] = value.split(":");
        const model = rest.join(":");
        if (!agent) return "Default";
        return model ? `${agent} (${model})` : agent;
      }
      return value;
    }
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

/** An item's settings as labelled lines, from the descriptor: what the card and "Brief and sources" show. */
export function settingsLines(format: FormatDescriptor | undefined, settings: JsonObject): Array<{ label: string; text: string }> {
  return visibleFields(format, settings).flatMap((f) => {
    const text = settingText(f, fieldValue(format, settings, f.key));
    if (text === undefined) return [];
    if (f.kind === "agent" && f.effortKey) {
      const rawEffort = fieldValue(format, settings, f.effortKey);
      const effort = typeof rawEffort === "string" && rawEffort !== "auto" ? rawEffort : undefined;
      if (effort) {
        const m = text.match(/^(.+?)\s+\((.+)\)$/);
        return [{ label: f.label, text: m ? `${m[1]} (${m[2]}, ${effort} effort)` : `${text} (${effort} effort)` }];
      }
    }
    return [{ label: f.label, text }];
  });
}

/** Seeds remembered `agent_picks` onto a format's `kind: "agent"` settings, for newly added/switched items. */
export function seedRememberedPicks(format: FormatDescriptor | undefined, picks: Record<string, AgentPick> | undefined): JsonObject {
  const out: JsonObject = {};
  if (!format || !picks) return out;
  const pick = picks[format.id];
  if (!pick) return out;
  for (const field of format.settings) {
    if (field.kind !== "agent") continue;
    if (pick.agent) out[field.key] = pick.model ? `agent:${pick.agent}:${pick.model}` : `agent:${pick.agent}`;
    if (field.effortKey && pick.effort) out[field.effortKey] = pick.effort;
  }
  return out;
}

/** A field's value: what the item set, else the format's default. */
export function fieldValue(format: FormatDescriptor | undefined, settings: JsonObject, key: string): Json | undefined {
  return key in settings ? settings[key] : format?.defaults[key];
}

/** Sets one setting; going back to the default removes the key so `{}` keeps meaning "the defaults". */
export function setField(format: FormatDescriptor | undefined, settings: JsonObject, key: string, value: Json | undefined): JsonObject {
  const next: JsonObject = { ...settings };
  if (value === undefined || JSON.stringify(value) === JSON.stringify(format?.defaults[key])) delete next[key];
  else next[key] = value;
  return next;
}

/** Only the fields that changed, for a PATCH. */
export function diffItem<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out;
}

export type RowTone = "ready" | "gen" | "queued" | "if" | "off" | "fail" | "idle";
/** The filter a row falls under on the plan view. */
export type RowFilter = "ready" | "gen" | "queued" | "if";

/**
 * How an item's row reads: the status column's words and tone. Before Start
 * an item is planned (or left out); a branch that has not been decided reads
 * "if needed".
 */
export function rowState(item: Item, started: boolean): { tone: RowTone; text: string; filter?: RowFilter } {
  if (!item.enabled) return { tone: "off", text: "left out" };
  const branch = item.parentId !== undefined || item.condition !== undefined;
  if (!started) return branch ? { tone: "if", text: "if needed", filter: "if" } : { tone: "queued", text: "planned", filter: "queued" };
  switch (item.status) {
    case "done":
      return { tone: "ready", text: item.done ? "done" : "ready", filter: "ready" };
    case "running":
      return { tone: "gen", text: "making", filter: "gen" };
    case "queued":
      return { tone: "queued", text: "queued", filter: "queued" };
    case "failed":
      return { tone: "fail", text: "failed" };
    case "skipped":
      return { tone: "off", text: "skipped" };
    case "cancelled":
      // Stopped with its plan; Resume makes it.
      return { tone: "off", text: "stopped" };
    default:
      return branch ? { tone: "if", text: item.asking ? "asking you" : "if needed", filter: "if" } : { tone: "queued", text: "waiting", filter: "queued" };
  }
}

/** How long a running item has been at it, after its step: " · 4 min so far"; nothing in its first minute. */
export function runningFor(startedAt: string | undefined, now: number = Date.now()): string {
  const since = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(since)) return "";
  const minutes = Math.floor((now - since) / 60_000);
  return minutes >= 1 ? ` · ${minutes} min so far` : "";
}

/**
 * About how long a running item has left. Its maker's own word comes first: when it expects to be done, from what this
 * computer has done before, or that it cannot know now, which shows no number (the step already says what it is
 * doing). When the maker says neither, from how far its maker says it is and how long that took: only once both say
 * enough to go on (some progress, some time), never a guess before. Undefined when it can't be known.
 */
export function timeLeft(job: { progress?: number; startedAt?: string; doneBy?: string; leftUnknown?: boolean } | undefined, now: number = Date.now()): string | undefined {
  if (job?.leftUnknown) return undefined;
  const by = job?.doneBy ? Date.parse(job.doneBy) : NaN;
  if (Number.isFinite(by)) return by > now ? leftWords((by - now) / 1000) : undefined;
  const since = job?.startedAt ? Date.parse(job.startedAt) : NaN;
  const p = job?.progress ?? 0;
  if (!Number.isFinite(since) || p < 0.1 || p >= 1) return undefined;
  const spent = (now - since) / 1000;
  if (spent < 15) return undefined;
  return leftWords((spent * (1 - p)) / p);
}

function leftWords(left: number): string {
  if (left < 45) return "almost done";
  if (left < 90) return "about a minute left";
  return `about ${Math.round(left / 60)} minutes left`;
}

/**
 * Where a started plan is, in one line for the end of the chat that made it,
 * so the conversation never still reads as if nothing has started.
 */
export function underwayText(view: PlanView, now: number = Date.now()): string | undefined {
  if (view.plan.kickedOffAt === undefined) return undefined;
  const items = view.items.filter((i) => i.enabled);
  const made = items.filter((i) => i.outputId).length;
  const total = items.length;
  const running = items.find((i) => i.status === "running");
  switch (view.plan.status) {
    case "running": {
      if (!running) return made > 0 ? `Started: ${made} of ${total} made so far.` : "Started: making begins in a moment.";
      const left = timeLeft(running.job, now);
      return `Started: ${made} of ${total} made so far. Making “${running.title}” now${left ? `, ${left}` : ""}.`;
    }
    case "done":
      return `All ${total === 1 ? "made" : `${total} made`}. Press Play to go through ${total === 1 ? "it" : "them"}.`;
    case "cancelled":
      return `Stopped with ${made} of ${total} made. Resume on the plan to make the rest.`;
    case "failed":
      return "Stopped: something could not be made. The plan above says what, with Try again.";
    default:
      return undefined;
  }
}

/** An item's planned length in minutes: its format's number setting in minutes, when it sets one above zero. */
export function minutesOf(format: FormatDescriptor | undefined, settings: JsonObject): number | undefined {
  const field = format?.settings.find((f) => f.kind === "number" && f.unit === "min");
  if (!field) return undefined;
  const value = fieldValue(format, settings, field.key);
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** 45 min, 2 h 5 min. */
export function durationText(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))} s`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes - hours * 60) * 2) / 2;
  return hours > 0 ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}

/**
 * A set of items at a glance, from the data: how many of each format (in
 * the order they first appear) and, where lengths in minutes exist, about
 * how long: "15 videos · about 2 h 5 min · 1 quiz". Left-out items don't count.
 */
/**
 * A stage's name on the card: its label when it has one; in a short plan,
 * plain order words ("First", "Then"); "Stage N" only where a number helps.
 */
export function stageName(stage: { label?: string; number: number }, count: number): string {
  if (stage.label) return stage.label;
  if (count === 1) return "To make";
  if (count <= 3) return stage.number === 1 ? "First" : "Then";
  return `Stage ${stage.number}`;
}

/**
 * The formats a plan makes, each once in plan order, with the few words its
 * descriptor gives on what it is: so a word met for the first time on the
 * card ("flashcards") says what it means. Formats with no such words are left out.
 */
export function formatWords(items: readonly Item[], formats: readonly FormatDescriptor[]): Array<{ label: string; blurb: string }> {
  const seen = new Map<string, { label: string; blurb: string }>();
  for (const item of items) {
    if (!item.enabled) continue;
    const format = formats.find((f) => f.id === item.type || f.aliases?.includes(item.type));
    if (format?.blurb && !seen.has(format.id)) seen.set(format.id, { label: format.label, blurb: format.blurb });
  }
  return [...seen.values()];
}

export function sizeText(items: readonly Item[], formats: readonly FormatDescriptor[]): string {
  const byType = new Map<string, { count: number; minutes: number }>();
  for (const item of items) {
    if (!item.enabled) continue;
    const format = formats.find((f) => f.id === item.type || f.aliases?.includes(item.type));
    const key = format?.id ?? item.type;
    const entry = byType.get(key) ?? { count: 0, minutes: 0 };
    entry.count += 1;
    entry.minutes += minutesOf(format, item.settings) ?? 0;
    byType.set(key, entry);
  }
  return [...byType]
    .map(([id, entry]) => {
      const format = formats.find((f) => f.id === id);
      const label = format?.label ?? "item";
      const word = entry.count === 1 ? (format?.singular ?? label) : (format?.plural ?? `${label}s`);
      return `${entry.count} ${word}${entry.minutes > 0 ? ` · about ${durationText(entry.minutes)}` : ""}`;
    })
    .join(" · ");
}

/** What an item will be, after its format: "video · Drawn scenes · Chalkboard · about 8 min"; once made, what it is. */
export function plannedLine(item: Pick<Item, "plannedAs" | "madeAs">, formatLabel: string): string {
  return [formatLabel, ...(item.madeAs ?? item.plannedAs ?? [])].join(" · ");
}

/**
 * The same, for an item its person's agent makes: the maker's own word,
 * which a format's `describe` and `describeMade` say first ("Your agent",
 * "Drawn scenes"), is left out; the row names the agent by its model and
 * effort the way the make sheet does, or says nothing of it once made.
 * "flashcards · 15 cards".
 */
export function plannedLineByAgent(item: Pick<Item, "plannedAs" | "madeAs">, formatLabel: string): string {
  const words = item.madeAs ?? item.plannedAs ?? [];
  return [formatLabel, ...words.slice(1)].join(" · ");
}

/**
 * The parts a big plan folds by: a labelled stage starts a part and the
 * unlabelled stages after it belong to it (a planner labels the first stage
 * of each part and lets the lessons that follow in order carry on under it).
 * Each part is named by its first stage's level.
 */
export function partsOf(stages: readonly StageGroup[]): Array<{ first: number; stages: StageGroup[] }> {
  const parts: Array<{ first: number; stages: StageGroup[] }> = [];
  for (const stage of stages) {
    const last = parts.at(-1);
    if (last && !stage.label) last.stages.push(stage);
    else parts.push({ first: stage.level, stages: [stage] });
  }
  return parts;
}

/** Past this many items a plan opens with its stages folded, except the one to go on with. */
export const FOLD_ITEMS = 24;

/**
 * The stage a folded plan opens: the first with an item not yet gone
 * through (before Start, the first stage).
 */
export function openStage(stages: readonly StageGroup[]): number | undefined {
  return (stages.find((s) => s.rows.some((r) => r.item.enabled && !r.item.done && r.item.status !== "skipped")) ?? stages[0])?.level;
}

/**
 * The line a person reads on the card: the brief's first sentence (the
 * planner opens every brief with one written for people). The rest of the
 * brief is for the item's engine and shows when the item is opened.
 * Sentences are found with `Intl.Segmenter`, so no language is assumed.
 */
export function briefLine(prompt: string | undefined): string {
  const line = (prompt ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^\[.*\]$/.test(l)) ?? "";
  const first = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(line)[Symbol.iterator]().next().value?.segment.trim();
  return first || line;
}
