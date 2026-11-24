/**
 * `GET /v1/formats`: every format the engine knows, as its descriptor, so the
 * web and the phone never keep a list of their own (docs/DECISIONS.md #24).
 *
 *   200 { formats: [{ id, label, colorSlot, icon, aliases?, settings, defaults, ready }] }
 *
 * Registration order. `ready` is true when an engine can make it now; the
 * rest can be shown but not yet made. A client that meets a stored id that
 * is neither an id nor an alias here shows it with a neutral badge.
 *
 * A `choice` setting stores one option's value, a `choices` setting a list
 * of them; every option carries a `label` and a one-line `description`, so
 * clients show words and never the stored code.
 */
import { authenticate, json } from "../http";
import { createDefaultEdgeKinds } from "../studio/edge-kinds";
import type { EngineDeps } from "../wiring";

export async function listFormats(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  return json({ formats: deps.registry.views() });
}

/**
 * `GET /v1/edge-kinds`: the kinds of link between plan items the plan runner
 * knows, in words, for a pick list (studio/edge-kinds.ts).
 *
 *   200 { edgeKinds: [{ id, label, about }] }
 */
export async function listEdgeKinds(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const kinds = (deps.plans?.edgeKinds ?? createDefaultEdgeKinds()).list();
  return json({ edgeKinds: kinds.map(({ id, label, about }) => ({ id, label, about })) });
}
