/**
 * When an agent that ran out of its plan's usage says it can answer again,
 * read from what its CLI said: an exact time it gave (a reset time in its
 * stream, an epoch after its error text, or "try again in 2 hours"), and its
 * own short words for it ("3pm (Europe/Berlin)"). Nothing is guessed: a
 * field is there only when the agent said it, and a clock time without a
 * date stays words, since only the agent knows its time zone.
 */
import type { LimitReset } from "./types.ts";

/** The longest phrase kept of the agent's words for when its limit resets. */
const MAX_WORDS = 60;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** An epoch the agent gave (seconds, or milliseconds when that large) as ISO 8601; undefined when it is not one. */
export function epochToIso(value: unknown): string | undefined {
  const number = typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return undefined;
  const date = new Date(number < 1e12 ? number * 1000 : number);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * What the agent said about when its limit resets, from its error text (and stderr), with `resetsAt` from its stream
 * when it gave one there. Undefined when it said nothing about it.
 */
export function heardLimit(said: string, resetsAt?: string, now: number = Date.now()): LimitReset | undefined {
  const words = resetWords(said);
  const exact = resetsAt ?? pipeEpoch(said) ?? (words ? afterDelay(words, now) : undefined);
  if (!exact && !words) return undefined;
  return { ...(exact ? { resetsAt: exact } : {}), ...(words ? { resets: words } : {}) };
}

/** An older error form: "...usage limit reached|1763503200", the reset as an epoch after a pipe. */
function pipeEpoch(said: string): string | undefined {
  const match = /limit reached\s*\|\s*(\d{9,13})\b/i.exec(said);
  return match ? epochToIso(match[1]) : undefined;
}

/**
 * The agent's own short words after "resets", "reset at", "try again at" or "try again in", up to a line's or a
 * sentence's end or a separator ("·", "|"); "at" and "on" are dropped, "in" kept ("in 2 hours"). Only words that name a
 * time are kept: a number, or a day word such as "tomorrow".
 */
export function resetWords(said: string): string | undefined {
  for (const match of said.matchAll(/\b(?:resets?|try again)\b[ \t]*(?:(?:at|on)[ \t]+)?([^\n]*)/gi)) {
    let words = match[1]!.split(/\.\s|\.$|[·∙•|]/)[0]!.trim();
    if (words.length > MAX_WORDS) words = words.slice(0, MAX_WORDS).replace(/\s+\S*$/, "");
    words = words.replace(/[\s,;:!"'-]+$/, "");
    // A closing parenthesis stays only when the words opened one.
    if (!words.includes("(")) words = words.replace(/\)+$/, "");
    if (words && /\d|tomorrow|tonight|midnight|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(words)) return words;
  }
  return undefined;
}

/** "in 2 hours", "in 4 days 2 hours 31 minutes": an exact delay, so the time is now plus it. Undefined for anything else. */
function afterDelay(words: string, now: number): string | undefined {
  const rest = /^in\s+(.+)$/i.exec(words)?.[1];
  if (!rest) return undefined;
  const parts = /^(?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b[\s,]*(?:and\s+)?)+$/i;
  if (!parts.test(rest)) return undefined;
  let ms = 0;
  for (const [, amount, unit] of rest.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) ms += Number(amount) * UNIT_MS[unit!.toLowerCase()[0]!]!;
  return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}
