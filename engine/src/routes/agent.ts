/**
 * The person's own agent in the chat (docs/api.md, "Your agent").
 *
 *   GET  /v1/agent                         → 200 { agent }                  which agent answers the chat, and whether it is reachable
 *   POST /v1/chats/:id/stop                → 200 { chat, messages }         stops the chat's running turn
 *   POST /v1/agent-turns/:id/tools         → 200 { text, isError }          { name, arguments }   (connector only)
 *   POST /v1/agent-turns/:id/draft         → 200 { ok }                     { tool, input, calls }   (connector only)
 *   POST /v1/agent-turns/:id/finish        → 200 { ok }                     { outcome, problem?, text?, model?, tokensIn?, tokensOut?, durationMs? }   (connector only)
 *
 * The agent-turn routes take the turn's own token (`Authorization:
 * Bearer`), which only the connector running that turn holds; they never
 * take the client token, and the connector never sees it.
 */
import { asProblem, readLimit } from "../chat/agent/connector";
import type { TurnReport } from "../chat/agent/turn";
import { authenticate, errorResponse, json, readJsonObject } from "../http";
import { chatTimingKey } from "../studio/timing";
import type { EngineDeps } from "../wiring";
import { chatView, messageView, ownedChat } from "./chats";

export async function agentStatus(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const agent = deps.chat?.agent;
  if (!agent) return json({ agent: { configured: false } });
  const status = await agent.status();
  return json({
    agent: {
      configured: true,
      reachable: status.reachable,
      ...(status.agent ? { id: status.agent.id, label: status.agent.label, installed: status.agent.installed } : {}),
      ...(status.agent?.signedIn !== undefined ? { signedIn: status.agent.signedIn } : {}),
      ...(status.agent?.version ? { version: status.agent.version } : {}),
      ...(status.model ? { model: status.model } : {}),
    },
  });
}

export async function stopChat(request: Request, chatId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedChat(request, chatId, deps);
  if ("response" in owned) return owned.response;
  const agent = deps.chat?.agent;
  const running = agent ? await deps.repos.agentTurns.running(chatId) : [];
  if (!agent || running.length === 0) return errorResponse("not_running", "Nothing is being written in this chat", 409);
  await agent.stop(deps.repos, chatId);
  const messages = [];
  for (const turn of running) {
    const message = await deps.repos.sessions.getMessage(turn.messageId);
    if (message) messages.push(messageView(message));
  }
  const chat = (await deps.repos.sessions.get(chatId))!;
  const count = (await deps.repos.sessions.countMessages([chatId])).get(chatId) ?? 0;
  return json({ chat: chatView(chat, count), messages });
}

export async function agentTool(request: Request, turnId: string, deps: EngineDeps): Promise<Response> {
  const agent = deps.chat?.agent;
  if (!agent) return errorResponse("agent_unavailable", "No agent is set up on this engine", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  if (typeof read.body.name !== "string") return errorResponse("invalid_request", "name must be a tool name", 400);
  const result = await agent.callTool(deps, turnId, bearer(request), read.body.name, read.body.arguments);
  if (result.status === 404) return errorResponse("not_found", "No such turn", 404);
  return json({ text: result.text, isError: result.isError }, result.status);
}

/** What the agent has written so far of a call to a tool that shows while it is written (the reply). */
export async function agentDraft(request: Request, turnId: string, deps: EngineDeps): Promise<Response> {
  const agent = deps.chat?.agent;
  if (!agent) return errorResponse("agent_unavailable", "No agent is set up on this engine", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { tool, input, calls } = read.body;
  if (typeof tool !== "string" || typeof input !== "string" || typeof calls !== "number" || !Number.isInteger(calls) || calls < 0) {
    return errorResponse("invalid_request", "Send { tool, input, calls }", 400);
  }
  const result = await agent.draft(deps, turnId, bearer(request), { tool, input: input.slice(0, 200_000), calls });
  if (result.status === 404) return errorResponse("not_found", "No such turn", 404);
  return json({ ok: true }, result.status);
}

export async function agentFinish(request: Request, turnId: string, deps: EngineDeps): Promise<Response> {
  const agent = deps.chat?.agent;
  if (!agent) return errorResponse("agent_unavailable", "No agent is set up on this engine", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const body = read.body;
  const number = (key: string) => (typeof body[key] === "number" && Number.isFinite(body[key]) && (body[key] as number) >= 0 ? Math.round(body[key] as number) : undefined);
  const report: TurnReport = {
    outcome: body.outcome === "done" ? "done" : "failed",
    ...(body.problem !== undefined ? { problem: asProblem(body.problem) } : {}),
    ...(typeof body.text === "string" ? { text: body.text.slice(0, 20_000) } : {}),
    ...(typeof body.model === "string" ? { model: body.model.slice(0, 200) } : {}),
    ...(number("tokensIn") !== undefined ? { tokensIn: number("tokensIn")! } : {}),
    ...(number("tokensOut") !== undefined ? { tokensOut: number("tokensOut")! } : {}),
    ...(number("durationMs") !== undefined ? { durationMs: number("durationMs")! } : {}),
    ...(() => {
      const { since: _since, ...limit } = readLimit(body.limit);
      return limit.resetsAt || limit.resets ? { limit } : {};
    })(),
  };
  const result = await agent.finish(deps, turnId, bearer(request), report);
  if (result.status === 404) return errorResponse("not_found", "No such turn", 404);
  await keepReplyTime(deps, turnId, report);
  return json({ ok: true });
}

/**
 * Keeps how long a finished chat reply took (`make_times`, scope "chat"), under
 * the pick the turn was really sent with (the agent that ran it, and the model
 * and effort kept on the turn when it began), keyed by `chatTimingKey`, the
 * same key the providers list names for the chat. Only a reply that really finished, from the time the connector
 * measured; once per turn. A turn with no kept pick (begun before picks were
 * kept) keeps none. Never fails the turn's end.
 */
async function keepReplyTime(deps: EngineDeps, turnId: string, report: TurnReport): Promise<void> {
  if (report.outcome !== "done" || !report.durationMs || report.durationMs <= 0) return;
  try {
    const turn = await deps.repos.agentTurns.get(turnId);
    if (!turn || turn.state !== "done" || !turn.pick) return;
    const status = (await deps.chat?.agent?.status()) ?? {};
    const key = chatTimingKey({ agent: turn.agent, ...turn.pick }, status, report.model);
    await deps.repos.makeTimes.record({
      ownerId: turn.ownerId,
      scope: "chat",
      agent: key.agent,
      ...(key.model ? { model: key.model } : {}),
      ...(key.effort ? { effort: key.effort } : {}),
      seconds: report.durationMs / 1000,
      jobId: turn.id,
    });
  } catch (error) {
    console.warn(`Chat turn ${turnId}: its reply time was not kept: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
