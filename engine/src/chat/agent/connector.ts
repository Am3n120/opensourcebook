/**
 * The engine's side of the connector that runs the person's own agent on
 * their computer (services/agent-connector; engine/docs/api.md, "Your
 * agent"). The engine hands it a turn (prompts, the tool list, where to
 * call back) and may stop it; the connector runs the agent and sends every
 * tool call and the end of the turn back to the engine.
 *
 * Local only for now: a connector URL that is not this machine is refused.
 */
import { isRecord } from "../../net";
import type { FetchLike } from "../../types";
import type { ToolListing } from "./tools";

export interface AgentConfig {
  /** The connector, e.g. http://127.0.0.1:8650. */
  url: string;
  token: string;
  /** The agent adapter the connector runs (`claude`, `codex`); the connector's default when absent. */
  agent?: string;
  model?: string;
  effort?: string;
  /** Where the connector calls back; the origin of the request that started the turn when absent. */
  callbackUrl?: string;
  /** How long one turn may run before it is stopped. */
  timeoutMs: number;
}

/** Why the connector could not take or finish a turn, in the chat's words (ReplyFailureReason). */
export type AgentProblem = "agentUnreachable" | "agentMissing" | "agentSignedOut" | "agentLimit" | "timedOut" | "stopped" | "error";

/** Rough capability and cost tier of a model reported by the connector. */
export type ModelTier = "fast" | "balanced" | "strong";

/** Rough thinking budget weight of an effort setting reported by the connector. */
export type EffortWeight = "light" | "medium" | "high" | "max";

/** One agent the connector can run, as it reports it. */
export interface ConnectorAgent {
  id: string;
  label: string;
  installed: boolean;
  signedIn?: boolean;
  version?: string;
  /** Why the connector can't run it yet, in plain words. */
  unavailable?: string;
  /** It is not signed in and answers with an API key the person gave the connector. */
  apiKey?: boolean;
  /** How it answers, in one plain sentence from its adapter, when that is worth saying. */
  note?: string;
  /** Its logo, from its adapter. */
  mark?: Mark;
  /** The models it can be asked to use, as the connector names them, each with its maker when the connector knows it. */
  models?: Array<{ id: string; label: string; maker?: string; tier?: ModelTier }>;
  /** The makers of its models, by id: their names and logos. */
  makers?: Record<string, { label: string; mark: Mark }>;
  /** Adapter defaults for chat vs long work turns (such as videos). */
  defaultModels?: { chat?: string; work?: string };
  defaultEfforts?: { chat?: string; work?: string };
  /** The efforts it can be asked to think with, lightest first. */
  efforts?: Array<{ id: string; label: string; weight?: EffortWeight }>;
  /** What to run on the person's computer to sign in to it. */
  signIn?: string;
  /** Where it is installed from, from its adapter: its own install page, and its one-line install command when it has one. */
  install?: { command?: string; url: string };
  /** Its plan's usage limit, while the connector remembers it hit one: since when, and when it said it resets. */
  limit?: { since?: string; resetsAt?: string; resets?: string };
}

/** A logo: one filled path in a 24×24 box, in `color` or the text's colour. */
export interface Mark {
  path: string;
  color?: string;
}

/** What the agent said about when its limit resets, only what it really said. */
export interface HeardLimit {
  resetsAt?: string;
  resets?: string;
}

/** Reads a limit from a connector answer: an ISO reset time and the agent's own words, each only when there. */
export function readLimit(value: unknown): HeardLimit & { since?: string } {
  if (!isRecord(value)) return {};
  const time = (key: string) => (typeof value[key] === "string" && Number.isFinite(Date.parse(value[key] as string)) ? (value[key] as string) : undefined);
  const resets = typeof value.resets === "string" && value.resets.trim() ? value.resets.trim().slice(0, 80) : undefined;
  return { ...(time("since") ? { since: time("since")! } : {}), ...(time("resetsAt") ? { resetsAt: time("resetsAt")! } : {}), ...(resets ? { resets } : {}) };
}

export interface AgentStatus {
  /** The connector answered. */
  reachable: boolean;
  /** The agent the person named for this engine or the connector (CHAT_AGENT, OPENSOURCEBOOK_AGENT); none when they named none. */
  agent?: ConnectorAgent;
  model?: string;
  /** The effort the engine's own agent thinks with when a chat picked none. */
  effort?: string;
  /** Every agent the connector can run, for Settings and the chat's picker. */
  agents?: ConnectorAgent[];
}

/** Which agent, model and effort one turn uses, when the chat picked them; the engine's settings otherwise. */
export interface TurnPick {
  agent?: string;
  model?: string;
  effort?: string;
}

export interface StartTurn {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  tools: ToolListing[];
  callback: { url: string; token: string };
  /** Tools whose input Open Sourcebook shows while the agent still writes it (POST <callback>/draft). */
  drafts?: string[];
  /** What the agent is told about the tools when it connects; the chat's line when absent. */
  instructions?: string;
  /** How long this turn may run, 0 for until it ends or is stopped; the engine's setting when absent. */
  timeoutMs?: number;
  /** What the turn is for, recorded in the connector's usage log. */
  target?: { type: string; id: string };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STATUS_TIMEOUT_MS = 5_000;
/** Ten minutes: long enough for the agent to read a course and write a big plan in parts. */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/** True for a URL on this machine. */
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export class ConnectorClient {
  constructor(
    readonly config: AgentConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** What the connector reports; `fresh` asks it to check each agent again rather than answer from its last check. */
  async status(options: { fresh?: boolean } = {}): Promise<AgentStatus> {
    const response = await this.call("GET", options.fresh ? "/status?fresh=1" : "/status", undefined, STATUS_TIMEOUT_MS);
    if (!response || !response.ok) return { reachable: false };
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body)) return { reachable: false };
    const agents = (Array.isArray(body.agents) ? body.agents : []).filter(isRecord).map(
      (agent): ConnectorAgent => ({
        id: String(agent.id),
        label: String(agent.label ?? agent.id),
        installed: agent.installed === true,
        ...(typeof agent.signedIn === "boolean" ? { signedIn: agent.signedIn } : {}),
        ...(typeof agent.version === "string" ? { version: agent.version } : {}),
        ...(typeof agent.unavailable === "string" && agent.unavailable ? { unavailable: agent.unavailable.slice(0, 300) } : {}),
        ...(agent.apiKey === true ? { apiKey: true } : {}),
        ...(typeof agent.note === "string" && agent.note.trim() ? { note: agent.note.trim().slice(0, 300) } : {}),
        ...markedOf(agent),
        ...(defaultsOf(agent.defaultModels) ? { defaultModels: defaultsOf(agent.defaultModels) } : {}),
        ...(defaultsOf(agent.defaultEfforts) ? { defaultEfforts: defaultsOf(agent.defaultEfforts) } : {}),
        ...(Array.isArray(agent.efforts) ? { efforts: effortsOf(agent.efforts) } : {}),
        ...(typeof agent.signIn === "string" && agent.signIn.trim() ? { signIn: agent.signIn.trim().slice(0, 200) } : {}),
        ...installOf(agent.install),
        ...(isRecord(agent.limit) ? { limit: readLimit(agent.limit) } : {}),
      }),
    );
    // The agent the person named (CHAT_AGENT, else the connector's OPENSOURCEBOOK_AGENT); none is chosen for them, not even the first.
    const id = this.config.agent ?? (typeof body.agent === "string" ? body.agent : undefined);
    const agent = agents.find((candidate) => candidate.id === id);
    const model = this.config.model ?? (typeof body.model === "string" ? body.model : undefined);
    const effort = this.config.effort ?? (typeof body.effort === "string" ? body.effort : undefined);
    return { reachable: true, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), agents };
  }

  /**
   * Hands the turn over; the connector answers at once and runs it in the
   * background. A picked agent replaces the configured one, and with it
   * the configured model and effort: those belong to the configured agent.
   */
  /**
   * The agent, model and effort a turn with this pick is sent with: the pick's, else the engine's own settings for
   * its own agent. A turn keeps it, so its time is kept under what it really ran on.
   */
  sentPick(pick: TurnPick = {}): TurnPick {
    const agent = pick.agent ?? this.config.agent;
    const own = !pick.agent || pick.agent === this.config.agent;
    const model = pick.model ?? (own ? this.config.model : undefined);
    const effort = pick.effort ?? (own ? this.config.effort : undefined);
    return { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  async start(turn: StartTurn, pick: TurnPick = {}): Promise<{ ok: true; agent?: string } | { problem: AgentProblem; detail?: string; limit?: HeardLimit }> {
    const { agent, model, effort } = this.sentPick(pick);
    const response = await this.call("POST", "/turns", {
      ...turn,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      timeoutMs: turn.timeoutMs ?? this.config.timeoutMs,
    });
    if (!response) return { problem: "agentUnreachable" };
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return { ok: true, ...(isRecord(body) && typeof body.agent === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(body.agent) ? { agent: body.agent } : {}) };
    const problem = isRecord(body) && typeof body.problem === "string" ? asProblem(body.problem) : "error";
    const detail = isRecord(body) && typeof body.message === "string" ? body.message : `The connector answered ${response.status}.`;
    const limit = problem === "agentLimit" && isRecord(body) ? readLimit(body.limit) : {};
    return { problem, detail, ...(limit.resetsAt || limit.resets ? { limit: { ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), ...(limit.resets ? { resets: limit.resets } : {}) } } : {}) };
  }

  /**
   * Whether a turn still runs on the connector: `reachable` false when the
   * connector does not answer, `running` absent when it answers but cannot
   * say (an older connector).
   */
  async turn(turnId: string): Promise<{ reachable: boolean; running?: boolean }> {
    const response = await this.call("GET", `/turns/${encodeURIComponent(turnId)}`, undefined, STATUS_TIMEOUT_MS);
    if (!response) return { reachable: false };
    const body: unknown = await response.json().catch(() => undefined);
    return response.ok && isRecord(body) && typeof body.running === "boolean" ? { reachable: true, running: body.running } : { reachable: true };
  }

  /**
   * Whether `agent` can answer now, with the smallest turn there is (the
   * connector runs none while it knows the limit's reset is still ahead).
   * Undefined when the connector cannot be reached or has no such check.
   */
  async probe(agent: string): Promise<{ ok: true } | { ok: false; problem: AgentProblem; limit: HeardLimit } | undefined> {
    const response = await this.call("POST", `/agents/${encodeURIComponent(agent)}/probe`, {}, 120_000);
    if (!response || !response.ok) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body)) return undefined;
    if (body.ok === true) return { ok: true };
    const { since: _since, ...limit } = readLimit(body.limit);
    return { ok: false, problem: asProblem(body.problem), limit };
  }

  /**
   * One page of the connector's usage log, newest first (its `GET /usage`): the finished turns before line `before`,
   * with `next` to page further back. `reachable` false when it does not answer or cannot say (an older connector).
   */
  async usage(query: { limit?: number; before?: number } = {}): Promise<{ reachable: false } | { reachable: true; turns: UsageTurn[]; next?: number; off?: boolean }> {
    const params = new URLSearchParams();
    if (query.limit) params.set("limit", String(query.limit));
    if (query.before) params.set("before", String(query.before));
    const response = await this.call("GET", `/usage${params.size ? `?${params}` : ""}`, undefined, STATUS_TIMEOUT_MS);
    if (!response || !response.ok) return { reachable: false };
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body) || !Array.isArray(body.turns)) return { reachable: false };
    const turns = body.turns.map(usageTurnOf).filter((turn): turn is UsageTurn => turn !== undefined);
    const next = wholeOf(body.next);
    return { reachable: true, turns, ...(next ? { next } : {}), ...(body.off === true ? { off: true } : {}) };
  }

  /** Stops a running turn. Best effort: a connector that is gone has nothing running. */
  async stop(turnId: string): Promise<void> {
    await this.call("POST", `/turns/${encodeURIComponent(turnId)}/stop`, {}, STATUS_TIMEOUT_MS);
  }

  /** Undefined when the connector cannot be reached. */
  private async call(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Response | undefined> {
    try {
      return await this.fetchImpl(`${this.config.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * One finished turn from the connector's usage log: when it ended, what it was for (`type`, `targetId`, as the turn
 * named them), who ran it on what, how long it took, its tokens and tool calls, and how it ended. Never a cost.
 * `line` is its place in the log, the cursor to page back from it.
 */
export interface UsageTurn {
  line: number;
  time: string;
  turnId: string;
  agent: string;
  type?: string;
  targetId?: string;
  model?: string;
  effort?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  toolCalls: number;
  outcome: "done" | "failed" | "stopped";
}

function wholeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageTurnOf(value: unknown): UsageTurn | undefined {
  if (!isRecord(value)) return undefined;
  const text = (key: string, max = 200) => (typeof value[key] === "string" && value[key] ? (value[key] as string).slice(0, max) : undefined);
  const line = wholeOf(value.line);
  const time = text("time", 40);
  const turnId = text("turnId");
  const agent = text("agent", 40);
  if (!line || !time || !Number.isFinite(Date.parse(time)) || !turnId || !agent) return undefined;
  const optional = {
    type: text("type", 64),
    targetId: text("targetId"),
    model: text("model"),
    effort: text("effort", 64),
    inputTokens: wholeOf(value.inputTokens),
    outputTokens: wholeOf(value.outputTokens),
    cacheReadTokens: wholeOf(value.cacheReadTokens),
    cacheWriteTokens: wholeOf(value.cacheWriteTokens),
  };
  const outcome = value.outcome === "done" || value.outcome === "stopped" ? value.outcome : "failed";
  return {
    line,
    time,
    turnId,
    agent,
    ...(Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) as Partial<UsageTurn>),
    durationMs: wholeOf(value.durationMs) ?? 0,
    toolCalls: wholeOf(value.toolCalls) ?? 0,
    outcome,
  };
}

const MODEL_TIERS = new Set<ModelTier>(["fast", "balanced", "strong"]);
const EFFORT_WEIGHTS = new Set<EffortWeight>(["light", "medium", "high", "max"]);
const DEFAULT_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function defaultsOf(value: unknown): { chat?: string; work?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const chat = typeof value.chat === "string" && DEFAULT_PART.test(value.chat.trim()) ? value.chat.trim() : undefined;
  const work = typeof value.work === "string" && DEFAULT_PART.test(value.work.trim()) ? value.work.trim() : undefined;
  return chat || work ? { ...(chat ? { chat } : {}), ...(work ? { work } : {}) } : undefined;
}

/** The models an agent offers, as the connector lists them; anything malformed is dropped. */
function modelsOf(list: unknown[]): Array<{ id: string; label: string; tier?: ModelTier }> {
  return list
    .filter(isRecord)
    .filter((model) => typeof model.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model.id))
    .slice(0, 20)
    .map((model) => ({
      id: String(model.id),
      label: typeof model.label === "string" && model.label.trim() ? model.label.trim().slice(0, 60) : String(model.id),
      ...(typeof model.tier === "string" && MODEL_TIERS.has(model.tier as ModelTier) ? { tier: model.tier as ModelTier } : {}),
    }));
}

/** The efforts an agent offers, keeping valid weight tags when present. */
function effortsOf(list: unknown[]): Array<{ id: string; label: string; weight?: EffortWeight }> {
  return list
    .filter(isRecord)
    .filter((effort) => typeof effort.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(effort.id))
    .slice(0, 20)
    .map((effort) => ({
      id: String(effort.id),
      label: typeof effort.label === "string" && effort.label.trim() ? effort.label.trim().slice(0, 60) : String(effort.id),
      ...(typeof effort.weight === "string" && EFFORT_WEIGHTS.has(effort.weight as EffortWeight) ? { weight: effort.weight as EffortWeight } : {}),
    }));
}

/** Where an agent is installed from, as the connector says it: an https page, and a one-line command of plain text. */
function installOf(value: unknown): { install?: { command?: string; url: string } } {
  if (!isRecord(value) || typeof value.url !== "string") return {};
  let url: URL;
  try {
    url = new URL(value.url.trim());
  } catch {
    return {};
  }
  if (url.protocol !== "https:" || value.url.length > 300) return {};
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const plain = command && command.length <= 200 && !/[\u0000-\u001f\u007f]/.test(command);
  return { install: { ...(plain ? { command } : {}), url: value.url.trim() } };
}

/** A logo as the connector sends it: drawing commands and a colour only, so nothing else reaches the page. */
export function markOf(value: unknown): Mark | undefined {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length > 6_000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(value.path)) return undefined;
  return { path: value.path, ...(typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color) ? { color: value.color } : {}) };
}

/** An agent's logo, its models and their makers' logos; a model's maker is kept only when its logo came too. */
function markedOf(agent: Record<string, unknown>): Pick<ConnectorAgent, "mark" | "models" | "makers"> {
  const mark = markOf(agent.mark);
  const makers: Record<string, { label: string; mark: Mark }> = {};
  for (const [id, maker] of Object.entries(isRecord(agent.makers) ? agent.makers : {}).slice(0, 20)) {
    if (!isRecord(maker) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) continue;
    const makerMark = markOf(maker.mark);
    if (makerMark) makers[id] = { label: typeof maker.label === "string" && maker.label.trim() ? maker.label.trim().slice(0, 60) : id, mark: makerMark };
  }
  const said = new Map((Array.isArray(agent.models) ? agent.models : []).filter(isRecord).map((model) => [model.id, model.maker]));
  const models = Array.isArray(agent.models)
    ? modelsOf(agent.models).map((model): { id: string; label: string; maker?: string; tier?: ModelTier } => {
        const maker = said.get(model.id);
        return typeof maker === "string" && Object.hasOwn(makers, maker) ? { ...model, maker } : model;
      })
    : undefined;
  const used = new Set(models?.flatMap((model) => (model.maker ? [model.maker] : [])));
  const kept = Object.fromEntries(Object.entries(makers).filter(([id]) => used.has(id)));
  return { ...(mark ? { mark } : {}), ...(models ? { models } : {}), ...(Object.keys(kept).length ? { makers: kept } : {}) };
}

const PROBLEMS: readonly AgentProblem[] = ["agentUnreachable", "agentMissing", "agentSignedOut", "agentLimit", "timedOut", "stopped", "error"];

export function asProblem(value: unknown): AgentProblem {
  return PROBLEMS.includes(value as AgentProblem) ? (value as AgentProblem) : "error";
}
