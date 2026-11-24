import { ApiError } from "../../api/errors";
import type { AgentPick, FormatDescriptor, JsonObject, MakeTime, Provider, Providers, VoiceSetup } from "../../api/types";
import { useApi } from "../../app/context";
import { useLoad } from "../../app/useLoad";
import { timeResult, timeWords, totalWords, type LoadedTimes, type MakeTimeResult, type TimeWords } from "../../make/makeTime";
import { agentField, defaultEffortId, defaultModelId, timeKey, turnKindOf, type MakerPick } from "../../make/makerKey";
import { timeBucket } from "../../plan/timing";

/**
 * "What makes what" (Settings): one row for the chat and one for each shape
 * the engine declares, each with the pick it starts from. Scopes are never
 * listed by hand: a shape has a maker or a reviewer only when its format
 * declares that agent field.
 */
export interface MakerRow {
  /** "chat", or a format id. */
  scope: string;
  format?: FormatDescriptor;
}

/** The chat first, then every shape in the order the engine serves them; nothing here sorts or names one. */
export function makerRows(formats: readonly FormatDescriptor[]): MakerRow[] {
  return [{ scope: "chat" }, ...formats.map((format) => ({ scope: format.id, format }))];
}

/** The chat, or a shape whose format has a maker field: what "Use one for all" sets. */
export function hasMaker(row: MakerRow): boolean {
  return !row.format || agentField(row.format, "maker") !== undefined;
}

export function hasReviewer(row: MakerRow): boolean {
  return !!row.format && agentField(row.format, "reviewer") !== undefined;
}

export function makerScopes(formats: readonly FormatDescriptor[]): string[] {
  return makerRows(formats)
    .filter(hasMaker)
    .map((r) => r.scope);
}

/** The pick a scope starts from, when one names an agent. */
export function pickOf(providers: Providers | undefined, scope: string): MakerPick | undefined {
  const p = providers?.picks?.[scope];
  if (!p?.agent) return undefined;
  return { agent: p.agent, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
}

/** Who reviews a shape: off, its own pick, or (nothing kept) the shape's default, on with the maker's pick. */
export type Review = { kind: "off" } | { kind: "own"; pick: MakerPick } | { kind: "auto" };

export function reviewOf(providers: Providers | undefined, scope: string): Review {
  const kept = providers?.picks?.[`${scope}.review`];
  if (kept?.off) return { kind: "off" };
  const pick = pickOf(providers, `${scope}.review`);
  return pick ? { kind: "own", pick } : { kind: "auto" };
}

/** The words of a picked agent, model and effort: its model's name, and "Agent · effort" under it. */
export function pickWords(list: readonly Provider[], pick: MakerPick, turnKind: "chat" | "work"): { provider?: Provider; title: string; sub: string } {
  const provider = list.find((p) => p.id === pick.agent);
  if (!provider) return { title: pick.model ?? pick.agent, sub: "Not in your providers" };
  const modelId = pick.model ?? defaultModelId(provider, turnKind);
  const model = provider.models.find((m) => m.id === modelId);
  const effortId = provider.efforts.length > 0 ? (pick.effort ?? defaultEffortId(provider, turnKind)) : undefined;
  const effort = provider.efforts.find((e) => e.id === effortId);
  return {
    provider,
    title: model?.label ?? modelId ?? provider.label,
    sub: [provider.label, effort?.label.toLowerCase()].filter(Boolean).join(" · "),
  };
}

/** A pick saved, as the providers answer keeps it. */
export function withPick(prev: Providers, scope: string, pick: AgentPick | null): Providers {
  const picks = { ...(prev.picks ?? {}) };
  if (pick && (pick.agent || pick.off)) {
    picks[scope] = {
      ...(pick.agent ? { agent: pick.agent } : {}),
      ...(pick.model ? { model: pick.model } : {}),
      ...(pick.effort ? { effort: pick.effort } : {}),
      ...(pick.off ? { off: true } : {}),
    };
  } else {
    delete picks[scope];
  }
  return { ...prev, picks };
}

/** Every scope's times, loaded once. An engine without the route has kept none. */
export function useAllTimes(): LoadedTimes {
  const client = useApi();
  const loaded = useLoad(async (): Promise<MakeTime[]> => {
    try {
      return await client.makeTimes();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }, [client]);
  if (loaded.error) return null;
  return loaded.loading && !loaded.data ? undefined : loaded.data;
}

/** The length the default times are for, from the format's own length setting: "3 min", "Auto length". */
export function lengthWords(format: FormatDescriptor | undefined): string | undefined {
  const timing = format?.timing;
  if (!format || !timing) return undefined;
  const field = format.settings.find((f) => f.key === timing.setting);
  const n = format.defaults[timing.setting];
  if (typeof n !== "number" || field?.kind !== "number") return undefined;
  if (n === 0) return "Auto length";
  return `${n}${field.unit ? ` ${field.unit}` : ""}`;
}

/**
 * How long a row usually takes: its maker's time with the shape's default
 * length, and its reviewer's after it when one is on. Undefined while the
 * times load or with no pick to look up.
 */
export function rowTime(row: MakerRow, providers: Providers | undefined, times: LoadedTimes): TimeWords | undefined {
  const list = providers?.providers ?? [];
  const maker = pickOf(providers, row.scope);
  if (!maker) return undefined;
  const bucket = row.format ? timeBucket(row.format, row.format.defaults as JsonObject) : undefined;
  const result = (scope: string, pick: MakerPick, role: "maker" | "reviewer"): MakeTimeResult => {
    const p = list.find((x) => x.id === pick.agent);
    return timeResult(times, p ? timeKey(scope, p, pick, turnKindOf(row.format, role), bucket) : null);
  };
  const made = result(row.scope, maker, "maker");
  if (!hasReviewer(row)) return timeWords(made);
  const review = reviewOf(providers, row.scope);
  if (review.kind === "off") return timeWords(made);
  const reviewed = result(`${row.scope}.review`, review.kind === "own" ? review.pick : maker, "reviewer");
  const total = totalWords([made, reviewed]);
  // A total has no "from your last N" of its own: the maker's runs say it.
  const own = timeWords(made);
  return total && own && !total.muted ? { ...total, sub: own.sub } : total;
}

/**
 * The voice a voiced shape is spoken in, as two lines: the service, and the
 * voice's name ("the voice you picked" when it has none). Undefined when no
 * service is set up.
 */
export function voiceWords(setup: VoiceSetup | undefined): { title: string; sub: string } | undefined {
  if (!setup?.service) return undefined;
  const service = setup.services.find((s) => s.id === setup.service);
  return { title: service?.label ?? setup.service, sub: setup.voice ? setup.voice.label.trim() || "the voice you picked" : "default voice" };
}
