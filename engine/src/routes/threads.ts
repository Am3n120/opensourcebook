/**
 * The thread on a made thing (engine/docs/api.md, "Threads"; chat/threads.ts).
 *
 *   GET  /v1/plans/:id/items/:itemId/thread   → 200 { item, chat?, messages, here? }   ?after=<seq>&at=<json>
 *   POST /v1/plans/:id/items/:itemId/thread   → 200 { chat, created, messages }        { text, at?, answerer?, effort?, from? }
 *   GET  /v1/threads                          → 200 { threads: [{ itemId, chatId, count, lastAt }] }   ?project=<id>
 *
 * A thread message is a message of the thing's chat (made and linked when it
 * has none), sent as any chat message is, so its reply is written the same
 * way and shows in both. `at` is where the person is in the thing, in its
 * player's own shape; `here` says such a spot in words before anything is
 * sent. Another owner's item is a 404.
 */
import { aboutOf, chatFor, linkedChat, MAX_AT_CHARS, thingOf, threadFacts, type Thing } from "../chat/threads";
import { AnswererUnavailableError, ChatBusyError, ChatUnavailableError } from "../chat/service";
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import type { JsonValue } from "../studio/types";
import type { EngineDeps } from "../wiring";
import { answererField, chatView, checkAnswerer, effortField, messageViews } from "./chats";
import { readFields, longText, required } from "./fields";

const MAX_TEXT = 20_000;

async function ownedThing(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<{ thing: Thing; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const thing = await thingOf(deps.repos, auth.ownerId, planId, itemId);
  if (!thing) return { response: notFound("Item not found") };
  return { thing, ownerId: auth.ownerId };
}

function itemView(deps: EngineDeps, thing: Thing): Record<string, unknown> {
  return {
    id: thing.node.id,
    planId: thing.plan.id,
    projectId: thing.project.id,
    title: thing.output?.title || thing.node.title,
    type: deps.registry.servedType(thing.node.type),
    ...(thing.output ? { outputId: thing.output.id } : {}),
  };
}

/** A spot as JSON, within bounds; undefined when absent, a FieldError's message when unreadable. */
function spot(value: unknown): { at?: JsonValue } | { problem: string } {
  if (value === undefined || value === null) return {};
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > MAX_AT_CHARS) return { problem: `at is too long (at most ${MAX_AT_CHARS} characters of JSON)` };
  try {
    return { at: (typeof value === "string" ? JSON.parse(value) : value) as JsonValue };
  } catch {
    return { problem: "at must be JSON: where the person is, in the player's own shape" };
  }
}

export async function getThread(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedThing(request, planId, itemId, deps);
  if ("response" in owned) return owned.response;
  const params = new URL(request.url).searchParams;
  const after = params.has("after") ? Number(params.get("after")) : -1;
  if (!Number.isInteger(after) || after < -1) return errorResponse("invalid_request", "after must be a message seq", 400);
  const at = spot(params.get("at") ?? undefined);
  if ("problem" in at) return errorResponse("invalid_request", at.problem, 400);
  const { thing } = owned;
  const here = at.at !== undefined ? aboutOf(deps.registry, thing, at.at).about.label : undefined;
  const chat = await linkedChat(deps.repos, thing);
  if (!chat) return json({ item: itemView(deps, thing), messages: [], ...(here ? { here: { label: here } } : {}) });
  // A turn of the person's agent that ran out of time with no word from the connector ends here, as the chat's read does.
  if (deps.chat?.agent) await deps.chat.agent.sweep(deps.repos, chat.id);
  const messages = await deps.repos.sessions.listAbout(chat.id, thing.node.id, { afterSeq: after });
  const count = (await deps.repos.sessions.countMessages([chat.id])).get(chat.id) ?? 0;
  const fresh = (await deps.repos.sessions.get(chat.id)) ?? chat;
  return json({ item: itemView(deps, thing), chat: chatView(fresh, count), messages: await messageViews(deps, messages), ...(here ? { here: { label: here } } : {}) });
}

export async function sendThreadMessage(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedThing(request, planId, itemId, deps);
  if ("response" in owned) return owned.response;
  if (!deps.chat) return errorResponse("chat_unavailable", "Chat is not set up on this Worker", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => ({
    text: required(longText(read.body, "text", MAX_TEXT), "text"),
    answerer: answererField(read.body.answerer),
    effort: effortField(read.body.effort),
    from: read.body.from === "terminal" ? ("terminal" as const) : undefined,
  }));
  if ("response" in fields) return fields.response;
  const input = fields.value;
  if (!input.text.trim()) return errorResponse("invalid_request", "text must not be blank", 400);
  const at = spot(read.body.at);
  if ("problem" in at) return errorResponse("invalid_request", at.problem, 400);
  const { thing, ownerId } = owned;
  if (thing.project.archivedAt) return errorResponse("project_archived", "An archived project takes no new messages", 409);
  if (input.answerer) {
    const unavailable = await checkAnswerer(deps, ownerId, input.answerer);
    if (unavailable) return unavailable;
  }
  const { about, facts } = aboutOf(deps.registry, thing, at.at);
  // A chat busy with another reply refuses the turn before anything is stored (ChatService.turn).
  const { chat, created } = await chatFor(deps.repos, thing);
  let result;
  try {
    result = await deps.chat.turn(ownerId, thing.project, chat, {
      text: input.text,
      mentions: [],
      opened: thing.node.id,
      thread: { about, facts: threadFacts(deps.registry, thing, { ...about, facts }) },
      ...(input.answerer ? { answerer: input.answerer } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.from ? { from: input.from } : {}),
      origin: new URL(request.url).origin,
    });
  } catch (error) {
    if (error instanceof ChatUnavailableError) return errorResponse("chat_unavailable", error.message, 503);
    if (error instanceof AnswererUnavailableError) return errorResponse("answerer_unavailable", error.message, 409);
    if (error instanceof ChatBusyError) return errorResponse("chat_busy", "A reply is being written in this thing's chat; wait for it", 409);
    throw error;
  }
  const fresh = (await deps.repos.sessions.get(chat.id))!;
  const count = (await deps.repos.sessions.countMessages([chat.id])).get(chat.id) ?? 0;
  return json({ chat: chatView(fresh, count), created, messages: await messageViews(deps, [result.user, result.reply]) });
}

export async function listThreads(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const project = new URL(request.url).searchParams.get("project") ?? undefined;
  const threads = await deps.repos.sessions.countAbout(auth.ownerId, project);
  return json({ threads: threads.map((thread) => ({ itemId: thread.itemId, chatId: thread.sessionId, count: thread.count, lastAt: thread.lastAt })) });
}
