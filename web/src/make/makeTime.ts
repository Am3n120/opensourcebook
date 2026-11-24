import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { ApiError } from "../api/errors";
import type { MakeTime } from "../api/types";

/**
 * How long making takes, said only from runs on this computer with the same
 * agent, model and effort (and length group, where the shape has them):
 * engine/docs/api.md, "Making times". A pick that has not run here has "no
 * time yet"; nothing is ever estimated.
 */
export interface MakeTimeQuery {
  /** "chat", a format id, or "<format>.review". */
  scope: string;
  agent: string;
  model?: string;
  effort?: string;
  /** From `timeBucket`; absent for a scope made in one group. */
  bucket?: string;
}

export type MakeTimeResult =
  /** Still asking the engine. */
  | { status: "loading" }
  /** The engine could not say; nothing is shown. */
  | { status: "unknown" }
  /** No run here with this exact key. */
  | { status: "none" }
  | { status: "found"; time: MakeTime };

/** The row for exactly this key, or none: no other model, effort or length stands in for it. */
export function findTime(times: readonly MakeTime[], query: MakeTimeQuery): MakeTime | undefined {
  return times.find(
    (t) => t.scope === query.scope && t.agent === query.agent && t.model === query.model && t.effort === query.effort && t.bucket === query.bucket,
  );
}

/** The times of one scope as loaded: undefined while loading, null when the engine could not say. */
export type LoadedTimes = readonly MakeTime[] | null | undefined;

/** A key's result from times already loaded. */
export function timeResult(times: LoadedTimes, query: MakeTimeQuery | null): MakeTimeResult {
  if (times === undefined) return { status: "loading" };
  if (times === null || !query) return { status: "unknown" };
  const time = findTime(times, query);
  return time ? { status: "found", time } : { status: "none" };
}

/** Loads one scope's times. An engine without the route has kept none: an empty list. */
export function useMakeTimes(scope: string | undefined): LoadedTimes {
  const client = useApi();
  const loaded = useLoad(async () => {
    if (!scope) return [];
    try {
      return await client.makeTimes(scope);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }, [client, scope]);
  if (loaded.error) return null;
  return loaded.loading && !loaded.data ? undefined : (loaded.data ?? undefined);
}

/** The time for one key: an agent, model, effort and length group in one scope. `null` asks nothing. */
export function useMakeTime(query: MakeTimeQuery | null): MakeTimeResult {
  const times = useMakeTimes(query?.scope);
  return timeResult(times, query);
}

export interface TimeWords {
  /** "about 4 min", or "no time yet". */
  text: string;
  /** "from your last 5", or "none made here"; a total has none. */
  sub?: string;
  /** Drawn quieter: there is no time to say. */
  muted: boolean;
}

/** About how long, rounded the way a person says it. */
function about(seconds: number): string {
  if (seconds < 45) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} sec`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** A result in words; undefined while it loads or when the engine could not say. */
export function timeWords(result: MakeTimeResult): TimeWords | undefined {
  if (result.status === "none") return { text: "no time yet", sub: "none made here", muted: true };
  if (result.status !== "found") return undefined;
  const { runs, seconds } = result.time;
  return { text: about(seconds), sub: runs === 1 ? "from your last run" : `from your last ${runs}`, muted: false };
}

/**
 * Several parts made one after another (the maker, then its reviewer) in
 * one "about N min". When any part has no time, neither has the whole.
 */
export function totalWords(results: readonly MakeTimeResult[]): TimeWords | undefined {
  if (results.some((r) => r.status === "loading" || r.status === "unknown")) return undefined;
  if (results.some((r) => r.status === "none")) return { text: "no time yet", sub: "none made here", muted: true };
  const found = results.filter((r): r is Extract<MakeTimeResult, { status: "found" }> => r.status === "found");
  if (found.length === 0) return undefined;
  return { text: about(found.reduce((sum, r) => sum + r.time.seconds, 0)), muted: false };
}
