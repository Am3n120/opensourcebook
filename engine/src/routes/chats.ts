/**
 * Chats in a project and their messages (docs/api.md, "Chats").
 *
 *   GET   /v1/projects/:id/chats     → 200 { chats }
 *   POST  /v1/projects/:id/chats     → 201 { chat }                       { title?, sources? }
 *   GET   /v1/chats/:id              → 200 { chat, messages }             ?after=<seq>
 *   PATCH /v1/chats/:id              → 200 { chat }                       { title?, sources?, answerer?, effort? }
 *   DELETE /v1/chats/:id             → 200 { chatId, deletedPlanIds, keptPlanIds }
 *   POST  /v1/chats/:id/messages     → 200 { chat, messages, plans }      { text, mentions?, sources?, skill?, answer?, budgetUsd?, answerer?, effort?, from? }
 *   GET   /v1/chats/:id/usage        → 200 { usage }
 *   GET   /v1/skills                 → 200 { skills, commands }
 *   POST  /v1/chats/:id/messages/:messageId/pieces/:piece/close → 200 { message }   (the make sheet's Cancel)
 *
 * Another owner's chat is a 404, like one that does not exist.
 *
 * With the person's own agent set up (routes/agent.ts), the POST answers at
 * once: the reply comes back with `state: "running"` and the steps taken so
 * far, and fills in when the agent ends; GET shows it as it goes.
 */
import { isDay } from "../studio/days";
import { claimProposal, proposalOf } from "../chat/making/direct";
import { parseEffort, parsePick } from "../chat/providers";
import type { Picks } from "../chat/pieces";
import { AnswererUnavailableError, ChatBusyError, ChatUnavailableError, InvalidAnswerError, STALE_TURN_MS, type ReplyContent } from "../chat/service";
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import { isRecord } from "../net";
import type { Mention, Message, Project, Session } from "../studio/repositories";
import { deleteChat as deleteChatAndPlans } from "../studio/removal";
import type { EngineDeps } from "../wiring";
import { FieldError, clearableText, clearableNumber, longText, readFields, required, text } from "./fields";
import { planView } from "./plan-edits";
import { ownedProject } from "./projects";

const MAX_TITLE = 200;
const MAX_TEXT = 20_000;
const MAX_SOURCES = 500;
const MAX_MENTIONS = 50;
const MAX_MESSAGES = 500;

export async function listChats(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  const chats = (await deps.repos.sessions.listByProject(projectId)).filter((chat) => chat.ownerId === owned.ownerId);
  const counts = await deps.repos.sessions.countMessages(chats.map((chat) => chat.id));
  return json({ chats: chats.map((chat) => chatView(chat, counts.get(chat.id) ?? 0)) });
}

export async function createChat(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => ({ title: text(read.body, "title", MAX_TITLE), sources: sourceIds(read.body.sources) }));
  if ("response" in fields) return fields.response;
  if (owned.project.archivedAt) return errorResponse("project_archived", "An archived project takes no new chats", 409);
  const refused = await checkSources(deps, owned.project, fields.value.sources);
  if (refused) return refused;
  const { title, sources } = fields.value;
  const chat = await deps.repos.sessions.create({
    ownerId: owned.ownerId,
    projectId,
    ...(title ? { title } : {}),
    ...(sources ? { settings: { sources } } : {}),
  });
  return json({ chat: chatView(chat, 0) }, 201);
}

export async function getChat(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  const rawAfter = new URL(request.url).searchParams.get("after");
  const after = rawAfter === null ? -1 : Number(rawAfter);
  if (!Number.isInteger(after) || after < -1) return errorResponse("invalid_request", "after must be a message seq", 400);
  // A turn of the person's agent that ran out of time with no word from the connector ends here.
  const agent = deps.chat?.agent;
  if (agent) await agent.sweep(deps.repos, chatId);
  const messages = await deps.repos.sessions.listMessages(chatId, { afterSeq: after, limit: MAX_MESSAGES });
  const count = (await deps.repos.sessions.countMessages([chatId])).get(chatId) ?? 0;
  const chat = agent ? ((await deps.repos.sessions.get(chatId)) ?? owned.chat) : owned.chat;
  return json({ chat: chatView(chat, count), messages: await messageViews(deps, messages) });
}

/** Messages as the contract shows them; a reply still being written carries the steps taken so far and the blocks shown so far. */
export async function messageViews(deps: EngineDeps, messages: Message[]): Promise<Array<Record<string, unknown>>> {
  const running = deps.chat?.agent ? await deps.chat.agent.live(deps.repos, messages) : new Map<string, Record<string, unknown>>();
  return messages.map((message) => {
    const view = messageView(message);
    const live = running.get(message.id);
    return live ? { ...view, ...live } : view;
  });
}

export async function updateChat(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => {
    const title = "title" in read.body ? clearableText(read.body, "title", MAX_TITLE) : undefined;
    const sources = read.body.sources === null ? null : sourceIds(read.body.sources);
    const answerer = read.body.answerer === null ? null : answererField(read.body.answerer);
    const effort = read.body.effort === null ? null : effortField(read.body.effort);
    if (title === undefined && sources === undefined && answerer === undefined && effort === undefined) {
      throw new FieldError("Send title, sources, answerer or effort; null clears any of them");
    }
    return { title, sources, answerer, effort };
  });
  if ("response" in fields) return fields.response;
  const { title, sources, answerer, effort } = fields.value;
  if (answerer) {
    const refused = await checkAnswerer(deps, owned.ownerId, answerer);
    if (refused) return refused;
  }
  if (sources) {
    const refused = await checkSources(deps, owned.project, sources);
    if (refused) return refused;
  }
  let settings = owned.chat.settings;
  if (sources !== undefined) {
    const { sources: _old, ...rest } = settings;
    settings = sources === null ? rest : { ...rest, sources };
  }
  if (answerer !== undefined) {
    const { answerer: _old, ...rest } = settings;
    settings = answerer === null ? rest : { ...rest, answerer };
  }
  if (effort !== undefined) {
    const { effort: _old, ...rest } = settings;
    settings = effort === null ? rest : { ...rest, effort };
  }
  const changed = sources !== undefined || answerer !== undefined || effort !== undefined;
  const chat = await deps.repos.sessions.update(chatId, { ...(title !== undefined ? { title } : {}), ...(changed ? { settings } : {}) });
  const count = (await deps.repos.sessions.countMessages([chatId])).get(chatId) ?? 0;
  return json({ chat: chatView(chat!, count) });
}

/**
 * Deletes a chat and its messages (`DELETE /v1/chats/:id`). Plans it made
 * that never started go with it; started ones stay, with no chat.
 */
export async function deleteChat(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  if (owned.chat.busySince && Date.now() - Date.parse(owned.chat.busySince) < STALE_TURN_MS) {
    return errorResponse("chat_busy", "A reply is being written in this chat; wait for it", 409);
  }
  const deleted = await deleteChatAndPlans(deps, owned.chat);
  return json({ chatId, ...deleted });
}

export async function sendMessage(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  if (!deps.chat) return errorResponse("chat_unavailable", "Chat is not set up on this Worker", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => ({
    text: required(longText(read.body, "text", MAX_TEXT), "text"),
    mentions: mentions(read.body.mentions),
    sources: sourceIds(read.body.sources),
    skill: read.body.skill === undefined ? undefined : skillId(read.body.skill),
    answer: read.body.answer === undefined ? undefined : picks(read.body.answer),
    budgetUsd: clearableNumber(read.body, "budgetUsd", 0) ?? undefined,
    answerer: answererField(read.body.answerer),
    effort: effortField(read.body.effort),
    from: read.body.from === "terminal" ? ("terminal" as const) : undefined,
    opened: typeof read.body.opened === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(read.body.opened) ? read.body.opened : undefined,
    // The person's day, from their app: a plan's stages can be given days from it. Anything else is left out.
    today: isDay(read.body.today) ? read.body.today : undefined,
  }));
  if ("response" in fields) return fields.response;
  const input = fields.value;
  if (!input.text.trim()) return errorResponse("invalid_request", "text must not be blank", 400);
  const skill = input.skill === undefined ? undefined : deps.chat.skills.get(input.skill);
  if (input.skill !== undefined && !skill) return errorResponse("unknown_skill", `No skill "${input.skill}" (GET /v1/skills lists them)`, 400);
  if (owned.project.archivedAt) return errorResponse("project_archived", "An archived project takes no new messages", 409);
  const refused = await checkSources(deps, owned.project, input.sources);
  if (refused) return refused;
  if (input.answerer) {
    const unavailable = await checkAnswerer(deps, owned.ownerId, input.answerer);
    if (unavailable) return unavailable;
  }

  let result;
  try {
    result = await deps.chat.turn(owned.ownerId, owned.project, owned.chat, {
      text: input.text,
      mentions: input.mentions,
      ...(input.sources ? { sources: input.sources } : {}),
      ...(skill ? { skill } : {}),
      ...(input.answer ? { answer: input.answer } : {}),
      ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
      ...(input.answerer ? { answerer: input.answerer } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.opened ? { opened: input.opened } : {}),
      ...(input.today ? { today: input.today } : {}),
      origin: new URL(request.url).origin,
    });
  } catch (error) {
    if (error instanceof ChatUnavailableError) return errorResponse("chat_unavailable", error.message, 503);
    if (error instanceof AnswererUnavailableError) return errorResponse("answerer_unavailable", error.message, 409);
    if (error instanceof InvalidAnswerError) return errorResponse("invalid_answer", error.message, 400);
    if (error instanceof ChatBusyError) return errorResponse("chat_busy", "A reply is being written in this chat; wait for it", 409);
    throw error;
  }
  const chat = (await deps.repos.sessions.get(chatId))!;
  const count = (await deps.repos.sessions.countMessages([chatId])).get(chatId) ?? 0;
  const plans = await replyPlanViews(deps, result.replyContent);
  return json({ chat: chatView(chat, count), messages: await messageViews(deps, [result.user, result.reply]), plans });
}

export async function chatUsage(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  return json({ usage: await deps.repos.usage.totals("session", chatId) });
}

/**
 * Closes a make sheet a reply opened (its Cancel), so reloading the chat
 * never opens it again. Closing a closed one is a no-op; one something was
 * made from is `409 proposal_used`.
 */
export async function closeProposal(request: Request, chatId: string, messageId: string, piece: number, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  const proposal = Number.isInteger(piece) ? await proposalOf(deps.repos, { ownerId: owned.ownerId, chatId }, messageId, piece) : undefined;
  if (!proposal) return notFound("That reply has no make sheet there");
  if (proposal.piece.state === "made") return errorResponse("proposal_used", "Something was already made from this sheet", 409);
  let message = proposal.piece.state === "closed" ? proposal.message : await claimProposal(deps.repos, proposal, { state: "closed" });
  if (!message) {
    // A press or a Cancel got there first: closed stays a no-op, made is used.
    const now = await proposalOf(deps.repos, { ownerId: owned.ownerId, chatId }, messageId, piece);
    if (now?.piece.state !== "closed") return errorResponse("proposal_used", "Something was already made from this sheet", 409);
    message = now.message;
  }
  return json({ message: (await messageViews(deps, [message]))[0] });
}

export async function listSkills(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const skills = deps.chat?.skills.list() ?? [];
  // `commands`: every command the chat takes now, a skill's own and those worked out from the formats that can be made, by group (make, plan, chat).
  const commands = deps.chat?.skills.commands(deps.registry) ?? [];
  return json({
    skills: skills.map((skill) => ({ id: skill.id, label: skill.label, ...(skill.command ? { command: skill.command } : {}), about: skill.about })),
    // `title` is the one name on screen; `label` and `action` are kept one release for older clients.
    commands: commands.map((command) => ({
      command: command.word,
      title: command.title,
      group: command.group,
      about: command.about,
      skill: command.skill,
      ...(command.format ? { format: command.format } : {}),
      label: command.label,
      ...(command.action ? { action: command.action } : {}),
      ...(command.chatOnly ? { chatOnly: true } : {}),
    })),
  });
}

// ── Views ───────────────────────────────────────────────────────────────────

export function chatView(chat: Session, messageCount: number): Record<string, unknown> {
  const sources = chat.settings.sources;
  return {
    id: chat.id,
    projectId: chat.projectId,
    ...(chat.title ? { title: chat.title } : {}),
    ...(Array.isArray(sources) ? { sources } : {}),
    ...(typeof chat.settings.answerer === "string" ? { answerer: chat.settings.answerer } : {}),
    ...(typeof chat.settings.effort === "string" ? { effort: chat.settings.effort } : {}),
    messageCount,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    ...(chat.busySince ? { busySince: chat.busySince } : {}),
  };
}

/** A stored message as the contract shows it: its content's fields at the top level. */
export function messageView(message: Message): Record<string, unknown> {
  const content = isRecord(message.content) ? message.content : { text: typeof message.content === "string" ? message.content : "" };
  return {
    id: message.id,
    chatId: message.sessionId,
    seq: message.seq,
    role: message.role,
    ...content,
    ...(message.mentions ? { mentions: message.mentions } : {}),
    createdAt: message.createdAt,
  };
}

/** The plan view of every plan the reply's pieces carry, once each. */
async function replyPlanViews(deps: EngineDeps, reply: ReplyContent): Promise<Array<Record<string, unknown>>> {
  const ids = [...new Set(reply.pieces.flatMap((piece) => (piece.kind === "plan" ? [piece.planId] : [])))];
  const views: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const plan = await deps.repos.plans.get(id);
    if (plan) views.push(await planView(deps, plan));
  }
  return views;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export async function ownedChat(request: Request, chatId: string, deps: EngineDeps): Promise<{ chat: Session; project: Project; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const chat = await deps.repos.sessions.get(chatId);
  if (!chat || chat.ownerId !== auth.ownerId || !chat.projectId) return { response: notFound("Chat not found") };
  const project = await deps.repos.projects.get(chat.projectId);
  if (!project) return { response: notFound("Chat not found") };
  return { chat, project, ownerId: auth.ownerId };
}

function sourceIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SOURCES || !value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200)) {
    throw new FieldError(`sources must be a list of at most ${MAX_SOURCES} source ids`);
  }
  return [...new Set(value as string[])];
}

function mentions(value: unknown): Mention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) throw new FieldError(`mentions must be a list of at most ${MAX_MENTIONS} { kind, id, label? }`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.kind !== "string" || !/^[a-z][A-Za-z0-9]{0,39}$/.test(entry.kind) || typeof entry.id !== "string" || !entry.id || entry.id.length > 200) {
      throw new FieldError(`mentions[${index}] must be { kind, id, label? }`);
    }
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 200) : undefined;
    return { kind: entry.kind, id: entry.id, ...(label ? { label } : {}) };
  });
}

function picks(value: unknown): Picks {
  const shape = "answer must be { messageId, picks: [{ questionId, optionIds }] }";
  if (!isRecord(value) || typeof value.messageId !== "string" || !value.messageId || !Array.isArray(value.picks) || value.picks.length === 0 || value.picks.length > 20) {
    throw new FieldError(shape);
  }
  return {
    messageId: value.messageId,
    picks: value.picks.map((pick) => {
      if (!isRecord(pick) || typeof pick.questionId !== "string" || !Array.isArray(pick.optionIds) || pick.optionIds.length > 20 || !pick.optionIds.every((id) => typeof id === "string")) {
        throw new FieldError(shape);
      }
      return { questionId: pick.questionId, optionIds: [...new Set(pick.optionIds as string[])] };
    }),
  };
}

function skillId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new FieldError("skill must be a skill id");
  return value.trim();
}

/** 400 unless every id is a source of the project. */
async function checkSources(deps: EngineDeps, project: Project, sources: string[] | undefined): Promise<Response | undefined> {
  if (!sources?.length) return undefined;
  const inProject = new Set((await deps.repos.sources.listByProject(project.id)).map((source) => source.id));
  const stranger = sources.find((sourceId) => !inProject.has(sourceId));
  return stranger ? errorResponse("source_not_in_project", `Source ${stranger} is not in this chat's project`, 400) : undefined;
}

/** A provider pick as sent; whether it can answer is checked by `checkAnswerer`. */
export function answererField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !parsePick(value)) throw new FieldError("answerer must be a provider pick (GET /v1/providers lists them)");
  return value.trim();
}

/** An effort as sent: one of the ids the provider lists (GET /v1/providers); the connector refuses one its agent doesn't take. */
export function effortField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const effort = typeof value === "string" ? parseEffort(value) : undefined;
  if (!effort) throw new FieldError("effort must be one of the provider's efforts (GET /v1/providers lists them)");
  return effort;
}

/** A 409 when that pick can't answer here (no connector, or the provider is turned off); undefined when it can. */
export async function checkAnswerer(deps: EngineDeps, ownerId: string, answerer: string): Promise<Response | undefined> {
  if (!deps.chat) return errorResponse("chat_unavailable", "Chat is not set up on this Worker", 503);
  try {
    await deps.chat.answering(ownerId, answerer);
    return undefined;
  } catch (error) {
    if (error instanceof AnswererUnavailableError) return errorResponse("answerer_unavailable", error.message, 409);
    throw error;
  }
}
