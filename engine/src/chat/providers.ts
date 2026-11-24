/**
 * The person's providers (engine/docs/api.md, "Providers"; DECISIONS #62,
 * #63): the agents on their own computer that can answer the chat, as the
 * connector reports them (Claude Code now, Codex listed until it can run,
 * more later), each with whether it can answer now, what to do when it
 * can't, and the models and efforts it offers. The person adds a provider
 * to their list (one the connector finds installed is in it until they
 * remove it), turns it on or off, chooses which of its models the chat's
 * picker shows and stars favorites; that is kept per person
 * (`provider_settings`).
 *
 * Providers are listed A to Z by name and none is preferred: with nothing
 * picked, the only provider that can answer is used, and with several Open Sourcebook
 * asks (`resolvePick`).
 *
 * A chat's pick is one short id: `agent` (the connector's own agent),
 * `agent:<provider>` (that provider, its own default model) or
 * `agent:<provider>:<model>`. Nothing here names a provider or a model:
 * they come from the connector, each adapter naming its own.
 */
import { json } from "../http";
import type { ProviderSetting } from "../studio/repositories";
import type { PicksByScope, ScopePick } from "../studio/types";
import type { AgentStatus, EffortWeight, Mark, ModelTier } from "./agent/connector";

export interface Pick {
  agent?: string;
  model?: string;
  /** How hard it thinks: kept on the chat beside its pick, never part of the pick's id. */
  effort?: string;
}

/** Whether a provider can answer now, from what the connector says about it. */
export type ProviderState = "ready" | "signedOut" | "missing" | "unavailable";

export interface ProviderModel {
  /** The model's id as the provider takes it. */
  id: string;
  /** The chat's pick for this provider with this model. */
  pick: string;
  label: string;
  /** Shown in the chat's picker. */
  shown: boolean;
  /** Starred: listed under the picker's favorites. */
  favorite: boolean;
  /** Who made it, one of its provider's `makers`, when the connector knows. */
  maker?: string;
  /** Rough capability tier reported by the connector. */
  tier?: ModelTier;
}

export interface ProviderEffort {
  /** The effort's id as the provider takes it. */
  id: string;
  label: string;
  /** Rough thinking weight reported by the connector. */
  weight?: EffortWeight;
}

export interface ProviderView {
  id: string;
  label: string;
  /** Its logo, from its adapter; none gets a plain one on screen. */
  mark?: Mark;
  /** Runs on the person's computer. */
  local: true;
  /** In the person's list in Settings; one not in it is offered under Add provider and never used. */
  added: boolean;
  /** Turned on in Settings; a provider turned off is never used. */
  enabled: boolean;
  state: ProviderState;
  /** One line on its state, for Settings and the picker. */
  headline: string;
  /** What to do about it, when there is something to do. */
  detail?: string;
  /** The command that signs in to it, run on the person's computer: one step of its "How to connect". */
  signIn?: string;
  /** Where it is installed from: its own install page, and its one-line install command when it has one. */
  install?: { command?: string; url: string };
  version?: string;
  /** The chat's pick (`picks.chat`, set in Settings): it answers a chat that picked none. Nothing else is a default. */
  default?: boolean;
  /** The model the chat's pick names, when it names one. */
  defaultModel?: string;
  /** The effort the chat's pick names, when it names one. */
  defaultEffort?: string;
  /** Default agent for long work turns (such as videos), when configured. */
  workDefault?: boolean;
  /** The model this provider runs on for long work turns when no model was picked. */
  workDefaultModel?: string;
  /** The effort this provider thinks with on long work turns when no effort was picked. */
  workDefaultEffort?: string;
  /** The chat's pick for this provider with its own default model. */
  pick: string;
  models: ProviderModel[];
  /** The makers of its models, by id: their names and logos. */
  makers?: Record<string, { label: string; mark: Mark }>;
  /** What a chat may pick for how hard it thinks, lightest first; empty when it takes none. */
  efforts: ProviderEffort[];
}

const PART = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A pick read from its id; undefined when the id is not one. */
export function parsePick(id: string): Pick | undefined {
  const [by, agent, model, ...rest] = id.trim().split(":");
  if (by !== "agent" || rest.length > 0) return undefined;
  if (agent === undefined) return {};
  if (!PART.test(agent)) return undefined;
  if (model === undefined) return { agent };
  return PART.test(model) ? { agent, model } : undefined;
}

export function pickId(pick: Pick): string {
  if (!pick.agent) return "agent";
  return pick.model ? `agent:${pick.agent}:${pick.model}` : `agent:${pick.agent}`;
}

/**
 * Each agent the connector reports, with the person's settings over it, A to Z by name whatever order the connector
 * lists them in. `chat` is the chat's remembered pick (`picks.chat`): the provider it names is the `default`. Empty
 * when the connector can't be reached.
 */
export function providerViews(
  status: AgentStatus,
  settings: readonly ProviderSetting[],
  work?: { agent?: string; model?: string; effort?: string },
  chat?: ScopePick,
): ProviderView[] {
  if (!status.reachable) return [];
  const byId = new Map(settings.map((setting) => [setting.providerId, setting]));
  const agents = [...(status.agents ?? [])].sort((a, b) => byLabel(a.label, b.label) || byLabel(a.id, b.id));
  return agents.map((agent) => {
    const setting = byId.get(agent.id);
    const hidden = new Set(setting?.hiddenModels ?? []);
    const favorites = new Set(setting?.favoriteModels ?? []);
    // Not signed in but answering with an API key the person gave the connector is ready; its note says so.
    const state: ProviderState = !agent.installed ? "missing" : agent.unavailable ? "unavailable" : agent.signedIn === false && !agent.apiKey ? "signedOut" : "ready";
    const said =
      state === "missing"
        ? { headline: "Not installed", detail: `Install ${agent.label} on your computer, then check again.` }
        : state === "unavailable"
          ? { headline: "Can't run yet", detail: agent.unavailable! }
          : state === "signedOut"
            ? { headline: "Not signed in", detail: agent.signIn ? "Run this on your computer, then check again." : `Sign in to ${agent.label} on your computer, then check again.` }
            : { headline: "Ready", ...(agent.note ? { detail: agent.note } : {}) };
    const isDefault = Boolean(chat?.agent && agent.id === chat.agent);
    const isWorkDefault = Boolean(work?.agent && agent.id === work.agent);
    const workModel = (isWorkDefault ? work?.model : undefined) ?? agent.defaultModels?.work;
    const workEffort = (isWorkDefault ? work?.effort : undefined) ?? agent.defaultEfforts?.work;
    return {
      id: agent.id,
      label: agent.label,
      ...(agent.mark ? { mark: agent.mark } : {}),
      local: true,
      added: setting?.added ?? agent.installed,
      enabled: setting?.enabled ?? true,
      state,
      ...said,
      ...(agent.signIn ? { signIn: agent.signIn } : {}),
      ...(agent.install ? { install: agent.install } : {}),
      ...(agent.version ? { version: agent.version } : {}),
      ...(isDefault ? { default: true } : {}),
      ...(isDefault && chat?.model ? { defaultModel: chat.model } : {}),
      ...(isDefault && chat?.effort ? { defaultEffort: chat.effort } : {}),
      ...(isWorkDefault ? { workDefault: true } : {}),
      ...(workModel ? { workDefaultModel: workModel } : {}),
      ...(workEffort ? { workDefaultEffort: workEffort } : {}),
      pick: pickId({ agent: agent.id }),
      models: (agent.models ?? []).map((model) => ({
        id: model.id,
        pick: pickId({ agent: agent.id, model: model.id }),
        label: model.label,
        shown: !hidden.has(model.id),
        favorite: favorites.has(model.id),
        ...(model.maker ? { maker: model.maker } : {}),
        ...(model.tier ? { tier: model.tier } : {}),
      })),
      ...(agent.makers ? { makers: agent.makers } : {}),
      efforts: agent.efforts ?? [],
    } satisfies ProviderView;
  });
}

/** Can answer the chat now: in the list, on, and ready. */
export function usable(provider: ProviderView): boolean {
  return provider.added && provider.enabled && provider.state === "ready";
}

/** An effort as a chat sends it: a short id the provider names; undefined when it is not one. */
export function parseEffort(id: string): string | undefined {
  const trimmed = id.trim();
  return PART.test(trimmed) ? trimmed : undefined;
}

/** Names compared as people read them, case and accents aside. */
function byLabel(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/**
 * Nothing was picked for this scope and more than one provider could do it, so the person is asked; nothing is
 * stored. `scope` is the one that needs a pick first; `scopes` every one the same request needs (a thing made from a
 * terminal needs its shape's maker, and the chat that settles it when the chat has no pick either).
 */
export class PickNeededError extends Error {
  readonly scopes: string[];
  constructor(
    readonly scope: string,
    also: readonly string[] = [],
  ) {
    const scopes = [scope, ...also.filter((other) => other !== scope)];
    super(pickNeededWords(scopes));
    this.scopes = scopes;
    this.name = "PickNeededError";
  }
}

/** `409 pick_needed`, with the scope that needs a pick first and every one the request needs, so a client opens the right picker. */
export function pickNeededResponse(error: PickNeededError): Response {
  return json({ error: "pick_needed", message: error.message, scope: error.scope, scopes: error.scopes }, 409);
}

/** Who a scope needs, in words: "who answers the chat", "who makes flashcards", "who reviews video". */
function whoFor(scope: string): string {
  if (scope === "chat") return "who answers the chat";
  const review = /^(.+)\.review$/.exec(scope);
  return review ? `who reviews ${review[1]}` : `who makes ${scope}`;
}

/** What a pick_needed answer says: which thing needs a pick, and where the app picks it. */
export function pickNeededWords(scopes: readonly string[]): string {
  const [first, ...rest] = scopes;
  if (first === undefined) return "Pick who does it in Settings, What makes what.";
  if (rest.length === 0) {
    return first === "chat"
      ? "Several of your agents could answer the chat and none is picked: pick who answers in the chat's picker, or for every chat in Settings, What makes what."
      : `Several of your agents could do it and none is picked: pick ${whoFor(first)} in Settings, What makes what.`;
  }
  // The chat is named last, with why: it is the turn that settles the thing asked for.
  const named = [...scopes.filter((scope) => scope !== "chat"), ...(scopes.includes("chat") ? ["chat"] : [])].map((scope) => (scope === "chat" ? `${whoFor(scope)} (the chat settles what it will be)` : whoFor(scope)));
  return `Several of your agents could do it and none is picked: pick ${named.slice(0, -1).join(", ")} and ${named.at(-1)}, in Settings, What makes what.`;
}

/**
 * Who does the work of a scope (`chat`, a format id, or "<format>.review") when the turn itself names nobody: the
 * scope's remembered pick when it names an agent; else the one provider that is added, on and ready, when there is
 * exactly one; with several, `PickNeededError` (the engine answers `409 pick_needed`), as no provider is preferred.
 * Undefined when none can: the caller says so in its own words. A remembered pick is returned as it is, even of a
 * provider now turned off; the caller refuses that one as it refuses any pick of it.
 */
export function resolvePick(scope: string, picks: PicksByScope | undefined, providers: readonly ProviderView[]): Pick | undefined {
  const remembered = picks?.[scope];
  if (remembered?.agent) {
    return { agent: remembered.agent, ...(remembered.model ? { model: remembered.model } : {}), ...(remembered.effort ? { effort: remembered.effort } : {}) };
  }
  const ready = providers.filter(usable);
  if (ready.length === 1) return { agent: ready[0]!.id };
  if (ready.length > 1) throw new PickNeededError(scope);
  return undefined;
}
