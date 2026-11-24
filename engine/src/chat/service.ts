/**
 * One chat turn (engine/docs/api.md, "Chats"): store the person's message,
 * decide whether to answer or use a skill, write the reply, store it. The
 * chat core knows skills only through `SkillRegistry`.
 *
 * Every call reports to the usage log with the chat and project, through
 * the budget guard when the turn has a budget.
 */
import { accountProblem, accountRefusal, isRecord } from "../net";
import type { AgentProblem } from "./agent/connector";
import type { AgentChat } from "./agent/turn";
import { BudgetExceededError, BudgetGuard } from "../providers/budget";
import type { ConditionRegistry } from "../studio/conditions";
import type { PlanRunner } from "../studio/plan-runner";
import type { FormatRegistry } from "../studio/registry";
import type { Mention, Message, Project, Session, StudioRepositories, UsageTotals } from "../studio/repositories";
import { chatTimingKey } from "../studio/timing";
import type { JsonValue } from "../studio/types";
import type { StructuredProvider, UsageEvent, UsageSink } from "../types/provider";
import { answerFromSources, type AnswerOptions } from "./answer";
import { buildTurnContext, renderHistory } from "./context";
import { checkPicks, pieceKinds, say, type OtherPiece, type Picks } from "./pieces";
import { parsePick, PickNeededError, pickId, providerViews, resolvePick, type Pick, type ProviderView } from "./providers";
import { routeTurn } from "./router";
import type { ChatSkill, SkillRegistry, SkillReply } from "./skills";
import type { KnownSkill } from "./about-opensourcebook";
import type { ThreadAbout } from "./threads";

export class ChatUnavailableError extends Error {
  constructor() {
    super("No model provider is configured on this Worker.");
    this.name = "ChatUnavailableError";
  }
}

export class ChatBusyError extends Error {
  constructor(readonly chatId: string) {
    super(`A reply is being written in chat ${chatId}.`);
    this.name = "ChatBusyError";
  }
}

/** The chat picked who answers and that one can't (not set up here, or turned off), or no provider is turned on. */
export class AnswererUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswererUnavailableError";
  }
}

/** The picks do not fit the reply they answer. */
export class InvalidAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnswerError";
  }
}

export interface ChatServiceOptions {
  repos: StudioRepositories;
  registry: FormatRegistry;
  skills: SkillRegistry;
  conditions: ConditionRegistry;
  plans?: PlanRunner;
  /** A provider whose every call reports to `usage`; undefined when no key is set. */
  provider(usage: UsageSink): StructuredProvider | undefined;
  now?: () => number;
  answer?: AnswerOptions;
  /**
   * The person's own agent (DECISIONS #53): when set, every turn is handed
   * to it instead of being answered here, and no model provider is needed.
   */
  agent?: AgentChat;
  /** Optional provider of default agent/model/effort for long work turns (such as videos). */
  workDefault?: () => Promise<{ agent?: string; model?: string; effort?: string } | undefined>;
}

export interface TurnInput {
  text: string;
  mentions: Mention[];
  sources?: string[];
  /** A skill the person forced by id. */
  skill?: ChatSkill;
  /** Options picked in questions of an earlier reply of this chat. */
  answer?: Picks;
  budgetUsd?: number;
  /** The engine's own origin, for an agent's connector to call back on. */
  origin?: string;
  /** Who answers, picked in the chat (a provider pick); kept on the chat. */
  answerer?: string;
  /** How hard it thinks, picked in the chat (an effort the provider lists); kept on the chat. */
  effort?: string;
  /** Where the person wrote from: the `opensourcebook` command in a terminal, when not the app. */
  from?: "terminal";
  /** The item open in front of the person as they wrote (the Studio's player), for a follow-up about it. */
  opened?: string;
  /** The person's day, YYYY-MM-DD, from their app. */
  today?: string;
  /** Written in the thread on a made thing (threads.ts): what it is about, kept on the message and its reply, and the facts of that spot for the turn. */
  thread?: { about: ThreadAbout; facts: string };
}

/**
 * Why a reply could not be written (engine/docs/api.md, "Message"):
 * `outOfCredit` and `keyRefused` when the model account refused the call,
 * `budget` when the turn reached its `budgetUsd`, `error` for anything else.
 */
export type ReplyFailureReason = "outOfCredit" | "keyRefused" | "budget" | "error" | AgentProblem;

export interface ReplyFailure {
  reason: ReplyFailureReason;
  /** The budget the turn reached, when `reason` is `budget`. */
  budgetUsd?: number;
  /** The person's agent had shown part of its reply before it ended: those blocks stay, cut short. */
  cutShort?: boolean;
}

export type ReplyContent = SkillReply & {
  skill?: string;
  /** Set only on a reply the engine could not write; its pieces say so in words. */
  failed?: ReplyFailure;
};

export interface TurnResult {
  user: Message;
  reply: Message;
  replyContent: ReplyContent;
  /** The reply is still being written by the person's agent; its content says so and fills in when the turn ends. */
  running?: boolean;
}

/** A turn marked busy longer than this died with its Worker; the next turn takes over. */
export const STALE_TURN_MS = 5 * 60_000;
const HISTORY_MESSAGES = 20;
const ROUTER_HISTORY_CHARS = 3_000;

export class ChatService {
  private readonly now: () => number;

  constructor(private readonly options: ChatServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get skills(): SkillRegistry {
    return this.options.skills;
  }

  /** The person's own agent, when turns go to it. */
  get agent(): AgentChat | undefined {
    return this.options.agent;
  }

  /**
   * The person's providers with their settings over them, for Settings and
   * the chat's picker. Empty, and not reachable, when no connector is set up
   * or it can't be reached. `fresh` has the connector check each agent
   * again (Settings' refresh) instead of answering from its last check.
   */
  async providers(ownerId: string, options: { fresh?: boolean } = {}): Promise<{ configured: boolean; reachable: boolean; checkedAt?: string; providers: ProviderView[] }> {
    const agent = this.options.agent;
    if (!agent) return { configured: false, reachable: false, providers: [] };
    const status = await agent.status(options);
    const checkedAt = new Date(this.now()).toISOString();
    const work = this.options.workDefault ? await this.options.workDefault() : undefined;
    // "Default" on a provider is only the chat's pick from Settings.
    const chat = await this.options.repos.providerSettings.getPick(ownerId, "chat");
    const asked = chat?.agent ? { agent: chat.agent, ...(chat.model ? { model: chat.model } : {}), ...(chat.effort ? { effort: chat.effort } : {}) } : undefined;
    // Its model and effort are the ones a chat turn on it is sent with and its time is kept under (chatTimingKey).
    const picked = asked ? chatPickAsKept(chatTimingKey(agent.connector.sentPick(asked), status)) : undefined;
    return { configured: true, reachable: status.reachable, checkedAt, providers: providerViews(status, await this.options.repos.providerSettings.list(ownerId), work, picked) };
  }

  /**
   * Who answers a turn: the chat's pick, else the chat's default from
   * Settings (the "chat" pick), else the agent the person named for this
   * engine or the connector (CHAT_AGENT, OPENSOURCEBOOK_AGENT), else the only provider
   * that is on and ready; with several, the person is asked
   * (`PickNeededError`, 409 pick_needed). Never Open Sourcebook's own model
   * while a connector is set up (DECISIONS #62). Refuses a pick of a
   * provider turned off or removed from the list, and a turn when none can
   * answer. The chat's effort rides along with whoever answers. Undefined
   * when no connector is set up: Open Sourcebook's own model answers then (the engine
   * on its own, for working on it).
   */
  async answering(ownerId: string, picked: string | undefined, effort?: string): Promise<Pick | undefined> {
    // A chat that never picked reads the chat's default from Settings (the "chat" pick) each turn, so changing it changes every such chat.
    const remembered = picked === undefined || effort === undefined ? await this.options.repos.providerSettings.getPick(ownerId, "chat") : undefined;
    const fromDefault = picked === undefined && remembered?.agent ? pickId({ agent: remembered.agent, ...(remembered.model ? { model: remembered.model } : {}) }) : undefined;
    let chosen: Pick | undefined;
    try {
      chosen = await this.chooseAnswerer(ownerId, picked ?? fromDefault);
    } catch (error) {
      // A default whose provider is now off or gone is passed over, as if nothing were picked.
      if (!fromDefault || !(error instanceof AnswererUnavailableError)) throw error;
      chosen = await this.chooseAnswerer(ownerId, undefined);
    }
    // The default's effort rides along only with the agent it was picked for (#91).
    const ownEffort = effort ?? (remembered?.effort && (!remembered.agent || chosen?.agent === remembered.agent) ? remembered.effort : undefined);
    return chosen && ownEffort ? { ...chosen, effort: ownEffort } : chosen;
  }

  /**
   * Who answers a turn that makes one thing of `format` at once: the answerer as `answering` has it, after the
   * format's own maker is checked. When a pick is needed, the shape's maker is named first, then the chat when it has
   * no pick either; a turn that makes nothing needs only the chat's.
   */
  private async answeringFor(ownerId: string, picked: string | undefined, effort: string | undefined, format: string | undefined): Promise<Pick | undefined> {
    let chatNeeds: PickNeededError | undefined;
    let pick: Pick | undefined;
    try {
      pick = await this.answering(ownerId, picked, effort);
    } catch (error) {
      if (!(error instanceof PickNeededError)) throw error;
      chatNeeds = error;
    }
    if (format && this.options.plans) {
      try {
        await this.options.plans.checkPickFor(ownerId, format);
      } catch (error) {
        if (!(error instanceof PickNeededError)) throw error;
        throw new PickNeededError(error.scope, [...error.scopes.slice(1), ...(chatNeeds?.scopes ?? [])]);
      }
    }
    if (chatNeeds) throw chatNeeds;
    return pick;
  }

  private async chooseAnswerer(ownerId: string, picked: string | undefined): Promise<Pick | undefined> {
    const agent = this.options.agent;
    const pick = picked === undefined ? undefined : parsePick(picked);
    if (picked !== undefined && !pick) throw new AnswererUnavailableError(`"${picked}" is not a provider pick (GET /v1/providers lists them)`);
    if (!agent) {
      if (pick) throw new AnswererUnavailableError("Your own agent isn't connected to this engine.");
      return undefined;
    }
    const settings = await this.options.repos.providerSettings.list(ownerId);
    const off = new Set(settings.filter((setting) => !setting.enabled || setting.added === false).map((setting) => setting.providerId));
    const chosen = pick?.agent ?? (pick ? agent.configuredAgent : undefined);
    if (chosen && off.has(chosen)) throw new AnswererUnavailableError("That provider is turned off or not in your list. Turn it on in Settings, under Providers.");
    // "agent" alone is the engine's own agent (CHAT_AGENT); with none named here it is decided below, as nothing picked.
    if (pick && (pick.agent || agent.configuredAgent)) return pick;
    if (agent.configuredAgent && !off.has(agent.configuredAgent)) return {};
    const status = await agent.status();
    // Unreachable: the turn is tried and says so (agentUnreachable), with no agent to choose from.
    if (!status.reachable) return {};
    // The connector's own agent, only when the person named one there (OPENSOURCEBOOK_AGENT).
    if (status.agent && !off.has(status.agent.id)) return { agent: status.agent.id };
    // Nothing picked: the only provider that can answer, or the person is asked; none is preferred.
    const resolved = resolvePick("chat", undefined, providerViews(status, settings));
    if (!resolved) throw new AnswererUnavailableError("None of your providers can answer. Add or turn one on in Settings, under Providers.");
    return resolved;
  }

  async turn(ownerId: string, project: Project, chat: Session, input: TurnInput): Promise<TurnResult> {
    const { repos, agent } = this.options;
    const events: UsageEvent[] = [];
    const logged = repos.usage.sink({ ownerId, projectId: project.id, sessionId: chat.id });
    const tee: UsageSink = {
      record(event) {
        events.push(event);
        return logged.record(event);
      },
    };
    const guard = new BudgetGuard(tee, input.budgetUsd);
    // A thing asked for from the terminal is made at once, after this turn settles it: who makes it is checked first.
    const making = input.from === "terminal" && !input.skill ? this.options.skills.commandIn(input.text, this.options.registry)?.command.format : undefined;
    const pick = await this.answeringFor(
      ownerId,
      input.answerer ?? (typeof chat.settings.answerer === "string" ? chat.settings.answerer : undefined),
      input.effort ?? (typeof chat.settings.effort === "string" ? chat.settings.effort : undefined),
      making,
    );
    // A turn the person's agent answers needs no model provider here.
    const base = agent ? undefined : this.options.provider(guard);
    if (!agent && !base) throw new ChatUnavailableError();
    const provider = base ? guard.guard(base) : undefined;

    const pickedSkill = input.answer ? await this.pickedSkill(chat, input.answer) : undefined;
    if (agent) await agent.sweep(repos, chat.id);
    if (!(await repos.sessions.claimTurn(chat.id, new Date(this.now() - STALE_TURN_MS).toISOString()))) throw new ChatBusyError(chat.id);
    // An agent's turn keeps the chat busy until it ends (agent/turn.ts releases it).
    let release = true;
    try {
      const history = await repos.sessions.recentMessages(chat.id, HISTORY_MESSAGES);
      const user = await repos.sessions.append(chat.id, {
        role: "user",
        content: {
          text: input.text,
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.answer ? { answer: input.answer as unknown as JsonValue } : {}),
          ...(input.thread ? { about: input.thread.about as unknown as JsonValue } : {}),
        },
        ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
      });
      let current = chat;
      const patch: { title?: string; settings?: Session["settings"] } = {};
      if (input.answerer !== undefined && input.answerer !== chat.settings.answerer) patch.settings = { ...chat.settings, answerer: input.answerer };
      if (input.effort !== undefined && input.effort !== chat.settings.effort) patch.settings = { ...(patch.settings ?? chat.settings), effort: input.effort };
      // A leading `/command` is not what was asked; with nothing after it, the reply names the chat.
      const asked = this.options.skills.commandIn(input.text, this.options.registry)?.rest ?? input.text;
      if (!chat.title && asked.trim()) patch.title = titleFrom(asked);
      const ticked = await this.ticked(project, chat, input);
      if (ticked) patch.settings = { ...(patch.settings ?? chat.settings), sources: ticked };
      if (patch.title !== undefined || patch.settings) current = (await repos.sessions.update(chat.id, patch)) ?? chat;

      if (agent) {
        const command = input.skill ? { skill: input.skill, command: undefined } : this.options.skills.commandIn(input.text, this.options.registry);
        const word = command?.command ?? (command?.skill.command ? { word: command.skill.command, about: command.skill.about } : undefined);
        const started = await agent.begin({
          repos,
          registry: this.options.registry,
          conditions: this.options.conditions,
          ...(this.options.plans ? { edgeKinds: this.options.plans.edgeKinds } : {}),
          skills: this.known(),
          ownerId,
          project,
          chat: current,
          history,
          request: {
            text: asked,
            mentions: input.mentions,
            ...(word ? { command: { word: word.word, about: word.about, ...("format" in word && word.format ? { format: word.format } : {}) } } : {}),
            ...(input.opened ? { opened: input.opened } : {}),
            ...(input.today ? { today: input.today } : {}),
            ...(input.answer ? { picked: true } : {}),
            ...(input.from ? { from: input.from } : {}),
            ...(input.thread ? { thread: input.thread } : {}),
          },
          ...(input.origin ? { origin: input.origin } : {}),
          ...(pick?.agent || pick?.effort
            ? { pick: { ...(pick.agent ? { agent: pick.agent } : {}), ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) } }
            : {}),
        });
        release = !started.running;
        const content = started.reply.content;
        return { user, reply: started.reply, replyContent: (isRecord(content) && Array.isArray(content.pieces) ? content : { pieces: [] }) as unknown as ReplyContent, running: started.running };
      }

      let content: ReplyContent;
      try {
        content = await this.reply(ownerId, project, current, input, history, provider!, pickedSkill);
      } catch (error) {
        content = failedReply(error, guard.exceeded);
      }
      if (!current.title) {
        const title = await this.titleFromReply(content);
        if (title) current = (await repos.sessions.update(chat.id, { title })) ?? current;
      }
      const usage = totals(events);
      const reply = await repos.sessions.append(chat.id, {
        role: "assistant",
        content: {
          text: pieceKinds.replyText(content.pieces),
          ...(content as unknown as Record<string, JsonValue>),
          ...(usage.calls > 0 ? { usage: usage as unknown as JsonValue } : {}),
          ...(input.thread ? { about: input.thread.about as unknown as JsonValue } : {}),
        },
      });
      return { user, reply, replyContent: content };
    } finally {
      if (release) await repos.sessions.releaseTurn(chat.id);
    }
  }

  /** Every skill as the chat describes it, then each command worked out from the formats, as a skill line of its own. */
  private known(): KnownSkill[] {
    const { skills, registry } = this.options;
    const own = skills.list().map((known) => ({ id: known.id, about: known.about, ...(known.command ? { command: known.command } : {}) }));
    const worked = skills
      .commands(registry)
      .filter((command) => command.format)
      .map((command) => ({ id: command.skill, command: command.word, about: `makes one ${(command.format && registry.descriptor(command.format)?.singular) || command.label} now (${command.about})` }));
    return [...own, ...worked];
  }

  /** A title for a chat whose first message asked nothing beyond a command: the plan the reply made, if any. */
  private async titleFromReply(content: ReplyContent): Promise<string | undefined> {
    for (const piece of content.pieces) {
      if (piece.kind !== "plan") continue;
      const plan = await this.options.repos.plans.get(piece.planId);
      if (plan?.title?.trim()) return titleFrom(plan.title);
    }
    return undefined;
  }

  /**
   * The sources ticked for the chat after this message: the ones it sent,
   * plus any source it @-mentions. Undefined when nothing changes them (no
   * ticks sent or saved means all of the project's are ticked already).
   */
  private async ticked(project: Project, chat: Session, input: TurnInput): Promise<string[] | undefined> {
    const base = input.sources ?? stringList(chat.settings.sources);
    if (!base) return undefined;
    const mentioned = input.mentions.filter((mention) => mention.kind === "source" && !base.includes(mention.id)).map((mention) => mention.id);
    if (mentioned.length === 0) return input.sources;
    const inProject = new Set((await this.options.repos.sources.listByProject(project.id)).map((source) => source.id));
    const added = [...new Set(mentioned.filter((id) => inProject.has(id)))];
    return added.length > 0 ? [...base, ...added] : input.sources;
  }

  /** The skill picked options hand the turn to; throws when the picks do not fit the reply. */
  private async pickedSkill(chat: Session, answer: Picks): Promise<ChatSkill | undefined> {
    const message = await this.options.repos.sessions.getMessage(answer.messageId);
    if (!message || message.sessionId !== chat.id || message.role !== "assistant") throw new InvalidAnswerError(`No reply ${answer.messageId} in this chat`);
    const content = message.content;
    const pieces = content && typeof content === "object" && !Array.isArray(content) && Array.isArray(content.pieces) ? (content.pieces as unknown as OtherPiece[]) : [];
    const checked = checkPicks(pieces, answer.picks);
    if ("problem" in checked) throw new InvalidAnswerError(checked.problem);
    // Options naming different skills leave the choice to the router.
    return checked.skills.length === 1 ? this.options.skills.get(checked.skills[0]) : undefined;
  }

  private async reply(
    ownerId: string,
    project: Project,
    chat: Session,
    input: TurnInput,
    history: Message[],
    provider: StructuredProvider,
    picked: ChatSkill | undefined,
  ): Promise<ReplyContent> {
    const { repos, skills } = this.options;
    const named = skills.commandIn(input.text, this.options.registry);
    const forced = input.skill ? { skill: input.skill, rest: named?.rest ?? input.text, command: undefined } : named;
    const context = await buildTurnContext(repos, project, chat, { mentions: input.mentions, ...(input.sources ? { sources: input.sources } : {}) });
    const skill =
      forced?.skill ??
      picked ??
      (await routeTurn({
        text: input.text,
        history: renderHistory(history, ROUTER_HISTORY_CHARS),
        skills: skills.list(),
        chatPlans: (await repos.plans.listBySession(chat.id)).filter((plan) => !plan.direct),
        provider,
      }));
    if (!skill) {
      // A thread message is answered about the spot it was written at.
      const text = input.thread ? `${input.text}\n\n(Written while looking at one thing Open Sourcebook made; answer about this spot first, briefly.\n${input.thread.facts})` : input.text;
      return answerFromSources({ text, history, context, provider, offers: skills.list(), ...(this.options.answer ? { options: this.options.answer } : {}) });
    }
    const reply = await skill.run({
      ownerId,
      project,
      chat,
      text: forced ? forced.rest : input.text,
      how: forced ? "command" : skill === picked ? "picked" : "routed",
      ...(forced?.command?.format ? { format: forced.command.format } : {}),
      ...(input.from ? { from: input.from } : {}),
      history,
      context,
      provider,
      services: {
        repos,
        skills: this.known(),
        registry: this.options.registry,
        conditions: this.options.conditions,
        ...(this.options.plans ? { plans: this.options.plans } : {}),
      },
    });
    return { ...reply, skill: skill.id };
  }
}

/** A chat's title from its first message: the first line, cut at a word, starting with a capital. */
export function titleFrom(text: string, max = 80): string {
  const first = text.trim().split("\n")[0].replace(/\s+/g, " ");
  const line = first.charAt(0).toUpperCase() + first.slice(1);
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** The reply stored when writing one failed: why, in words for the person and as `failed` for the client. */
function failedReply(error: unknown, budget: BudgetExceededError | undefined): ReplyContent {
  const tripped = budget ?? (error instanceof BudgetExceededError ? error : undefined);
  if (tripped) {
    return {
      pieces: [say(`I stopped: this message reached its budget of $${tripped.budgetUSD.toFixed(2)} before I could finish the reply.`)],
      failed: { reason: "budget", budgetUsd: tripped.budgetUSD },
    };
  }
  const refusal = accountRefusal(error);
  if (refusal) return { pieces: [say(`I couldn't write a reply. ${accountProblem(error)}`)], failed: { reason: refusal } };
  console.warn(`Chat reply failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return { pieces: [say("I couldn't write a reply just now: the model call failed. Send the message again to retry.")], failed: { reason: "error" } };
}

function totals(events: UsageEvent[]): UsageTotals {
  const ok = events.filter((event) => event.ok);
  return {
    calls: events.length,
    failedCalls: events.length - ok.length,
    unpricedCalls: ok.filter((event) => event.usd === undefined).length,
    timedOutCalls: events.filter((event) => !event.ok && event.error === "timeout").length,
    tokensIn: events.reduce((sum, event) => sum + (event.tokensIn ?? 0), 0),
    tokensOut: events.reduce((sum, event) => sum + (event.tokensOut ?? 0), 0),
    usd: Math.round(events.reduce((sum, event) => sum + (event.usd ?? 0), 0) * 1_000_000) / 1_000_000,
  };
}

/** A chat timing key as the pick the providers list names: empty parts left out. */
function chatPickAsKept(key: { agent: string; model: string; effort: string }): Pick & { agent: string } {
  return { agent: key.agent, ...(key.model ? { model: key.model } : {}), ...(key.effort ? { effort: key.effort } : {}) };
}
