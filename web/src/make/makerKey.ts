import type { FormatDescriptor, ModelTier, Provider, SettingField } from "../api/types";
import type { TurnKind } from "../project/providers";
import type { MakeTimeQuery } from "./makeTime";

/** Who makes a thing: an agent (a provider id), and its model and effort when picked. */
export type MakerPick = { agent: string; model?: string; effort?: string };

/** Tiers in plain words, beside the model's real name. A model with no tier gets none. */
export const TIER_WORDS: Record<ModelTier, string> = { fast: "Quickest", balanced: "Good", strong: "Best" };

/** The agent field a format declares for this role: who makes it, or who reviews it. */
export function agentField(format: FormatDescriptor | undefined, role: "maker" | "reviewer"): (SettingField & { kind: "agent" }) | undefined {
  const want = role === "reviewer" ? "review" : "make";
  return format?.settings.find((f): f is SettingField & { kind: "agent" } => f.kind === "agent" && (f.role ?? "make") === want);
}

/** Which kind of turn runs it, as its format declares; the chat answers in chat turns. */
export function turnKindOf(format: FormatDescriptor | undefined, role: "maker" | "reviewer"): TurnKind {
  return agentField(format, role)?.turnKind ?? "chat";
}

/** The model a provider runs when none is picked, by its id when it lists it. */
export function defaultModelId(p: Provider, turnKind: TurnKind): string | undefined {
  const own = turnKind === "work" ? (p.workDefaultModel ?? p.defaultModel) : p.defaultModel;
  if (!own) return undefined;
  const lower = own.toLowerCase();
  return p.models.find((m) => m.id.toLowerCase() === lower || m.label.toLowerCase() === lower)?.id ?? own;
}

/** The effort a provider uses when none is picked; none when it takes no effort. */
export function defaultEffortId(p: Provider, turnKind: TurnKind): string | undefined {
  const own = turnKind === "work" ? (p.workDefaultEffort ?? p.defaultEffort) : p.defaultEffort;
  return own && p.efforts.some((e) => e.id === own) ? own : undefined;
}

/**
 * A pick as its making time is kept (engine/src/studio/timing.ts,
 * `timingKey`): the picked model, else the provider's own default for the
 * turn kind; the picked effort, else its default.
 */
export function timeKey(scope: string, p: Provider, pick: { model?: string; effort?: string }, turnKind: TurnKind, bucket?: string): MakeTimeQuery {
  const model = pick.model ?? defaultModelId(p, turnKind);
  const effort = p.efforts.length === 0 ? undefined : (pick.effort ?? defaultEffortId(p, turnKind));
  return { scope, agent: p.id, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(bucket ? { bucket } : {}) };
}

/** Agents listed A to Z by name, nothing first because it is preferred. */
export function aToZ<T extends { label: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
