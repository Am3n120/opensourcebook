import type { Chat, Json, Mention, PlanView, Source } from "../api/types";
import { clock } from "../player/audioData";

/** Where a mentionable shows in the @ list. */
export type MentionGroup = "Playing now" | "Sources" | "Made" | "Plans" | "Chats";

/** Something the typing box can @-mention. */
export interface Mentionable {
  group: MentionGroup;
  key: string;
  name: string;
  detail: string;
  kind?: string;
  format?: string;
  /** A source the chat does not read now: picking it ticks it. */
  unticked?: boolean;
  /** The thing playing now: where in it the person is, read when the list is drawn ("at 1:12"). */
  moment?: () => string | undefined;
}

/**
 * Where the person is in what is playing, as its player reports it, in
 * plain words: a time for a video or audio ("at 1:12"), the question for a
 * quiz ("question 3"), or nothing for a spot with neither.
 */
export function momentWords(at: Json | undefined): string | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at)) return undefined;
  const { time, at: question } = at as { time?: unknown; at?: unknown };
  if (typeof time === "number" && Number.isFinite(time)) return `at ${clock(time)}`;
  if (typeof question === "number" && Number.isInteger(question) && question >= 0) return `question ${question + 1}`;
  return undefined;
}

/** A row's line in the @ list: its detail, with where the person is in it right after its kind when it is playing. */
export function detailOf(m: Mentionable): string {
  const moment = m.moment?.();
  if (!moment) return m.detail;
  const [kind, ...rest] = m.detail.split(" · ");
  return [kind, moment, ...rest].filter(Boolean).join(" · ");
}

/** The tabs over the @ list, each with the groups it shows. */
export const MENTION_TABS: ReadonlyArray<{ label: string; groups: readonly MentionGroup[] }> = [
  { label: "All", groups: ["Playing now", "Sources", "Made", "Plans", "Chats"] },
  { label: "Sources", groups: ["Sources"] },
  { label: "Made", groups: ["Playing now", "Made"] },
  { label: "Plans", groups: ["Plans"] },
  { label: "Chats", groups: ["Chats"] },
];

/** What the @ list knows besides the things themselves. */
export interface MentionContext {
  /** The sources the chat reads now; without it, nothing says ticked or not. */
  ticked?: ReadonlySet<string>;
  /** The chat open now, which the list calls "this chat". */
  chatId?: string | null;
  /** A shape's name on screen, from the registry. */
  label?: (format: string) => string;
  /** Where the person is in the thing playing now, as its player last said. */
  playingAt?: () => Json | undefined;
}

/**
 * Everything in the project that can be mentioned: what is playing in the
 * right column first, then sources, the things in plans, the plans and the
 * chats, each with a short line on what it is.
 */
export function mentionables(sources: Source[], views: PlanView[], chats: Chat[] = [], playingItem?: string, ctx: MentionContext = {}): Mentionable[] {
  const label = ctx.label ?? ((f: string) => f);
  const where = (v: PlanView) => (v.plan.direct ? "" : ` · in Plan: ${v.plan.title || "Untitled plan"}`);
  const out: Mentionable[] = [];
  for (const v of views)
    for (const i of v.items) {
      if (i.id !== playingItem) continue;
      const playingAt = ctx.playingAt;
      out.push({ group: "Playing now", key: `i:${i.id}`, name: i.title, detail: `${label(i.type)}${where(v)}`, format: i.type, ...(playingAt ? { moment: () => momentWords(playingAt()) } : {}) });
    }
  out.push(
    ...sources.map((s): Mentionable => {
      const off = ctx.ticked !== undefined && !ctx.ticked.has(s.id);
      const state = ctx.ticked === undefined ? "" : off ? " · not ticked: picking it ticks it" : " · ticked";
      return { group: "Sources", key: `s:${s.id}`, name: s.title, detail: `${s.kind}${state}`, kind: s.kind, ...(off ? { unticked: true } : {}) };
    }),
  );
  for (const v of views)
    for (const i of v.items) if (i.id !== playingItem) out.push({ group: "Made", key: `i:${i.id}`, name: i.title, detail: `${label(i.type)}${i.outputId ? "" : " · not made yet"}${where(v)}`, format: i.type });
  for (const v of views) if (!v.plan.direct) out.push({ group: "Plans", key: `p:${v.plan.id}`, name: v.plan.title || "Untitled plan", detail: `${v.items.length} item${v.items.length === 1 ? "" : "s"}` });
  for (const c of chats) {
    const n = `${c.messageCount} message${c.messageCount === 1 ? "" : "s"}`;
    out.push({ group: "Chats", key: `c:${c.id}`, name: c.title || "Untitled chat", detail: c.id === ctx.chatId ? `this chat · ${n}` : n });
  }
  return out;
}

const KINDS: Record<string, string> = { s: "source", i: "item", p: "plan", c: "chat" };

/** The engine's mentions for the @names in a message, each once, in order. */
export function mentionsIn(text: string, all: Mentionable[]): Mention[] {
  const byName = new Map<string, Mentionable>();
  for (const m of all) if (!byName.has(m.name)) byName.set(m.name, m);
  const out: Mention[] = [];
  for (const part of splitMentions(text, [...byName.keys()])) {
    const m = part.mention ? byName.get(part.text.slice(1)) : undefined;
    if (!m) continue;
    const [prefix, ...rest] = m.key.split(":");
    const mention = { kind: KINDS[prefix!] ?? prefix!, id: rest.join(":"), label: m.name };
    if (!out.some((o) => o.kind === mention.kind && o.id === mention.id)) out.push(mention);
  }
  return out;
}

/** The @word being typed at the caret, if any: its start and what follows the @. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (!m) return undefined;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Candidates for a query, best first: names that start with it, then names that contain it. */
export function matchMentions(all: Mentionable[], query: string, limit = 12): Mentionable[] {
  const q = query.toLowerCase();
  const starts = all.filter((m) => m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\W+/).some((w) => w.startsWith(q)));
  const has = all.filter((m) => !starts.includes(m) && m.name.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, limit);
}

/** How many of each group the All tab shows, so every group is in view; its own tab shows the rest. */
const FEW = 4;
/** The most one group's own tab lists. */
const MOST = 50;

/**
 * What the @ list shows on a tab for the words typed: matches in the tab's
 * group order. On All each group shows its best few, so every group is in
 * view, with how many more it has and the tab that lists them all.
 */
export function mentionList(all: Mentionable[], query: string, tab: number): { found: Mentionable[]; more: Array<{ group: MentionGroup; count: number; tab: number }> } {
  const groups = (MENTION_TABS[tab] ?? MENTION_TABS[0]!).groups;
  const found: Mentionable[] = [];
  const more: Array<{ group: MentionGroup; count: number; tab: number }> = [];
  for (const group of groups) {
    const hits = matchMentions(
      all.filter((m) => m.group === group),
      query,
      MOST,
    );
    const shown = tab === 0 ? FEW : MOST;
    found.push(...hits.slice(0, shown));
    const own = MENTION_TABS.findIndex((t, i) => i > 0 && t.groups.includes(group));
    if (hits.length > shown && own >= 0) more.push({ group, count: hits.length - shown, tab: own });
  }
  return { found, more };
}

/** Splits a sent message into text and the @mentions of known names, longest names first. */
export function splitMentions(text: string, names: string[]): Array<{ text: string; mention: boolean }> {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  const out: Array<{ text: string; mention: boolean }> = [];
  let rest = text;
  while (rest) {
    let at = -1;
    let hit = "";
    for (const n of sorted) {
      const i = rest.indexOf(`@${n}`);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = n;
      }
    }
    if (at < 0) {
      out.push({ text: rest, mention: false });
      break;
    }
    if (at > 0) out.push({ text: rest.slice(0, at), mention: false });
    out.push({ text: `@${hit}`, mention: true });
    rest = rest.slice(at + hit.length + 1);
  }
  return out;
}

/** The command a message starts with (`/plan` or `/plan …`), and what follows it. */
export function splitCommand<C extends { command?: string }>(text: string, commands: readonly C[]): { skill: C; rest: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const skill = commands.find((c) => c.command?.toLowerCase() === m[1]!.toLowerCase());
  return skill ? { skill, rest: (m[2] ?? "").trim() } : undefined;
}

/** A name split round the first place a query matches it, for marking the matched letters. */
export function marked(name: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  if (at < 0) return [{ text: name, hit: false }];
  return [
    { text: name.slice(0, at), hit: false },
    { text: name.slice(at, at + q.length), hit: true },
    { text: name.slice(at + q.length), hit: false },
  ].filter((p) => p.text);
}
