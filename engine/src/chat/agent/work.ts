/**
 * A piece of work done by the person's own agent: one turn of their agent,
 * through the connector on their computer (connector.ts), that makes one
 * item (a set of flashcards, a quiz) with tools Open Sourcebook hands it for that item. It is the
 * chat's mechanism (turn.ts) used for an item instead of a reply: the
 * engine starts the turn with a prompt and a tool list, the connector calls
 * each tool back here with the turn's token, and reports the end.
 *
 * The turn belongs to the job that makes the item and lives while that
 * job's `generate` waits on it: tool calls are dispatched into it by turn id
 * (routes/work-turns.ts), one at a time, each shown on the item as a step
 * ("Reading Lecture 3"). What a tool keeps is the maker's to save on the
 * job, so a retry carries on from it. While waiting, the job is touched
 * every few seconds (a Stop is seen there) and the connector is asked
 * whether the turn still runs (a dropped connector or turn is seen there).
 *
 * Local only, like the chat's own agent (DECISIONS #53).
 */
import type { JsonValue } from "../../studio/types";
import { ConnectorClient, type AgentConfig, type AgentProblem, type AgentStatus, type HeardLimit, type TurnPick } from "./connector";
import type { JsonSchema, ToolListing } from "./tools";
import type { FetchLike, UsageSink } from "../../types";
import { agentErrorFailure, JobFailure } from "../../jobs/lifecycle";
import type { JobFailureCode } from "../../jobs/failure-words";
import { JobWait } from "../../jobs/waits";
import type { AgentCheck } from "../../jobs/keeper";

/** One tool of a piece of work: defined once, its description written for the agent. */
export interface WorkTool<Work> {
  /** Lower snake_case; the agent sees it as is. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** What the person sees on the item while it runs ("Writing card 4 of 9"). */
  label(input: Record<string, unknown>, work: Work): string;
  run(input: Record<string, unknown>, work: Work): Promise<WorkAnswer> | WorkAnswer;
}

export interface WorkAnswer {
  /** What the agent reads back. */
  text: string;
  /** The call did nothing; `text` says what was wrong and how to call it again. */
  isError?: boolean;
}

/** How a turn ended, as the connector reported it or as Open Sourcebook saw it. */
export interface WorkEnd {
  outcome: "done" | "failed";
  problem?: AgentProblem | "dropped";
  /** Words the agent ended with. */
  text?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
  /** The agent the connector ran. */
  agent?: string;
  /** When the problem is the agent's plan limit: when it said it resets, only if it said so. */
  limit?: HeardLimit;
  /** With a failed turn: the agent's own words on why, from its own error (the connector's `said`). */
  said?: string;
  /** How many of Open Sourcebook's tools the agent called in this turn, as Open Sourcebook answered them; absent when the turn never started. */
  toolCalls?: number;
}

export interface WorkSpec<Work> {
  /** Unique per turn: letters, digits and dashes. */
  turnId: string;
  systemPrompt: string;
  prompt: string;
  /** Said to the agent when it connects to Open Sourcebook's tools. */
  instructions: string;
  tools: WorkTool<Work>[];
  work: Work;
  signal?: AbortSignal;
  /** Shows a step on the item; it throws once the job was stopped or taken over. */
  step(label: string): Promise<void>;
  /** Touches the job while nothing else happens, so a Stop is seen; it throws like `step`. */
  heartbeat(): Promise<void>;
  /** An earlier turn of the same work (a carry-on): stopped first, so two turns never write at once. */
  replaces?: string;
  /** What the turn is for, recorded in the connector's usage log. */
  target?: { type: string; id: string };
  /** The agent, model and effort the item picked; the engine's own (ITEM_AGENT_MODEL, ITEM_AGENT_EFFORT) below it. */
  pick?: TurnPick;
}

export interface AgentWorkOptions {
  /** How often the job is touched and the connector asked about the turn. */
  pollMs?: number;
  /** Reads in a row the connector may miss before it counts as gone. */
  maxMissedReads?: number;
  /** After the connector says the turn no longer runs, how long its end may take to arrive. */
  graceMs?: number;
  /**
   * Before Open Sourcebook calls a turn dropped or the connector gone, how long it still
   * waits for an end that may be on its way: the connector forgets a turn
   * before it has told Open Sourcebook how it ended, so "not running" can be heard while
   * the end is in flight. An end that arrives in this time always wins.
   */
  settleMs?: number;
  /** Longest one turn may run before Open Sourcebook stops it, counting only time awake; 0 for no limit. */
  maxMinutes?: number;
  /**
   * A gap between two looks this much longer than `pollMs` (and at least a
   * minute) means the computer slept: the gap is not counted against the
   * turn, and the connector is asked again before anything is called gone.
   */
  sleptAfterMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/**
 * A turn waiting on its tool calls and its end, by turn id, for the routes.
 * Plain data only: a call arrives in the connector's request, but it is run
 * in the job's own request, which owns the job's database and connections
 * (the runtime refuses I/O across requests). The route leaves the call here
 * and waits for its answer; the job takes it, runs it and leaves the answer.
 */
interface Live {
  tokenHash: string;
  inbox: Array<{ id: number; name: string; input: unknown }>;
  answers: Map<number, WorkAnswer>;
  next: number;
  report?: Omit<WorkEnd, "durationMs"> & { durationMs?: number };
}

const LIVE = new Map<string, Live>();

/** How often a waiting route looks for its answer, and the job for calls. */
const TICK_MS = 25;
/** Longest a tool call waits for its answer before the agent hears to try again. */
const CALL_WAIT_MS = 110_000;

export class WorkTurnError extends Error {}

/** The person's agent doing pieces of work, through the connector this engine is set up with. */
export class AgentWork {
  readonly connector: ConnectorClient;

  constructor(
    readonly config: AgentConfig,
    fetchImpl: FetchLike,
    private readonly options: AgentWorkOptions = {},
  ) {
    this.connector = new ConnectorClient(config, fetchImpl);
  }

  /** The agent this engine names for the connector; the connector's own when absent. */
  get agent(): string {
    return this.config.agent ?? "agent";
  }

  /** What the connector reports now, remembered for the makers' checks before Start. */
  async status(): Promise<AgentStatus> {
    const status = await this.connector.status();
    rememberAgentStatus(this.config.url, status);
    return status;
  }

  /**
   * The cheapest honest check of whether the agent's plan is free again: the
   * connector's status when it knows (a remembered limit, with its reset);
   * otherwise its smallest turn. Never more than that.
   */
  async check(): Promise<AgentCheck> {
    const status = await this.status();
    if (!status.reachable) return {};
    const id = this.config.agent ?? status.agent?.id;
    const known = status.agent?.limit;
    if (known?.resetsAt && Date.parse(known.resetsAt) > Date.now()) return { free: false, limit: heardOf(known) };
    if (!id) return {};
    const probed = await this.connector.probe(id);
    if (!probed) return known ? { free: false, limit: heardOf(known) } : {};
    if (probed.ok) return { free: true };
    return probed.problem === "agentLimit" ? { free: false, limit: probed.limit } : {};
  }

  /** What the connector last reported, without asking; undefined before anything was heard. */
  heard(): AgentStatus | undefined {
    return cachedAgentStatus(this.config.url);
  }

  /**
   * Runs one turn of the agent on a piece of work and answers how it ended.
   * Tool calls run one at a time, each shown first as a step. A Stop (the
   * signal, or a step that throws) stops the agent and is thrown.
   */
  async run<Work>(spec: WorkSpec<Work>): Promise<WorkEnd> {
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const started = now();
    const base = (this.config.callbackUrl ?? engineOrigin() ?? "").replace(/\/$/, "");
    if (!base) return { outcome: "failed", problem: "error", text: "No address for the connector to call back on.", durationMs: 0 };

    const token = randomToken();
    const live: Live = { tokenHash: await sha256(token), inbox: [], answers: new Map(), next: 1 };
    LIVE.set(spec.turnId, live);
    const tools = new Map(spec.tools.map((tool) => [tool.name, tool]));
    let stopping: unknown;
    // Calls of Open Sourcebook's tools in this turn: none, with an error at its end, is an agent that failed before any work.
    let toolCalls = 0;
    const answer = async (name: string, input: unknown): Promise<WorkAnswer> => {
      toolCalls += 1;
      const tool = tools.get(name);
      if (!tool) return { text: `There is no tool "${name}".`, isError: true };
      const args = isRecord(input) ? input : {};
      let label: string;
      try {
        label = tool.label(args, spec.work);
      } catch {
        label = name.replace(/_/g, " ");
      }
      try {
        await spec.step(label);
      } catch (error) {
        stopping = error;
        return { text: "The person stopped this; stop now.", isError: true };
      }
      try {
        return await tool.run(args, spec.work);
      } catch (error) {
        console.warn(`Work tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        return { text: "Open Sourcebook could not do that just now. Try once more.", isError: true };
      }
    };
    const ended = (agent?: string): WorkEnd | undefined =>
      live.report ? { ...live.report, durationMs: live.report.durationMs ?? now() - started, ...(agent ? { agent } : {}), toolCalls } : undefined;

    try {
      // A carry-on: the turn it replaces may still run (the engine restarted under it); it stops first.
      if (spec.replaces) await this.connector.stop(spec.replaces);
      const answered = await this.connector.start({
        turnId: spec.turnId,
        systemPrompt: spec.systemPrompt,
        prompt: spec.prompt,
        instructions: spec.instructions,
        tools: spec.tools.map((tool): ToolListing => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        callback: { url: `${base}/v1/work-turns/${encodeURIComponent(spec.turnId)}`, token },
        timeoutMs: 0,
        ...(spec.target ? { target: spec.target } : {}),
      }, spec.pick ?? {});
      if (!("ok" in answered)) return { outcome: "failed", problem: answered.problem, ...(answered.detail ? { text: answered.detail } : {}), ...(answered.limit ? { limit: answered.limit } : {}), durationMs: now() - started };
      const agent = answered.agent;

      const pollMs = this.options.pollMs ?? 5_000;
      const maxMissed = this.options.maxMissedReads ?? 4;
      const graceMs = this.options.graceMs ?? 15_000;
      let deadline = (this.options.maxMinutes ?? 60) > 0 ? started + (this.options.maxMinutes ?? 60) * 60_000 : Number.POSITIVE_INFINITY;
      const sleptAfter = this.options.sleptAfterMs ?? Math.max(60_000, pollMs * 10);
      const settleMs = this.options.settleMs ?? 3_000;
      /** Waits for an end that may be in flight; the end if one lands, else undefined. */
      const settle = async (): Promise<WorkEnd | "alive" | undefined> => {
        for (const until = now() + settleMs; ; ) {
          if (live.inbox.length > 0) return "alive";
          const end = ended(agent);
          if (end) return end;
          if (now() >= until) return undefined;
          await sleep(TICK_MS);
        }
      };
      let missed = 0;
      let goneAt: number | undefined;
      let lastLook = now();
      // From the turn's start: a sleep while it was being handed over counts as one too.
      let lastTick = started;
      for (;;) {
        const gap = now() - lastTick;
        lastTick = now();
        if (gap > sleptAfter) {
          // The computer slept: the gap is not the turn's, and nothing heard before it counts.
          deadline += gap;
          missed = 0;
          goneAt = undefined;
        }
        // The calls that arrived, one at a time, in this job's own request.
        while (live.inbox.length > 0 && !stopping && !spec.signal?.aborted) {
          const call = live.inbox.shift()!;
          live.answers.set(call.id, await answer(call.name, call.input));
        }
        const end = ended(agent);
        if (end) return end;
        if (stopping || spec.signal?.aborted) {
          await this.connector.stop(spec.turnId);
          throw stopping ?? spec.signal?.reason ?? new WorkTurnError("stopped");
        }
        if (now() > deadline) {
          await this.connector.stop(spec.turnId);
          return { outcome: "failed", problem: "timedOut", durationMs: now() - started, ...(agent ? { agent } : {}) };
        }
        await sleep(TICK_MS);
        if (now() - lastLook < pollMs || live.inbox.length > 0 || live.report) continue;
        lastLook = now();
        try {
          await spec.heartbeat();
        } catch (error) {
          stopping = error;
          continue;
        }
        const seen = await this.connector.turn(spec.turnId);
        if (live.report || live.inbox.length > 0) continue;
        if (!seen.reachable) {
          missed += 1;
          if (missed >= maxMissed) {
            const last = await settle();
            if (last === "alive") continue;
            return last ?? { outcome: "failed", problem: "agentUnreachable", text: "The connector on this computer stopped answering.", durationMs: now() - started, ...(agent ? { agent } : {}) };
          }
          continue;
        }
        missed = 0;
        if (seen.running === false) {
          goneAt ??= now();
          if (now() - goneAt >= graceMs) {
            const last = await settle();
            if (last === "alive") {
              goneAt = undefined;
              continue;
            }
            return last ?? { outcome: "failed", problem: "dropped", text: "The connector no longer runs this turn and never said how it ended.", durationMs: now() - started, ...(agent ? { agent } : {}) };
          }
        } else goneAt = undefined;
      }
    } finally {
      // Calls still waiting hear the turn is over.
      for (const call of live.inbox.splice(0)) live.answers.set(call.id, { text: "This piece of work is over; stop now.", isError: true });
      LIVE.delete(spec.turnId);
    }
  }
}

/** One tool call of a running piece of work, from the connector: left for the job, and its answer waited for. A wrong token or an unknown turn: 404. */
export async function callWorkTool(turnId: string, token: string, name: string, input: unknown): Promise<{ status: number; text: string; isError: boolean }> {
  const live = await authorized(turnId, token);
  if (!live) return { status: 404, text: "No such turn.", isError: true };
  const id = live.next++;
  live.inbox.push({ id, name, input });
  for (let waited = 0; waited < CALL_WAIT_MS; waited += TICK_MS) {
    const answer = live.answers.get(id);
    if (answer) {
      live.answers.delete(id);
      return { status: 200, text: answer.text, isError: Boolean(answer.isError) };
    }
    if (LIVE.get(turnId) !== live) return { status: 200, text: "This piece of work is over; stop now.", isError: true };
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  return { status: 200, text: "Open Sourcebook took too long to answer that. Try once more.", isError: true };
}

/** The end of a running piece of work, as the connector reports it. */
export async function finishWork(turnId: string, token: string, end: Omit<WorkEnd, "durationMs"> & { durationMs?: number }): Promise<{ status: number }> {
  const live = await authorized(turnId, token);
  if (!live) return { status: 404 };
  live.report ??= end;
  return { status: 200 };
}

async function authorized(turnId: string, token: string): Promise<Live | undefined> {
  const live = LIVE.get(turnId);
  if (!live || !token) return undefined;
  return (await sha256(token)) === live.tokenHash ? live : undefined;
}

/*
 * Where the connector calls the engine back. A chat turn uses the origin of
 * the request that asked for it; a job runs outside any request, so the
 * engine keeps the origin it was last reached on (on this computer only).
 */
let origin: string | undefined;

export function rememberEngineOrigin(url: string): void {
  try {
    const parsed = new URL(url);
    if (["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) origin = parsed.origin;
  } catch {
    // Not a URL: nothing to remember.
  }
}

export function engineOrigin(): string | undefined {
  return origin;
}

/*
 * What the connector last said, by its address, so the makers' checks
 * before Start (which never call out) can say whether the agent is there.
 */
const heardStatus = new Map<string, { at: number; status: AgentStatus }>();

export function rememberAgentStatus(url: string, status: AgentStatus, at: number = Date.now()): void {
  heardStatus.set(url, { at, status });
}

export function cachedAgentStatus(url: string): AgentStatus | undefined {
  return heardStatus.get(url)?.status;
}

/** Asks the connector again when the last answer is older than `maxAgeMs`. */
export async function refreshAgentStatus(work: AgentWork, maxAgeMs = 5_000, now: number = Date.now()): Promise<void> {
  const last = heardStatus.get(work.config.url);
  if (last && now - last.at < maxAgeMs) return;
  // Remembered first, so requests arriving meanwhile do not ask again.
  heardStatus.set(work.config.url, { at: now, status: last?.status ?? { reachable: false } });
  await work.status().catch(() => undefined);
}

/** Forgets what was heard (tests). */
export function forgetAgentStatus(): void {
  heardStatus.clear();
}

/** Whether the agent can take work, from what was heard: a reason in a clause when it cannot, undefined when it can or nothing was heard. */
export function agentProblemHeard(status: AgentStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (!status.reachable) return "the connector on this computer isn't running";
  if (status.agent && !status.agent.installed) return "it doesn't look installed";
  if (status.agent?.signedIn === false) return "it isn't signed in";
  return undefined;
}

/**
 * How a turn that did not finish its work ended, as what the job does next
 * (jobs/failure-words.ts says it to the person). A turn cut off (the
 * connector restarted, the turn was dropped or the connector went quiet)
 * waits and is carried on from what it wrote; one stopped by the agent's
 * plan limit waits for the plan; an agent that ended in an error of its own
 * before calling any of Open Sourcebook's tools did no work, so trying again as a dropped
 * turn would meet the same error: it fails as that, with its own words, as
 * a video's agent does (`agentErrorFailure`); anything else fails.
 */
export function workFailure(end: WorkEnd, thing: string): JobFailure | JobWait {
  const code: JobFailureCode = WORK_FAILURE_CODES[end.problem ?? "error"] ?? "agent_dropped";
  const said = end.text ? ` ${end.text.slice(0, 300)}` : "";
  const message = `The agent's turn on this ${thing} ended as ${end.problem ?? end.outcome}.${said}`;
  if (end.problem === "agentLimit") return new JobWait(message, "agent_limit", code, end.limit ?? {});
  if ((end.problem === "error" || end.problem === undefined) && end.toolCalls === 0) {
    return agentErrorFailure(`The agent's turn on this ${thing} failed before any tool call${end.said ? `: ${end.said}` : "."}`, end.said);
  }
  if (end.problem === "dropped" || end.problem === "agentUnreachable" || end.problem === "error" || end.problem === undefined) return new JobWait(message, "restart", code);
  return new JobFailure(message, false, code);
}

function heardOf(limit: { resetsAt?: string; resets?: string }): HeardLimit {
  return { ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), ...(limit.resets ? { resets: limit.resets } : {}) };
}

const WORK_FAILURE_CODES: Record<NonNullable<WorkEnd["problem"]>, JobFailureCode> = {
  agentUnreachable: "agent_unreachable",
  agentMissing: "agent_missing",
  agentSignedOut: "agent_signed_out",
  agentLimit: "agent_limit",
  timedOut: "timed_out",
  stopped: "stopped",
  dropped: "agent_dropped",
  error: "agent_dropped",
};

/** One usage row for a turn of the person's agent, at cost 0: their own subscription paid for it. */
export async function recordWorkUsage(usage: UsageSink, jobId: string, end: WorkEnd, agent: string): Promise<void> {
  const id = end.agent ?? agent;
  await usage.record({
    provider: `agent:${id}`,
    model: end.model ?? id,
    task: "section",
    ...(end.tokensIn !== undefined ? { tokensIn: end.tokensIn } : {}),
    ...(end.tokensOut !== undefined ? { tokensOut: end.tokensOut } : {}),
    usd: 0,
    latencyMs: end.durationMs,
    ok: end.outcome === "done",
    jobId,
  });
}

/** A turn id for a job's n-th turn: the job's id with its number. */
export function workTurnId(jobId: string, n: number): string {
  return `${jobId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 80)}-w${n}`;
}

/** What a job keeps of how many turns it started, so each turn of a retry has a new id. */
export function nextTurnNumber(kept: JsonValue | undefined): number {
  return typeof kept === "number" && Number.isInteger(kept) && kept >= 0 ? kept + 1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
