import type { AgentPick, FormatDescriptor, JsonObject, Providers } from "../api/types";
import type { ProvidersStatus } from "../app/context";
import { usable } from "../project/providers";
import { agentField, type MakerPick } from "./makerKey";

/**
 * Who makes (or reviews) one thing, read from its settings the way the
 * engine reads them (engine/src/engines/agent-fields.ts): the agent field
 * holds "auto" or nothing (the shape's default decides), a pick id
 * ("agent:<provider>" or "agent:<provider>:<model>") or, for a reviewer,
 * its off value; the effort sits in the field's `effortKey`.
 */
export type RowPick =
  /** Picked for this thing alone. */
  | { from: "own"; pick: MakerPick | null }
  /** Left to the person's default for the shape, which is this. */
  | { from: "default"; pick: MakerPick | null }
  /** No pick here and no default. */
  | { from: "none"; pick: null };

const OPEN = "auto";

/** "agent:zeta:z-mid" as a pick. */
export function parsePickId(id: string): { agent: string; model?: string } | undefined {
  const m = /^agent:([^:]+)(?::(.+))?$/.exec(id.trim());
  if (!m) return undefined;
  return m[2] ? { agent: m[1]!, model: m[2] } : { agent: m[1]! };
}

export function pickIdOf(pick: { agent: string; model?: string }): string {
  return pick.model ? `agent:${pick.agent}:${pick.model}` : `agent:${pick.agent}`;
}

function fromDefault(stored: AgentPick | undefined, role: "maker" | "reviewer"): RowPick {
  if (!stored) return { from: "none", pick: null };
  if (stored.off) return role === "reviewer" ? { from: "default", pick: null } : { from: "none", pick: null };
  if (!stored.agent) return { from: "none", pick: null };
  return { from: "default", pick: { agent: stored.agent, ...(stored.model ? { model: stored.model } : {}), ...(stored.effort ? { effort: stored.effort } : {}) } };
}

const same = (a: MakerPick | null, b: MakerPick | null) => (a?.agent ?? null) === (b?.agent ?? null) && a?.model === b?.model && a?.effort === b?.effort;

/**
 * The maker or reviewer this thing has now. A pick in the settings that is
 * the same as the default still reads as the default, so a sheet filled in
 * from the defaults says so.
 */
export function rowPick(format: FormatDescriptor, settings: JsonObject, role: "maker" | "reviewer", picks: Record<string, AgentPick> | undefined): RowPick {
  const field = agentField(format, role);
  const scope = role === "reviewer" ? `${format.id}.review` : format.id;
  const stored = fromDefault(picks?.[scope], role);
  if (!field) return { from: "none", pick: null };
  const raw = settings[field.key] ?? format.defaults[field.key];
  const rawEffort = field.effortKey ? (settings[field.effortKey] ?? format.defaults[field.effortKey]) : undefined;
  const effort = typeof rawEffort === "string" && rawEffort !== OPEN ? rawEffort : undefined;
  let own: MakerPick | null | undefined;
  if (typeof raw === "string" && field.offValue && raw === field.offValue) own = null;
  else if (typeof raw === "string" && raw !== OPEN) {
    const parsed = parsePickId(raw);
    if (parsed) own = { ...parsed, ...(effort ? { effort } : {}) };
  }
  if (own === undefined) {
    // An effort alone goes with the default agent, as the engine settles it.
    if (effort && stored.pick && stored.from === "default") return same({ ...stored.pick, effort }, stored.pick) ? stored : { from: "own", pick: { ...stored.pick, effort } };
    return stored;
  }
  if (stored.from === "default" && same(own, stored.pick)) return stored;
  return { from: "own", pick: own };
}

/** The settings with this thing's maker or reviewer set to `pick` (null: a reviewer turned off). */
export function withPick(format: FormatDescriptor, settings: JsonObject, role: "maker" | "reviewer", pick: MakerPick | null): JsonObject {
  const field = agentField(format, role);
  if (!field) return settings;
  const next: JsonObject = { ...settings };
  if (pick === null) {
    if (!field.offValue) return settings;
    next[field.key] = field.offValue;
    if (field.effortKey) delete next[field.effortKey];
    return next;
  }
  next[field.key] = pickIdOf(pick);
  if (field.effortKey) {
    if (pick.effort) next[field.effortKey] = pick.effort;
    else delete next[field.effortKey];
  }
  return next;
}

/**
 * The engine has answered and no agent on this computer can make anything:
 * none added, or none ready. Never while the providers are still loading or
 * could not be read, and not when the connector can't be reached (that says so itself).
 */
export function noAgentSetUp(providers: Providers | undefined, status: ProvidersStatus): boolean {
  return status === "ready" && !!providers && providers.connector.configured && providers.connector.reachable && !providers.providers.some(usable);
}
