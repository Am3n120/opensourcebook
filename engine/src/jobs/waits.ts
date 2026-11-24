/**
 * Why a job is waiting, and when it is tried again (status `waiting`).
 *
 * A maker that went quiet (the engine, the connector or the scenes service
 * restarted, the computer slept, the agent's turn was dropped) leaves what
 * it made kept on the job; the job waits a little and is carried on from
 * there, at most a few times with growing waits, then fails plainly with a
 * button to try again that still starts from what was made.
 *
 * The person's agent reaching its plan's limit is not a failure either: the
 * job waits until the agent can answer again (at the time it said it resets,
 * or probing with growing waits when it did not say), then carries on. A
 * limit that never lifts is given up on after a day, or an hour past the
 * reset the agent named, whichever is later, and at most a week.
 *
 * A voice that cannot speak (its account out of credits, its key refused,
 * its service not answering) is the same kind of wait: what was made is
 * kept, the voice is checked for free with growing waits, and the job
 * carries on once it can speak, given up on after a day. A wait may offer
 * the person a way on that does not need what it waits for (`choice`, such
 * as finishing a video without sound); they choose it from the item.
 *
 * Everything here is data on the job's state (`state.wait`), so it survives
 * the engine's own restart: the keeper (`keeper.ts`) reads it back.
 */
import type { JsonValue } from "../studio/types";
import type { JobFailureCode } from "./failure-words";
import type { GenerationJob, JsonObject } from "./types";

export type WaitReason = "restart" | "agent_limit" | "voice";
const REASONS: readonly WaitReason[] = ["restart", "agent_limit", "voice"];

/** Why a voice cannot speak: no credits left, its key or account refused, or no answer. */
export type VoiceTrouble = "credits" | "refused" | "unreachable";
const TROUBLES: readonly VoiceTrouble[] = ["credits", "refused", "unreachable"];

/**
 * A way on the person may choose while a job waits (or after it was given up
 * on), offered by its maker: `id` is the maker's own and comes back to it as
 * `EngineServices.chosen`; `label` is the button; `words` finish the
 * sentence "or ..." in what the item says.
 */
export interface WaitChoice {
  id: string;
  label: string;
  words: string;
}

/** What a wait says beyond its reason: why a voice cannot speak, and a way on the person may choose. */
export interface WaitMore {
  trouble?: VoiceTrouble;
  choice?: WaitChoice;
}

/** What the agent said about when its limit resets, only when it really said so. */
export interface LimitReset {
  /** ISO time. */
  resetsAt?: string;
  /** The agent's own words for when ("3pm (Europe/Berlin)"). */
  resets?: string;
}

export interface JobWaitState extends LimitReset, WaitMore {
  reason: WaitReason;
  /** What the job fails as if it is given up on. */
  code: JobFailureCode;
  /** Times it has been tried again for this reason (carried on, or probed). */
  tries: number;
  /** When it started waiting for this reason. */
  since: string;
  /** When it is next tried. */
  nextAt: string;
  /** When it is given up on. */
  giveUpAt: string;
}

/** The key in a job's state that holds why it waits. */
export const WAIT_KEY = "wait";

/** Carried on after a restart at most this many times, waiting these long first. */
export const RESTART_WAITS_MS = [3_000, 20_000, 60_000, 180_000] as const;
/** Probes of an agent at its limit that did not say when it resets: growing, then every half hour. */
export const LIMIT_WAITS_MS = [120_000, 300_000, 600_000, 1_200_000, 1_800_000] as const;
/** A limit is waited on for at least a day, and at most a week. */
export const LIMIT_PATIENCE_MS = 24 * 3_600_000;
const LIMIT_MOST_MS = 7 * 24 * 3_600_000;
/** After a reset time the agent named, it is tried this much later (clocks differ). */
const AFTER_RESET_MS = 30_000;

/**
 * Thrown by a maker when its work can be carried on later from what was
 * made: the maker went quiet, the agent reached its limit, or the voice
 * cannot speak. `code` is what the job fails as when it is given up on.
 */
export class JobWait extends Error {
  constructor(
    message: string,
    readonly reason: WaitReason,
    readonly code: JobFailureCode,
    readonly limit: LimitReset = {},
    readonly more: WaitMore = {},
  ) {
    super(message);
    this.name = "JobWait";
  }
}

/** The wait a job keeps, if it is waiting or was carried on after one. */
export function waitOf(job: Pick<GenerationJob, "state">): JobWaitState | undefined {
  const value = job.state[WAIT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const wait = value as Record<string, JsonValue>;
  if (!REASONS.includes(wait.reason as WaitReason) || typeof wait.nextAt !== "string") return undefined;
  return value as unknown as JobWaitState;
}

/**
 * The next wait for a job that hit `reason` now, from the one it kept: the
 * tries go on counting while the reason is the same. Undefined when it has
 * waited enough and is given up on.
 */
export function nextWait(previous: JobWaitState | undefined, reason: WaitReason, code: JobFailureCode, limit: LimitReset, now: number, more: WaitMore = {}): JobWaitState | undefined {
  const same = previous?.reason === reason ? previous : undefined;
  const tries = (same?.tries ?? 0) + 1;
  const since = same?.since ?? new Date(now).toISOString();
  const resets = limitWords(limit, same);
  if (reason === "restart") {
    if (tries > RESTART_WAITS_MS.length) return undefined;
    const nextAt = now + RESTART_WAITS_MS[tries - 1]!;
    return { reason, code, tries, since, nextAt: iso(nextAt), giveUpAt: iso(nextAt + 60_000) };
  }
  if (reason === "voice") {
    // Checked for free with growing waits, then every half hour; given up on after a day.
    const giveUpAt = Date.parse(since) + LIMIT_PATIENCE_MS;
    if (now >= giveUpAt) return undefined;
    const trouble = more.trouble ?? same?.trouble;
    const choice = more.choice ?? same?.choice;
    const nextAt = now + LIMIT_WAITS_MS[Math.min(tries, LIMIT_WAITS_MS.length) - 1]!;
    return { reason, code, tries, since, nextAt: iso(Math.min(nextAt, giveUpAt)), giveUpAt: iso(giveUpAt), ...(trouble ? { trouble } : {}), ...(choice ? { choice } : {}) };
  }
  const resetAt = resets.resetsAt ? Date.parse(resets.resetsAt) : Number.NaN;
  const knownReset = Number.isFinite(resetAt) && resetAt > now ? resetAt : undefined;
  const started = Date.parse(since);
  const giveUpAt = Math.min(started + LIMIT_MOST_MS, Math.max(started + LIMIT_PATIENCE_MS, (knownReset ?? 0) + 3_600_000));
  const nextAt = knownReset !== undefined ? knownReset + AFTER_RESET_MS : now + LIMIT_WAITS_MS[Math.min(tries, LIMIT_WAITS_MS.length) - 1]!;
  if (now >= giveUpAt) return undefined;
  return { reason, code, tries, since, nextAt: iso(Math.min(nextAt, giveUpAt)), giveUpAt: iso(giveUpAt), ...resets };
}

/** A job's state with its wait set, or cleared. */
export function withWait(state: JsonObject, wait: JobWaitState | undefined): JsonObject {
  // `waited` says a failure came after waiting; any new wait or failure replaces it.
  const { [WAIT_KEY]: _old, waited: _waited, ...rest } = state;
  return wait ? { ...rest, [WAIT_KEY]: wait as unknown as JsonValue } : rest;
}

/** Whether a waiting job is due to be tried now. */
export function isDue(job: GenerationJob, now: number): boolean {
  const wait = waitOf(job);
  return !wait || Date.parse(wait.nextAt) <= now;
}

/** A voice trouble read back from stored or wire data, when it is one. */
export function readTrouble(value: unknown): VoiceTrouble | undefined {
  return TROUBLES.includes(value as VoiceTrouble) ? (value as VoiceTrouble) : undefined;
}

/** A way on read back from stored data, when it is one. */
export function readChoice(value: unknown): WaitChoice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.label === "string" && typeof c.words === "string" ? { id: c.id, label: c.label, words: c.words } : undefined;
}

/** The newest words on when a limit resets: what was just heard, else what was heard before, never made up. */
function limitWords(limit: LimitReset, previous: JobWaitState | undefined): LimitReset {
  const resetsAt = limit.resetsAt && Number.isFinite(Date.parse(limit.resetsAt)) ? limit.resetsAt : undefined;
  const resets = limit.resets?.trim() ? limit.resets.trim().slice(0, 80) : undefined;
  if (resetsAt || resets) return { ...(resetsAt ? { resetsAt } : {}), ...(resets ? { resets } : {}) };
  return { ...(previous?.resetsAt ? { resetsAt: previous.resetsAt } : {}), ...(previous?.resets ? { resets: previous.resets } : {}) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
