/**
 * The person's own agent making an item (a byte, a quiz) through the
 * connector on their computer (chat/agent/work.ts).
 *
 *   POST /v1/work-turns/:id/tools    → 200 { text, isError }   { name, arguments }   (connector only)
 *   POST /v1/work-turns/:id/draft    → 200 { ok }              (accepted and ignored: nothing shows while a call is written)
 *   POST /v1/work-turns/:id/finish   → 200 { ok }              { outcome, problem?, limit?: { resetsAt?, resets? }, text?, said?, model?, tokensIn?, tokensOut?, durationMs? }
 *
 * They take the turn's own token (`Authorization: Bearer`), which only the
 * connector running that turn holds, never the client token.
 */
import { asProblem, readLimit } from "../chat/agent/connector";
import { callWorkTool, finishWork } from "../chat/agent/work";
import { errorResponse, json, readJsonObject } from "../http";

export async function workTool(request: Request, turnId: string): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  if (typeof read.body.name !== "string") return errorResponse("invalid_request", "name must be a tool name", 400);
  const result = await callWorkTool(turnId, bearer(request), read.body.name, read.body.arguments);
  if (result.status === 404) return errorResponse("not_found", "No such turn", 404);
  return json({ text: result.text, isError: result.isError });
}

export async function workFinish(request: Request, turnId: string): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const body = read.body;
  const number = (key: string) => (typeof body[key] === "number" && Number.isFinite(body[key]) && (body[key] as number) >= 0 ? Math.round(body[key] as number) : undefined);
  const result = await finishWork(turnId, bearer(request), {
    outcome: body.outcome === "done" ? "done" : "failed",
    ...(body.problem !== undefined ? { problem: asProblem(body.problem) } : {}),
    ...(typeof body.text === "string" ? { text: body.text.slice(0, 20_000) } : {}),
    // The agent's own words on why its turn failed, from its own error, for the person.
    ...(typeof body.said === "string" && body.said.trim() ? { said: body.said.trim().slice(0, 300) } : {}),
    ...(typeof body.model === "string" ? { model: body.model.slice(0, 200) } : {}),
    ...(number("tokensIn") !== undefined ? { tokensIn: number("tokensIn")! } : {}),
    ...(number("tokensOut") !== undefined ? { tokensOut: number("tokensOut")! } : {}),
    ...(number("durationMs") !== undefined ? { durationMs: number("durationMs")! } : {}),
    ...limitOf(body.limit),
  });
  if (result.status === 404) return errorResponse("not_found", "No such turn", 404);
  return json({ ok: true });
}

/** What the agent said about when its plan's limit resets, when the connector passed it on. */
function limitOf(value: unknown): { limit?: { resetsAt?: string; resets?: string } } {
  const { since: _since, ...limit } = readLimit(value);
  return limit.resetsAt || limit.resets ? { limit } : {};
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
