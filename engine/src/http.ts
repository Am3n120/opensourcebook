/**
 * HTTP plumbing shared by the routes: JSON responses with the August CORS
 * headers, the client-token check, and the owner id a token maps to.
 *
 * Auth is still the August shared token (no users).
 * Rows are owned by a hash of the token, never the token itself, so a
 * database read does not leak it and real users can replace it later.
 */
import { isRecord, sha256Hex } from "./net";

const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9._~:-]{16,256}$/;

export function json(body: unknown, status = 200): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-client-token, idempotency-key, x-upload-filename",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  });
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

export function errorResponse(error: string, message: string, status: number): Response {
  return json({ error, message }, status);
}

/**
 * An error that carries the issues behind it (plan checks, settings checks).
 * Plan checks also send `issueDetails`, the same issues as `{ message, itemId? }`.
 */
export function issuesResponse(error: string, message: string, status: number, issues: unknown[], issueDetails?: unknown[]): Response {
  return json({ error, message, issues, ...(issueDetails ? { issueDetails } : {}) }, status);
}

export function notFound(message = "Route not found"): Response {
  return errorResponse("not_found", message, 404);
}

/**
 * The owner a request acts as, or the error response to send. 403 when the
 * worker has no token configured or the token is wrong, 401 when the
 * request carries none (August's codes).
 */
export async function authenticate(
  request: Request,
  expectedToken: string | undefined,
  bodyToken?: string,
): Promise<{ ownerId: string } | { response: Response }> {
  if (!expectedToken || !CLIENT_TOKEN_PATTERN.test(expectedToken)) {
    return { response: errorResponse("server_token_missing", "OPENSOURCEBOOK_CLIENT_TOKEN is not configured on the Worker", 403) };
  }
  const token = request.headers.get("x-client-token")?.trim() || bodyToken?.trim();
  if (!token || !CLIENT_TOKEN_PATTERN.test(token)) {
    return { response: errorResponse("client_token_required", "A client token of 16–256 safe characters is required", 401) };
  }
  if (token !== expectedToken) {
    return { response: errorResponse("client_token_invalid", "Client token is not authorized", 403) };
  }
  return { ownerId: await ownerIdForToken(token) };
}

export async function ownerIdForToken(token: string): Promise<string> {
  return `client:${(await sha256Hex(token)).slice(0, 32)}`;
}

export async function readJsonObject(request: Request): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: errorResponse("invalid_json", "Request body must be valid JSON", 400) };
  }
  if (!isRecord(body)) return { response: errorResponse("invalid_request", "Request body must be a JSON object", 400) };
  return { body };
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/**
 * `?limit=` and `?cursor=` of a paged list (docs/api.md, "Paging"). The
 * cursor is the last row's `[sortValue, id]`, base64url JSON, opaque to
 * clients.
 */
export function pageParams(url: URL): { limit: number; after?: [string, string] } | { response: Response } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    return { response: errorResponse("invalid_request", `limit must be an integer from 1 to ${MAX_PAGE}`, 400) };
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor === null || cursor === "") return { limit };
  const after = decodeCursor(cursor);
  if (!after) return { response: errorResponse("invalid_request", "cursor is not one this engine gave out", 400) };
  return { limit, after };
}

export function encodeCursor(key: [string, string]): string {
  return btoa(JSON.stringify(key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (cursor.length % 4)) % 4);
    const key: unknown = JSON.parse(atob(padded));
    if (Array.isArray(key) && key.length === 2 && key.every((part) => typeof part === "string")) return key as [string, string];
  } catch {
    // Falls through to undefined.
  }
  return undefined;
}

/** A paged list body: the rows under `name`, plus `nextCursor` when more follow. */
export function pageBody<T>(name: string, page: { rows: T[]; next?: [string, string] }, view: (row: T) => unknown = (row) => row): Record<string, unknown> {
  return { [name]: page.rows.map(view), ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}) };
}
