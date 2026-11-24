import type { EffortWeight, Mark, Provider, ProviderModel, Providers } from "../api/types";

export type TurnKind = "chat" | "work";

/** One model in the chat's picker: a provider with one of its models, or with its own default. */
export interface Choice {
  pick: string;
  provider: Provider;
  /** The model, when the pick names one of the provider's listed models. */
  model?: ProviderModel;
  label: string;
}

/** In the person's list and turned on: on the picker's rail. */
export function onRail(p: Provider): boolean {
  return p.added && p.enabled;
}

/** Can answer the chat now: in the list, turned on, and ready. */
export function usable(p: Provider): boolean {
  return onRail(p) && p.state === "ready";
}

/** The dot beside a provider: ready, needs something, or turned off. */
export function tone(p: Provider): "on" | "warn" | "off" {
  if (!p.enabled) return "off";
  return p.state === "ready" ? "on" : "warn";
}

/** One line on a provider's state, with what to do when there is something to do. */
export function said(p: Provider): string {
  return p.detail ? `${p.headline}. ${p.detail}` : p.headline;
}

/** Who made a choice's model, with their logo, when its provider says. */
export function makerOf(c: Choice): { label: string; mark: Mark } | undefined {
  const id = c.model?.maker;
  return id && c.provider.makers && Object.hasOwn(c.provider.makers, id) ? c.provider.makers[id] : undefined;
}

/** A choice's logo: its model's maker's, else its provider's. */
export function choiceMark(c: Choice): Mark | undefined {
  return makerOf(c)?.mark ?? c.provider.mark;
}

/** The model a provider uses when none of its own is picked, as it lists it. */
function defaultModel(p: Provider, turnKind: TurnKind = "chat"): ProviderModel | undefined {
  const own = (turnKind === "work" ? (p.workDefaultModel ?? p.defaultModel) : p.defaultModel)?.toLowerCase();
  return own ? p.models.find((m) => m.id.toLowerCase() === own || m.label.toLowerCase() === own) : undefined;
}

/**
 * What a provider offers the picker: the models shown in Settings,
 * or its own default when it lists none or every one is hidden. A provider
 * that can't answer now offers nothing.
 */
export function choices(p: Provider): Choice[] {
  if (!usable(p)) return [];
  const models = p.models.filter((m) => m.shown).map((m) => ({ pick: m.pick, provider: p, model: m, label: m.label }));
  if (models.length > 0) return models;
  return [{ pick: p.pick, provider: p, label: p.defaultModel ?? "Default model" }];
}

/**
 * Who runs a turn, as the picker shows it: the explicit pick, else the default
 * provider for that turn kind (the connector's own agent when it is on, else
 * the first that can answer). A provider picked with its own default shows as
 * that model.
 */
export function shownChoice(providers: Provider[], picked: string | undefined, turnKind: TurnKind = "chat"): Choice | undefined {
  for (const p of providers) {
    const model = p.models.find((m) => m.pick === picked);
    if (model) return { pick: model.pick, provider: p, model, label: model.label };
  }
  const p =
    providers.find((x) => x.pick === picked) ??
    (turnKind === "work" ? providers.find((x) => x.workDefault && onRail(x)) : undefined) ??
    providers.find((x) => x.default && onRail(x)) ??
    providers.find(usable);
  if (!p) return undefined;
  const own = defaultModel(p, turnKind);
  const fallbackName = turnKind === "work" ? (p.workDefaultModel ?? p.defaultModel) : p.defaultModel;
  return own ? { pick: own.pick, provider: p, model: own, label: own.label } : { pick: p.pick, provider: p, label: fallbackName ?? p.label };
}

/** The effort shown for a provider: the picked one, when the provider takes it, else its default for that turn kind. */
export function shownEffort(
  p: Provider,
  picked: string | undefined,
  turnKind: TurnKind = "chat",
): { id: string; label: string; weight?: EffortWeight } | undefined {
  const fallback = turnKind === "work" ? (p.workDefaultEffort ?? p.defaultEffort) : p.defaultEffort;
  return p.efforts.find((e) => e.id === picked) ?? p.efforts.find((e) => e.id === fallback);
}

/**
 * Rough time and plan usage for longer work, driven purely by generic adapter
 * metadata (`model.tier` and `effort.weight`); never names a provider or model
 * and never shows dollar prices.
 */
export function workGuidance(
  provider: Provider | undefined,
  model: ProviderModel | undefined,
  effort: { id: string; label: string; weight?: EffortWeight } | undefined,
): string | undefined {
  if (!provider) return undefined;
  const tier = model?.tier;
  const weight = effort?.weight;
  if (tier === "fast") {
    return weight === "high" || weight === "max"
      ? "Roughly 5 to 10 minutes · light to moderate use of your plan."
      : "Roughly 3 to 5 minutes · light use of your plan.";
  }
  if (tier === "balanced") {
    if (weight === "max") return "Roughly 15 to 25 minutes · heavier use of your plan.";
    if (weight === "high") return "Roughly 10 to 15 minutes · moderate use of your plan.";
    return "Roughly 5 to 10 minutes · lighter use of your plan.";
  }
  if (tier === "strong") {
    return weight === "high" || weight === "max"
      ? "Roughly 20 to 30 minutes · heavy use of your plan."
      : "Roughly 15 to 20 minutes · heavier use of your plan.";
  }
  if (weight === "max") return "Takes longer · heavier use of your plan.";
  if (weight === "high") return "Roughly 10 to 30 minutes depending on the model · moderate to heavy use of your plan.";
  if (weight === "light") return "Usually faster · lighter use of your plan.";
  return "Usually 5 to 30 minutes depending on the model and effort · uses your own plan.";
}

/** The chat's default from Settings, as a provider pick: what a chat that never picked is answered by. */
export function chatDefault(providers: Providers): { pick?: string; effort?: string } {
  const own = providers.picks?.chat;
  const p = own?.agent ? providers.providers.find((x) => x.id === own.agent) : undefined;
  if (!p) return {};
  const model = own!.model ? p.models.find((m) => m.id === own!.model) : undefined;
  return { pick: model?.pick ?? p.pick, ...(own!.effort ? { effort: own!.effort } : {}) };
}
