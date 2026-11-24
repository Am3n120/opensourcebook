/**
 * How a making time is keyed (DECISIONS: times come only from past runs on
 * this computer). Both the recording of a time and the looking-up of one go
 * through here, so they agree: the key is the pick as the picker names it.
 *
 * A time is never guessed. There is no fallback from one model, agent or
 * effort to another, and none from one length to another.
 */
import type { FormatDescriptor } from "./types";

/** What the person's agent does when the pick names no model or effort: the adapter's defaults per kind of turn. */
export interface PickDefaults {
  defaultModels?: { chat?: string; work?: string };
  defaultEfforts?: { chat?: string; work?: string };
}

/** The pick a thing was made on, as the picker names it. */
export interface TimedPick {
  agent: string;
  model?: string;
  effort?: string;
}

/** A key with empty strings for what the pick does not have, as `make_times` keeps it. */
export interface TimingKey {
  agent: string;
  model: string;
  effort: string;
}

/**
 * The key of a pick: the agent id; the model is the picked model, else the
 * adapter's default for this kind of turn, else the model the connector
 * reported using; the effort is the picked one, else the adapter's default,
 * else absent.
 */
export function timingKey(pick: TimedPick, turnKind: "chat" | "work", defaults: PickDefaults = {}, reportedModel?: string): TimingKey {
  return {
    agent: pick.agent,
    model: clean(pick.model) ?? clean(defaults.defaultModels?.[turnKind]) ?? clean(reportedModel) ?? "",
    effort: clean(pick.effort) ?? clean(defaults.defaultEfforts?.[turnKind]) ?? "",
  };
}

/**
 * The key a chat turn's time is kept under and looked up by: `timingKey` of the
 * pick the turn is sent to the connector with (`ConnectorClient.sentPick`), over
 * that agent's adapter defaults from the connector's status. A finished reply
 * records under it, and the providers list names the chat's model and effort
 * from it, so what the web asks for is what was kept.
 */
export function chatTimingKey(
  sent: { agent?: string; model?: string; effort?: string },
  status: { agent?: { id: string }; agents?: ReadonlyArray<{ id: string } & PickDefaults> },
  reportedModel?: string,
): TimingKey {
  const agent = sent.agent ?? status.agent?.id ?? "";
  const defaults = status.agents?.find((candidate) => candidate.id === agent) ?? {};
  return timingKey({ agent, ...(sent.model ? { model: sent.model } : {}), ...(sent.effort ? { effort: sent.effort } : {}) }, "chat", defaults, reportedModel);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The setting `settle` keeps beside a length it filled in for one left on
 * Auto (0): the length it filled in. While the length still holds that
 * number, the item's time is kept under `"auto"`, where a client looks up
 * the time of a length left on Auto. A length changed since is its own.
 */
export const AUTO_LENGTH_KEY = "autoLength";

/** The marker to keep beside `filled` when `asked` left the timed length on Auto and settling filled it; else nothing. */
export function autoLengthMark(descriptor: Pick<FormatDescriptor, "timing">, asked: unknown, filled: Record<string, unknown>): Record<string, number> {
  const setting = descriptor.timing?.setting;
  if (!setting || typeof asked !== "object" || asked === null) return {};
  const value = filled[setting];
  return (asked as Record<string, unknown>)[setting] === 0 && typeof value === "number" && value > 0 ? { [AUTO_LENGTH_KEY]: value } : {};
}

/**
 * The length bucket of an item: `"auto"` when its length setting holds 0
 * (or still holds the length `settle` filled in for Auto, `AUTO_LENGTH_KEY`),
 * `"le<edge>"` for the first edge it does not exceed, else `"gt<last edge>"`.
 * Undefined for a shape that declares no timing, and when the length is not a
 * usable number (so nothing is kept under a bucket that is a guess).
 */
export function timeBucket(descriptor: Pick<FormatDescriptor, "timing">, settings: unknown): string | undefined {
  const timing = descriptor.timing;
  if (!timing || timing.edges.length === 0) return undefined;
  const record = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
  const value = record[timing.setting];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0 || record[AUTO_LENGTH_KEY] === value) return "auto";
  const edge = timing.edges.find((limit) => value <= limit);
  return edge !== undefined ? `le${edge}` : `gt${timing.edges[timing.edges.length - 1]}`;
}

/** The scope a review's time is kept under. */
export function reviewScope(format: string): string {
  return `${format}.review`;
}

/** True when a maker's timing says something that can be kept as a time. */
export function usableTiming<T extends { seconds: number; agent: string }>(timing: T | undefined): timing is T {
  return timing !== undefined && Boolean(timing.agent) && Number.isFinite(timing.seconds) && timing.seconds > 0;
}
