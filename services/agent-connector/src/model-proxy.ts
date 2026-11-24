/**
 * The boxed agent's model calls, forwarded. A boxed agent never holds a credential: it sends its model calls here,
 * signed with its turn's secret, and the connector sends them on to the agent's provider with the API key the person
 * gave the connector. Never a subscription login: nothing here reads, holds or adds one, and whatever credential the
 * agent itself put on a call is dropped. Only the calls the agent's adapter names are forwarded, only while the turn
 * runs, and the answer streams back as it comes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Upstream } from "./agents/types.ts";

/** Model calls carry the whole conversation, pictures included. */
export const MAX_MODEL_BODY = 64_000_000;

/** Headers never passed on: the agent's own credentials, and what belongs to one connection. */
const DROPPED_REQUEST = new Set(["host", "authorization", "x-api-key", "x-goog-api-key", "content-length", "connection", "keep-alive", "transfer-encoding", "accept-encoding", "proxy-authorization", "cookie"]);
/** What the answer's own transport said; the body comes back already decoded. */
const DROPPED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

export async function forwardModelCall(request: IncomingMessage, response: ServerResponse, upstream: Upstream, path: string, search: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const method = request.method ?? "GET";
  if (!upstream.allows(method, path)) return void response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_a_model_call" }));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_MODEL_BODY) return void response.writeHead(413).end();
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  for (const [name, value] of Object.entries(upstream.headers)) headers.set(name, value);
  // A key the agent put in the address (`?key=`, as Google's API takes one) is its own credential too: never passed on.
  const query = new URLSearchParams(search);
  query.delete("key");
  const rest = query.toString();
  const abort = new AbortController();
  response.on("close", () => abort.abort());
  let answer: Response;
  try {
    answer = await fetchImpl(`${upstream.origin}${path}${rest ? `?${rest}` : ""}`, { method, headers, ...(method === "GET" ? {} : { body: Buffer.concat(chunks) }), signal: abort.signal, redirect: "manual" });
  } catch {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "provider_unreachable" }));
    return;
  }
  const out: Record<string, string> = {};
  answer.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE.has(name)) out[name] = value;
  });
  response.writeHead(answer.status, out);
  if (!answer.body) return void response.end();
  const body = Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream);
  body.on("error", () => response.destroy());
  body.pipe(response);
}
