/**
 * A chat turn answered by the person's own agent (engine/docs/api.md, "Your
 * agent"; DECISIONS #53). It is one more way a turn is answered: the chat
 * service stores the person's message as always, then hands the turn here
 * instead of answering it itself.
 *
 * The reply message is stored at once, running. The connector runs the
 * agent; each tool call comes back here, is checked against the turn's
 * token, recorded as a step ("Searching Lecture 7") and run in Open Sourcebook for this
 * chat only. When the agent ends (or is stopped, or runs out of time) the
 * steps' results become the reply's pieces through the piece registry, the
 * chat is released and a usage row records the agent at no cost to Open Sourcebook.
 */
import { isRecord } from "../../net";
import { projectPacks } from "../planning/guide";
import type { ConditionRegistry } from "../../studio/conditions";
import type { EdgeKindRegistry } from "../../studio/edge-kinds";
import type { FormatRegistry } from "../../studio/registry";
import type { AgentStep, AgentTurn, Message, Project, Session, StudioRepositories } from "../../studio/repositories";
import type { JsonValue } from "../../studio/types";
import type { EngineDeps } from "../../wiring";
import type { KnownSkill } from "../about-opensourcebook";
import { buildTurnContext } from "../context";
import { pieceKinds, say, type OtherPiece, type PlanPiece, type TextPiece } from "../pieces";
import { SourceMap } from "../planning/sources";
import type { ReplyContent, ReplyFailureReason } from "../service";
import { ConnectorClient, type AgentConfig, type AgentProblem, type AgentStatus, type TurnPick } from "./connector";
import { renderMade } from "../making/direct";
import { agentPrompt, agentSystemPrompt } from "./prompt";
import type { AgentRequest, AgentToolRegistry, StepNote, StepResult, ToolTurn, TurnSources } from "./tools";
import type { Cite } from "../../cards/contract";
import { markUnchecked } from "../blocks";
import { parsePartialJson } from "./partial-json";
import type { ThreadAbout } from "../threads";
import type { FetchLike } from "../../types";

/** A running turn with no word from the connector this long after its time ran out is ended as timed out. */
const GRACE_MS = 30_000;

export interface BeginTurn {
  repos: StudioRepositories;
  registry: FormatRegistry;
  conditions: ConditionRegistry;
  /** The kinds of link between plan items, named to the agent; the defaults when absent. */
  edgeKinds?: EdgeKindRegistry;
  skills: readonly KnownSkill[];
  ownerId: string;
  project: Project;
  chat: Session;
  history: Message[];
  request: AgentRequest;
  /** The engine's own origin, for the connector to call back. */
  origin?: string;
  /** The agent, model and effort the chat picked; the engine's settings when absent. */
  pick?: TurnPick;
}

/** What the connector reports when the agent stops. */
export interface TurnReport {
  outcome: "done" | "failed";
  problem?: AgentProblem;
  /** Words the agent ended with, when it never called `reply`. */
  text?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  /** With `agentLimit`: when the agent said its plan's limit resets, only if it said so. */
  limit?: { resetsAt?: string; resets?: string };
}

/** A step as the client sees it. */
export interface StepView {
  tool: string;
  label: string;
  state: AgentStep["state"];
  startedAt: string;
  endedAt?: string;
}

export class AgentChat {
  readonly connector: ConnectorClient;

  constructor(
    private readonly config: AgentConfig,
    private readonly tools: AgentToolRegistry,
    fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {
    this.connector = new ConnectorClient(config, fetchImpl);
  }

  /** The agent this engine names for the connector (CHAT_AGENT); undefined leaves it to the connector. */
  get configuredAgent(): string | undefined {
    return this.config.agent;
  }

  /** The agent id stored on turns: the configured one, or the connector's default. */
  get agent(): string {
    return this.config.agent ?? "agent";
  }

  status(options: { fresh?: boolean } = {}): Promise<AgentStatus> {
    return this.connector.status(options);
  }

  /**
   * Stores the running reply and hands the turn to the connector. Answers
   * the reply and whether it is still running; when it is not (the
   * connector could not take it), it already says why and the chat may be
   * released.
   */
  async begin(input: BeginTurn): Promise<{ reply: Message; running: boolean }> {
    const { repos } = input;
    const token = randomToken();
    const sent = this.connector.sentPick(input.pick);
    const agent = input.pick?.agent ?? this.agent;
    const about = input.request.thread?.about;
    const reply = await repos.sessions.append(input.chat.id, { role: "assistant", content: runningContent(agent, about) });
    const turn = await repos.agentTurns.create({
      sessionId: input.chat.id,
      messageId: reply.id,
      ownerId: input.ownerId,
      projectId: input.project.id,
      agent,
      tokenHash: await sha256(token),
      request: input.request as unknown as JsonValue,
      pick: { ...(sent.model ? { model: sent.model } : {}), ...(sent.effort ? { effort: sent.effort } : {}) },
    });
    const base = (this.config.callbackUrl ?? input.origin ?? "").replace(/\/$/, "");
    const ticked = stringList(input.chat.settings.sources);
    const started = base
      ? await this.connector.start({
          turnId: turn.id,
          systemPrompt: agentSystemPrompt(input.registry, input.conditions, input.skills, input.edgeKinds),
          prompt: agentPrompt({
            ...(input.project.title ? { projectTitle: input.project.title } : {}),
            packs: projectPacks(input.project.settings),
            sources: await repos.sources.listByProject(input.project.id),
            ticked: ticked ? new Set(ticked) : undefined,
            plans: (await repos.plans.listBySession(input.chat.id)).filter((plan) => !plan.direct),
            made: await renderMade(repos, input.registry, input.chat.id, input.request.opened),
            history: input.history,
            request: input.request,
          }),
          tools: this.tools.listing(),
          callback: { url: `${base}/v1/agent-turns/${turn.id}`, token },
          drafts: this.tools.list().flatMap((tool) => (tool.draft ? [tool.name] : [])),
          target: { type: "chat", id: input.chat.id },
        }, input.pick)
      : ({ problem: "error", detail: "No address for the connector to call back on." } as const);
    if ("ok" in started) {
      // The connector names the agent it runs when the engine left the choice to it.
      if (started.agent && started.agent !== turn.agent) {
        await repos.agentTurns.setAgent(turn.id, started.agent);
        return { reply: (await repos.sessions.updateContent(reply.id, runningContent(started.agent, about))) ?? reply, running: true };
      }
      return { reply, running: true };
    }
    if (started.detail) console.warn(`Agent turn ${turn.id} did not start: ${started.detail}`);
    await repos.agentTurns.finish(turn.id, "failed");
    const ended = await repos.sessions.updateContent(reply.id, contentOf(failed(started.problem, [], "limit" in started ? started.limit : undefined), [], this.tools, turn.agent, about));
    return { reply: ended ?? reply, running: false };
  }

  /** Runs one tool call of a running turn. A call with the wrong token, or for a turn that ended, does nothing. */
  async callTool(deps: EngineDeps, turnId: string, token: string, name: string, input: unknown): Promise<{ status: number; text: string; isError: boolean }> {
    const turn = await this.authorized(deps.repos, turnId, token);
    if (!turn) return { status: 404, text: "No such turn.", isError: true };
    if (turn.state !== "running") return { status: 409, text: "This turn is over; stop now.", isError: true };
    const tool = this.tools.get(name);
    if (!tool) return { status: 200, text: `There is no tool "${name}".`, isError: true };
    const args = isRecord(input) ? input : {};
    const scope = await this.toolTurn(deps, turn);
    if (!scope) return { status: 409, text: "This chat is gone.", isError: true };
    let label: string;
    try {
      label = await tool.label(args, scope);
    } catch {
      label = name.replace(/_/g, " ");
    }
    const step = await deps.repos.agentTurns.addStep(turn.id, { tool: name, label });
    try {
      const outcome = await tool.run(args, scope);
      // A turn stopped while the tool ran keeps what the tool did, but the agent hears it is over.
      // What the call did is kept beside its result, for the steps list.
      const result = outcome.result || outcome.note ? { ...(outcome.result ?? {}), ...(outcome.note ? { note: outcome.note } : {}) } : undefined;
      await deps.repos.agentTurns.endStep(step.id, outcome.isError ? "failed" : "done", result === undefined ? undefined : (result as unknown as JsonValue));
      const still = (await deps.repos.agentTurns.get(turn.id))?.state === "running";
      return { status: 200, text: still ? outcome.text : `${outcome.text}\n\nThe person stopped this turn; stop now.`, isError: Boolean(outcome.isError) || !still };
    } catch (error) {
      console.warn(`Agent tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      await deps.repos.agentTurns.endStep(step.id, "failed");
      return { status: 200, text: "Open Sourcebook could not do that just now. Try once more, or tell the person what failed.", isError: true };
    }
  }

  /**
   * What the agent has written so far of a call to a tool that shows while
   * it is written: read as far as it goes and kept on the turn, to be shown
   * after what earlier calls showed. `calls` is how many tool calls came
   * before it, so a draft that arrives after its call is never shown.
   */
  async draft(deps: EngineDeps, turnId: string, token: string, draft: { tool: string; input: string; calls: number }): Promise<{ status: number }> {
    const turn = await this.authorized(deps.repos, turnId, token);
    if (!turn) return { status: 404 };
    const tool = this.tools.get(draft.tool);
    if (turn.state !== "running" || !tool?.draft) return { status: 200 };
    const input = parsePartialJson(draft.input);
    if (!isRecord(input)) return { status: 200 };
    const scope = await this.toolTurn(deps, turn);
    if (!scope || scope.steps.length > draft.calls) return { status: 200 };
    try {
      const result = await tool.draft(input, scope);
      const label = await tool.label(input, scope);
      if (result) await deps.repos.agentTurns.setDraft(turn.id, { tool: draft.tool, calls: draft.calls, label, at: new Date(this.now()).toISOString(), result: result as unknown as JsonValue });
    } catch (error) {
      console.warn(`Agent draft of ${draft.tool} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: 200 };
  }

  /** Ends a running turn as the connector reports it. A turn already ended (stopped, timed out) stays as it is. */
  async finish(deps: EngineDeps, turnId: string, token: string, report: TurnReport): Promise<{ status: number }> {
    const turn = await this.authorized(deps.repos, turnId, token);
    if (!turn) return { status: 404 };
    const steps = await deps.repos.agentTurns.steps(turn.id);
    const ok = report.outcome === "done" || replyComplete(steps);
    if (!(await deps.repos.agentTurns.finish(turn.id, ok ? "done" : report.problem === "stopped" ? "stopped" : "failed"))) return { status: 200 };
    const content = ok ? assemble(steps, report.text) : failed(report.problem ?? "error", steps, report.limit);
    await this.close(deps.repos, turn, content, steps);
    await deps.repos.usage.record(
      { ownerId: turn.ownerId, projectId: turn.projectId, sessionId: turn.sessionId },
      {
        provider: `agent:${turn.agent}`,
        model: report.model ?? turn.agent,
        task: "chat",
        ...(report.tokensIn !== undefined ? { tokensIn: report.tokensIn } : {}),
        ...(report.tokensOut !== undefined ? { tokensOut: report.tokensOut } : {}),
        // The person's own subscription pays for it; Open Sourcebook spends nothing.
        usd: 0,
        latencyMs: report.durationMs ?? Date.parse(new Date(this.now()).toISOString()) - Date.parse(turn.startedAt),
        ok,
      },
    );
    return { status: 200 };
  }

  /** Stops the chat's running turn, keeping what its steps already did. False when nothing was running. */
  async stop(repos: StudioRepositories, chatId: string): Promise<boolean> {
    let stopped = false;
    for (const turn of await repos.agentTurns.running(chatId)) {
      if (!(await repos.agentTurns.finish(turn.id, "stopped"))) continue;
      stopped = true;
      const steps = await repos.agentTurns.steps(turn.id);
      // Stopped after the reply's last block was shown: the reply is whole.
      await this.close(repos, turn, replyComplete(steps) ? assemble(steps) : failed("stopped", steps), steps);
      await this.connector.stop(turn.id);
    }
    return stopped;
  }

  /** Ends turns of the chat that ran out of time with no word from the connector. */
  async sweep(repos: StudioRepositories, chatId: string): Promise<void> {
    const limit = this.config.timeoutMs + GRACE_MS;
    for (const turn of await repos.agentTurns.running(chatId)) {
      if (this.now() - Date.parse(turn.startedAt) < limit) continue;
      if (!(await repos.agentTurns.finish(turn.id, "failed"))) continue;
      const steps = await repos.agentTurns.steps(turn.id);
      await this.close(repos, turn, failed("timedOut", steps), steps);
      await this.connector.stop(turn.id);
    }
  }

  /**
   * Each running reply among `messages` as it stands, by message id: the
   * steps taken so far and the blocks the reply tool has shown, with their
   * cites, drawn as they will be once the turn ends.
   */
  async live(repos: StudioRepositories, messages: Message[]): Promise<Map<string, Record<string, JsonValue>>> {
    const out = new Map<string, Record<string, JsonValue>>();
    for (const message of messages) {
      if (!isRecord(message.content) || message.content.state !== "running") continue;
      const turn = await repos.agentTurns.byMessage(message.id);
      if (!turn) continue;
      const steps = await repos.agentTurns.steps(turn.id);
      const written = writtenSoFar(resultsOf(steps));
      // The call being written now, after what was shown. A draft is current while no call
      // has landed since it began, but for tries of the same tool that were sent back.
      const draft = await repos.agentTurns.draft(turn.id);
      const views = steps.map(stepView);
      if (isRecord(draft) && typeof draft.calls === "number" && isRecord(draft.result) && steps.slice(draft.calls).every((step) => step.tool === draft.tool && step.state === "failed")) {
        const result = draft.result as unknown as StepResult;
        written.pieces = [...written.pieces, ...(result.pieces ?? [])];
        if ((result.cites?.length ?? 0) >= written.cites.length) written.cites = result.cites ?? [];
        // The call being written is the step it is on, though it is no step yet.
        if (typeof draft.label === "string") views.push({ tool: String(draft.tool), label: draft.label, state: "running", startedAt: String(draft.at ?? turn.startedAt) });
      }
      out.set(message.id, {
        steps: views as unknown as JsonValue,
        ...(written.pieces.length ? { pieces: written.pieces as unknown as JsonValue, text: pieceKinds.replyText(written.pieces) } : {}),
        ...(written.cites.length ? { cites: written.cites as unknown as JsonValue } : {}),
      });
    }
    return out;
  }

  private async close(repos: StudioRepositories, turn: AgentTurn, content: ReplyContent, steps: AgentStep[]): Promise<void> {
    await repos.sessions.updateContent(turn.messageId, contentOf(content, steps, this.tools, turn.agent, (turn.request as unknown as AgentRequest | null)?.thread?.about));
    await repos.sessions.releaseTurn(turn.sessionId);
  }

  private async authorized(repos: StudioRepositories, turnId: string, token: string): Promise<AgentTurn | undefined> {
    const turn = await repos.agentTurns.get(turnId);
    if (!turn || !token) return undefined;
    return (await sha256(token)) === turn.tokenHash ? turn : undefined;
  }

  private async toolTurn(deps: EngineDeps, turn: AgentTurn): Promise<ToolTurn | undefined> {
    const chat = await deps.repos.sessions.get(turn.sessionId);
    const project = chat?.projectId ? await deps.repos.projects.get(chat.projectId) : undefined;
    if (!chat || !project) return undefined;
    let sources: Promise<TurnSources> | undefined;
    return {
      turn,
      project,
      chat,
      request: turn.request as unknown as AgentRequest,
      deps,
      steps: await deps.repos.agentTurns.steps(turn.id),
      sources: () => (sources ??= turnSources(deps.repos, project, chat)),
    };
  }
}

/**
 * Every readable source of the project under a label that does not move
 * when a source is ticked (S1 is the first readable source in project
 * order), and the ticked ones: the chat's ticks, or all when it has none.
 */
async function turnSources(repos: StudioRepositories, project: Project, chat: Session): Promise<TurnSources> {
  const projectSources = await repos.sources.listByProject(project.id);
  const context = await buildTurnContext(repos, project, chat, { mentions: [], sources: projectSources.map((source) => source.id) });
  const map = new SourceMap(context.sources);
  const chosen = stringList(chat.settings.sources);
  const ticked = new Set(chosen ?? projectSources.map((source) => source.id));
  const inScope = (entry: { source: { sourceId: string } }) => ticked.has(entry.source.sourceId);
  let passages: ReturnType<TurnSources["passages"]> | undefined;
  return {
    map,
    ticked,
    unread: context.unread,
    projectSources,
    inScope,
    passages() {
      // Numbered like the outline and plan sources: passage n is the source's nth stored passage.
      passages ??= map.entries.filter(inScope).flatMap((entry) =>
        entry.chunks.flatMap((chunk, index) =>
          chunk.text.trim()
            ? [
                {
                  id: chunk.id,
                  label: `${entry.label}#${index + 1}`,
                  sourceId: entry.source.sourceId,
                  ...(entry.source.title ? { sourceTitle: entry.source.title } : {}),
                  chunkId: chunk.id,
                  ...(chunk.locator ? { locator: chunk.locator } : {}),
                  text: chunk.text,
                },
              ]
            : [],
        ),
      );
      return passages;
    },
  };
}

/**
 * The reply from the steps: the reply's own words first, then what other
 * steps added (a plan card once per plan, questions) in the order they ran,
 * then the reply's closing words. With no reply step, the agent's last
 * words stand in, marked as not checked against the sources.
 */
export function assemble(steps: AgentStep[], lastWords?: string): ReplyContent {
  const results = resultsOf(steps);
  const written = writtenSoFar(results);
  const lead: OtherPiece[] = written.pieces.length ? written.pieces : lastWords?.trim() ? [{ ...say(lastWords.trim()), unchecked: true } as TextPiece] : [];
  const pieces = [...lead, ...madePieces(results), ...written.after];
  if (pieces.length === 0) return failed("error", steps);
  return {
    pieces: pieces as ReplyContent["pieces"],
    ...(written.cites.length ? { cites: written.cites } : {}),
    ...(written.covered !== undefined ? { covered: written.covered } : {}),
  };
}

/**
 * The reply's own blocks so far: every call of the reply tool that was
 * shown, in order, each adding its blocks after the ones before. Their
 * cites are the last call's (each call keeps the earlier ones at their
 * indexes). A reply that read the sources and in the end cites none shows
 * every block as not checked.
 */
function writtenSoFar(results: StepResult[]): { pieces: OtherPiece[]; cites: Cite[]; after: OtherPiece[]; covered?: boolean } {
  const calls = results.filter((result) => result.final);
  const pieces = calls.flatMap((call) => call.pieces ?? []);
  const covered = calls.map((call) => call.covered).filter((value) => value !== undefined).at(-1);
  return {
    pieces: calls.some((call) => call.uncited) ? markUnchecked(pieces) : pieces,
    cites: calls.at(-1)?.cites ?? [],
    after: calls.flatMap((call) => call.after ?? []),
    ...(covered !== undefined ? { covered } : {}),
  };
}

/** Whether the reply tool showed the reply's last call: one with nothing more to come. */
function replyComplete(steps: AgentStep[]): boolean {
  const last = resultsOf(steps)
    .filter((result) => result.final)
    .at(-1);
  return last !== undefined && last.more !== true;
}

function resultsOf(steps: AgentStep[]): StepResult[] {
  return steps.filter((step) => step.state === "done" && isRecord(step.result)).map((step) => step.result as unknown as StepResult);
}

/** What steps other than the reply added, in order: a plan card once per plan (its changes gathered), questions. */
function madePieces(results: StepResult[]): OtherPiece[] {
  const body: OtherPiece[] = [];
  for (const result of results) {
    if (result.final) continue;
    for (const piece of result.pieces ?? []) {
      if (piece.kind !== "plan") {
        body.push(piece);
        continue;
      }
      const plan = piece as PlanPiece;
      const earlier = body.find((known): known is PlanPiece => known.kind === "plan" && (known as PlanPiece).planId === plan.planId);
      if (!earlier) body.push({ ...plan, ...(plan.changes ? { changes: [...plan.changes] } : {}) });
      else if (earlier.action === "edited") earlier.changes = [...new Set([...(earlier.changes ?? []), ...(plan.changes ?? [])])];
    }
  }
  return body;
}

const PROBLEM_WORDS: Record<AgentProblem, string> = {
  agentUnreachable: "Open Sourcebook couldn't reach your agent: the connector on your computer isn't running.",
  agentMissing: "Open Sourcebook couldn't find your agent on your computer: it doesn't look installed.",
  agentSignedOut: "Your agent isn't signed in on your computer.",
  agentLimit: "Your agent's plan has reached its limit for now. Ask again once it is available again.",
  timedOut: "Your agent took too long, so Open Sourcebook stopped it.",
  stopped: "You stopped this reply.",
  error: "Your agent couldn't finish this reply.",
};

/**
 * A turn that ended before its reply did: the blocks it had shown (cut
 * short, and saying so), why, in words marked `failure` and as `failed`,
 * then what its steps made.
 */
function failed(problem: AgentProblem, steps: AgentStep[], limit?: { resets?: string }): ReplyContent {
  const results = resultsOf(steps);
  const written = writtenSoFar(results);
  // Plan cards the steps made before the turn ended exist, so they show; unanswered questions do not.
  const made = madePieces(results).filter((piece) => piece.kind === "plan");
  // Only what the agent itself said about when its limit resets.
  const why = problem === "agentLimit" && limit?.resets ? `${PROBLEM_WORDS[problem]} It said it resets ${limit.resets}.` : PROBLEM_WORDS[problem];
  const words = written.pieces.length ? `${why} The reply above is cut short.` : why;
  return {
    pieces: [...written.pieces, { ...say(words), failure: true }, ...made] as ReplyContent["pieces"],
    ...(written.cites.length ? { cites: written.cites } : {}),
    failed: { reason: problem as ReplyFailureReason, ...(written.pieces.length ? { cutShort: true } : {}) },
  };
}

/** A reply being written; a reply in a thread carries what it is about from the start, so the thread shows it while it runs. */
function runningContent(agent: string, about?: ThreadAbout): JsonValue {
  return { text: "", pieces: [], state: "running", agent, ...(about ? { about: about as unknown as JsonValue } : {}) };
}

/** A reply's stored content: its pieces, its plain text from the piece registry, and the steps behind it, also said in fewer lines. */
function contentOf(content: ReplyContent, steps: AgentStep[], tools: AgentToolRegistry, agent?: string, about?: ThreadAbout): JsonValue {
  return {
    text: pieceKinds.replyText(content.pieces),
    ...(content as unknown as Record<string, JsonValue>),
    ...(agent ? { agent } : {}),
    ...(about ? { about: about as unknown as JsonValue } : {}),
    ...(steps.length ? { steps: steps.map(stepView) as unknown as JsonValue, stepLines: stepLines(steps, tools) as unknown as JsonValue } : {}),
  };
}

function stepView(step: AgentStep): StepView {
  return { tool: step.tool, label: step.label, state: step.state, startedAt: step.startedAt, ...(step.endedAt ? { endedAt: step.endedAt } : {}) };
}

/** One line of the steps list: steps in a row that did the same kind of thing, said once in the past. */
export interface StepLine {
  text: string;
  /** How many steps the line stands for. */
  steps: number;
  /** Failed when every step it stands for failed. */
  state: "done" | "failed";
}

/**
 * The steps said in fewer lines: steps in a row of one tool whose notes
 * share a group are one line, in the tool's own past-tense words
 * ("Read 9 passages of Lecture 7"). A tool with no words of its own shows
 * the label the person saw while it ran, once for a run of the same label.
 */
export function stepLines(steps: AgentStep[], tools: AgentToolRegistry): StepLine[] {
  const runs: Array<{ tool: string; key: string; steps: AgentStep[] }> = [];
  for (const step of steps) {
    const note = noteOf(step);
    const key = typeof note.group === "string" ? note.group : step.label;
    const last = runs.at(-1);
    if (last && last.tool === step.tool && last.key === key) last.steps.push(step);
    else runs.push({ tool: step.tool, key, steps: [step] });
  }
  return runs.map((run) => {
    const tool = tools.get(run.tool);
    const entries = run.steps.map((step) => ({ note: noteOf(step), failed: step.state === "failed", label: step.label }));
    let text = run.steps[0]!.label;
    if (tool?.said) {
      try {
        text = tool.said(entries);
      } catch {
        // The label stands in.
      }
    }
    return { text, steps: run.steps.length, state: entries.every((entry) => entry.failed) ? "failed" : "done" };
  });
}

function noteOf(step: AgentStep): StepNote {
  return isRecord(step.result) && isRecord(step.result.note) ? (step.result.note as StepNote) : {};
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
