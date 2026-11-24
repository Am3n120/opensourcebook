/**
 * How long things took to make on this computer (docs/api.md, "Making times").
 *
 *   GET /v1/make-times[?scope=<scope>]  → 200 { times: MakeTime[] }
 *
 * Only what past runs here measured, one entry per exact key of scope,
 * agent, model, effort and (for shapes that declare one) length bucket. A
 * key with no run is not listed, and no entry stands in for another.
 */
import { authenticate, errorResponse, json } from "../http";
import type { EngineDeps } from "../wiring";

const SCOPE = /^[a-z0-9._-]{1,64}$/i;

export async function listMakeTimes(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const scope = new URL(request.url).searchParams.get("scope") ?? undefined;
  if (scope !== undefined && !SCOPE.test(scope)) return errorResponse("invalid_request", "scope must be chat, a format id or <format>.review", 400);
  return json({ times: await deps.repos.makeTimes.summary(auth.ownerId, scope) });
}
