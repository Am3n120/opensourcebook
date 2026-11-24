/**
 * The one home of the agent settings a format declares: who makes an item
 * (`agent`, `effort`) and, for a format that has a review turn, who reads it
 * fresh once it is made (`reviewer`, `reviewEffort`). Formats declare the
 * fields through these helpers, parse them through them and settle them
 * against the person's remembered picks (`agent_picks`) through them, so
 * every shape reads and remembers an agent the same way.
 *
 * Values: "auto" (the scope's default, from Settings), a pick id ("agent",
 * "agent:<provider>", "agent:<provider>:<model>") and, for a reviewer only,
 * "off". A remembered effort is applied only when the remembered agent is
 * the agent being used, so an effort never reaches an agent it was not
 * picked for (docs/DECISIONS.md #91).
 */
import type { TurnPick } from "../chat/agent/connector";
import { parseEffort, parsePick, pickId, resolvePick, type ProviderView } from "../chat/providers";
import type { EngineContext, FormatDescriptor, JsonValue, PicksByScope, ScopePick, SettingCondition, SettingField, ValidationIssue } from "../studio/types";

/** Who makes it: "auto" | "agent" | "agent:<provider>" | "agent:<provider>:<model>". */
export const AGENT_KEY = "agent";
/** How hard the maker thinks: "auto" | an effort id. */
export const EFFORT_KEY = "effort";
/** Who reads it fresh once made: "auto" | "off" | a pick id. */
export const REVIEWER_KEY = "reviewer";
/** How hard the reviewer thinks: "auto" | an effort id. */
export const REVIEW_EFFORT_KEY = "reviewEffort";
/** The open value: the scope's default decides. */
export const AUTO = "auto";
/** A reviewer's value for "no review". */
export const REVIEW_OFF = "off";

/** The keys these helpers own, for a format's unknown-key check. */
export const AGENT_SETTING_KEYS: readonly string[] = [AGENT_KEY, EFFORT_KEY];
export const REVIEWER_SETTING_KEYS: readonly string[] = [REVIEWER_KEY, REVIEW_EFFORT_KEY];

export interface AgentSettings {
  agent?: string;
  effort?: string;
}

export interface ReviewerSettings {
  reviewer?: string;
  reviewEffort?: string;
}

/** The remembered-pick scope of a format's reviewer. */
export function reviewScope(formatId: string): string {
  return `${formatId}.review`;
}

/** True for a scope that holds a reviewer's pick. */
export function isReviewScope(scope: string): boolean {
  return scope.endsWith(".review");
}

/** The maker's agent field (kind "agent", role "make"). */
export function agentField(turnKind: "chat" | "work", showWhen?: SettingCondition, help = "Which agent, model and thinking effort make it."): SettingField {
  return {
    key: AGENT_KEY,
    label: "Agent & model",
    help,
    kind: "agent",
    effortKey: EFFORT_KEY,
    turnKind,
    role: "make",
    ...(showWhen ? { showWhen } : {}),
  };
}

/** The reviewer's agent field (kind "agent", role "review"); it can be off. */
export function reviewerField(turnKind: "chat" | "work" = "work", showWhen?: SettingCondition, help = "Which agent, model and thinking effort read it fresh once it is made, or off."): SettingField {
  return {
    key: REVIEWER_KEY,
    label: "Reviewed by",
    help,
    kind: "agent",
    effortKey: REVIEW_EFFORT_KEY,
    turnKind,
    role: "review",
    offValue: REVIEW_OFF,
    ...(showWhen ? { showWhen } : {}),
  };
}

/** Reads `agent` and `effort` from raw settings, adding an issue for each bad value. */
export function readAgentFields(record: Record<string, unknown>, issues: ValidationIssue[]): AgentSettings {
  const out: AgentSettings = {};
  const agent = readPickValue(record, AGENT_KEY, false, issues);
  if (agent) out.agent = agent;
  const effort = readEffortValue(record, EFFORT_KEY, issues);
  if (effort) out.effort = effort;
  return out;
}

/** Reads `reviewer` and `reviewEffort` from raw settings, adding an issue for each bad value. */
export function readReviewerFields(record: Record<string, unknown>, issues: ValidationIssue[]): ReviewerSettings {
  const out: ReviewerSettings = {};
  const reviewer = readPickValue(record, REVIEWER_KEY, true, issues);
  if (reviewer) out.reviewer = reviewer;
  const effort = readEffortValue(record, REVIEW_EFFORT_KEY, issues);
  if (effort) out.reviewEffort = effort;
  return out;
}

/** The concrete agent, model and effort of the maker; "auto" values are left out. */
export function agentPickOf(settings: AgentSettings): TurnPick {
  return concrete(settings.agent, settings.effort);
}

/**
 * Who runs a turn of `scope` (a format id) when the item names no agent: the
 * scope's default from Settings, else the agent the person named for the
 * engine or the connector (`own`: CHAT_AGENT, OPENSOURCEBOOK_AGENT), else the only
 * provider that can (`resolvePick`; with several it throws
 * `PickNeededError`). Undefined when none can. The item's own effort wins;
 * a remembered effort rides only with the agent it was picked for (#91).
 */
export function settleWorkPick(scope: string, pick: TurnPick, picks: PicksByScope | undefined, providers: readonly ProviderView[], own?: string): TurnPick | undefined {
  if (pick.agent) return pick;
  const remembered = picks?.[scope];
  const resolved = remembered?.agent ? resolvePick(scope, picks, providers) : own ? { agent: own } : resolvePick(scope, undefined, providers);
  if (!resolved?.agent) return undefined;
  const effort = pick.effort ?? resolved.effort ?? (remembered && !remembered.agent ? remembered.effort : undefined);
  return { agent: resolved.agent, ...(resolved.model ? { model: resolved.model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * The maker's pick for one turn of this item: its own, settled when it names
 * no agent (`EngineServices.settlePick`), so every turn names an agent.
 */
export async function workPickFor(ctx: EngineContext<AgentSettings>): Promise<TurnPick> {
  const pick = agentPickOf(ctx.node.settings);
  if (pick.agent || !ctx.services.settlePick) return pick;
  return ctx.services.settlePick(ctx.node.type, pick);
}

/**
 * The reviewer as the item has it: "off", "auto" (left to the scope's
 * default: today the maker's own pick), or its concrete pick.
 */
export function reviewerPickOf(settings: ReviewerSettings): "off" | "auto" | TurnPick {
  if (settings.reviewer === REVIEW_OFF) return "off";
  if (isOpen(settings.reviewer)) return "auto";
  return concrete(settings.reviewer, settings.reviewEffort);
}

/**
 * What the maker settings leave open, decided from the remembered pick of
 * `scope` (the format id): its agent when the item has none, its effort
 * when the item has none and the agent used is the remembered one.
 */
export function settleAgentPick(scope: string, settings: AgentSettings, picks?: PicksByScope): Record<string, JsonValue> {
  return settleOne(picks?.[scope], settings.agent, settings.effort, AGENT_KEY, EFFORT_KEY);
}

/**
 * The same for the reviewer, from the remembered pick of the format's
 * review scope (`formatId` + ".review"), which may be "off".
 */
export function settleReviewerPick(formatId: string, settings: ReviewerSettings, picks?: PicksByScope): Record<string, JsonValue> {
  const remembered = picks?.[reviewScope(formatId)];
  if (!remembered) return {};
  if (remembered.off) return isOpen(settings.reviewer) ? { [REVIEWER_KEY]: REVIEW_OFF } : {};
  if (settings.reviewer === REVIEW_OFF) return {};
  return settleOne(remembered, settings.reviewer, settings.reviewEffort, REVIEWER_KEY, REVIEW_EFFORT_KEY);
}

function settleOne(remembered: ScopePick | undefined, agent: string | undefined, effort: string | undefined, agentKey: string, effortKey: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!remembered || remembered.off) return out;
  if (isOpen(agent) && remembered.agent) {
    out[agentKey] = pickId({ agent: remembered.agent, ...(remembered.model ? { model: remembered.model } : {}) });
    if (isOpen(effort) && remembered.effort) out[effortKey] = remembered.effort;
    return out;
  }
  const using = agent && !isOpen(agent) ? parsePick(agent)?.agent : undefined;
  if (isOpen(effort) && remembered.effort && (!remembered.agent || using === remembered.agent)) out[effortKey] = remembered.effort;
  return out;
}

function isOpen(value: string | undefined): boolean {
  return !value || value === AUTO;
}

function concrete(agent: string | undefined, effort: string | undefined): TurnPick {
  const picked = agent && agent !== AUTO && agent !== REVIEW_OFF ? parsePick(agent) : undefined;
  const level = effort && effort !== AUTO ? parseEffort(effort) : undefined;
  return {
    ...(picked?.agent ? { agent: picked.agent } : {}),
    ...(picked?.model ? { model: picked.model } : {}),
    ...(level ? { effort: level } : {}),
  };
}

function readPickValue(record: Record<string, unknown>, key: string, mayBeOff: boolean, issues: ValidationIssue[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === AUTO) return AUTO;
  if (mayBeOff && value === REVIEW_OFF) return REVIEW_OFF;
  if (typeof value === "string" && parsePick(value)) return value.trim();
  const off = mayBeOff ? `, "${REVIEW_OFF}"` : "";
  issues.push({ path: `$.${key}`, code: "format", message: `${key} must be "${AUTO}"${off}, "agent", "agent:<provider>", or "agent:<provider>:<model>"`, severity: "error" });
  return undefined;
}

function readEffortValue(record: Record<string, unknown>, key: string, issues: ValidationIssue[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const effort = typeof value === "string" ? (value === AUTO ? AUTO : parseEffort(value)) : undefined;
  if (effort) return effort;
  issues.push({ path: `$.${key}`, code: "format", message: `${key} must be "${AUTO}" or an effort id`, severity: "error" });
  return undefined;
}

/**
 * The scopes a remembered pick may have, from the formats themselves:
 * `make` is "chat" and every format with a maker's agent field; `review`
 * is "<format>.review" for every format with a reviewer field. Never a
 * list by hand.
 */
export function pickScopes(descriptors: readonly FormatDescriptor[]): { make: string[]; review: string[] } {
  const make = ["chat"];
  const review: string[] = [];
  for (const descriptor of descriptors) {
    const agents = descriptor.settings.filter((field) => field.kind === "agent");
    if (agents.some((field) => field.kind === "agent" && field.role !== "review")) make.push(descriptor.id);
    if (agents.some((field) => field.kind === "agent" && field.role === "review")) review.push(reviewScope(descriptor.id));
  }
  return { make, review };
}
