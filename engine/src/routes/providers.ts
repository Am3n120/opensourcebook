/**
 * The person's providers (docs/api.md, "Providers"; DECISIONS #62, #63):
 * the agents on their computer that can answer the chat, whether each can
 * now, and which of them and of their models the chat may use.
 *
 *   GET   /v1/providers[?fresh=1]     → 200 { connector, providers, picks? }
 *   PATCH /v1/providers/:id           → 200 { connector, providers, picks? }
 *   PUT   /v1/providers/picks/:scope  → 200 { ok: true, scope, pick }   save or clear a remembered agent/model/effort pick (or a reviewer's off)
 *   PUT   /v1/providers/picks         → 200 { picks }                    several scopes at once ("Use one for all")
 *
 * Never a credential: signing in happens on the person's computer, with
 * the command each provider names.
 */
import { authenticate, errorResponse, json, readJsonObject } from "../http";
import type { EngineDeps } from "../wiring";
import { FieldError, readFields } from "./fields";
import { isReviewScope, pickScopes } from "../engines/agent-fields";
import type { AgentPick, AgentPickPatch } from "../studio/repositories/provider-settings";
import type { PicksByScope, ScopePick } from "../studio/types";

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PICK_SCOPE = /^[a-z0-9._-]{1,64}$/i;
const PICK_VALUE = /^[^\s\u0000-\u001f]{1,128}$/;
const MAX_MODELS = 50;

export async function listProviders(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  return json(await view(deps, auth.ownerId, new URL(request.url).searchParams.get("fresh") === "1"));
}

export async function updateProvider(request: Request, providerId: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!PROVIDER_ID.test(providerId)) return errorResponse("not_found", "No such provider", 404);
  if (!deps.chat?.agent) return errorResponse("agent_unavailable", "No agent connector is set up on this engine", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => {
    const { added, enabled } = read.body;
    if (added !== undefined && typeof added !== "boolean") throw new FieldError("added must be true or false");
    if (enabled !== undefined && typeof enabled !== "boolean") throw new FieldError("enabled must be true or false");
    const hiddenModels = modelIds(read.body.hiddenModels, "hiddenModels");
    const favoriteModels = modelIds(read.body.favoriteModels, "favoriteModels");
    if (added === undefined && enabled === undefined && hiddenModels === undefined && favoriteModels === undefined) {
      throw new FieldError("Send added, enabled, hiddenModels or favoriteModels");
    }
    return {
      ...(added !== undefined ? { added } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(hiddenModels !== undefined ? { hiddenModels } : {}),
      ...(favoriteModels !== undefined ? { favoriteModels } : {}),
    };
  });
  if ("response" in fields) return fields.response;
  await deps.repos.providerSettings.update(auth.ownerId, providerId, fields.value);
  return json(await view(deps, auth.ownerId));
}

export async function putProviderPick(request: Request, scope: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!PICK_SCOPE.test(scope)) return errorResponse("not_found", "No such pick scope", 404);
  if (!knownScopes(deps).has(scope)) return unknownScope([scope]);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => readPatch(read.body, scope));
  if ("response" in fields) return fields.response;
  const pick = await deps.repos.providerSettings.setPick(auth.ownerId, scope, fields.value);
  return json({ ok: true, scope, pick: pick ?? null });
}

/** "Use one for all": several scopes in one write; nothing is written when any of them is refused. */
export async function putProviderPicks(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const raw = read.body.picks;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return errorResponse("invalid_request", "Send picks: an object of scope to { agent, model, effort }", 400);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const known = knownScopes(deps);
  const unknown = entries.map(([scope]) => scope).filter((scope) => !PICK_SCOPE.test(scope) || !known.has(scope));
  if (unknown.length > 0) return unknownScope(unknown);
  const fields = readFields(() =>
    entries.map(([scope, patch]) => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new FieldError(`picks.${scope} must be an object`);
      return [scope, readPatch(patch as Record<string, unknown>, scope)] as const;
    }),
  );
  if ("response" in fields) return fields.response;
  for (const [scope, patch] of fields.value) await deps.repos.providerSettings.setPick(auth.ownerId, scope, patch);
  return json({ picks: await picksOf(deps, auth.ownerId) });
}

/** The scopes the registry derives (agent-fields.ts `pickScopes`). */
function knownScopes(deps: EngineDeps): Set<string> {
  const scopes = pickScopes(deps.registry.views());
  return new Set([...scopes.make, ...scopes.review]);
}

function unknownScope(scopes: string[]): Response {
  return errorResponse("unknown_scope", `No pick can be kept for ${scopes.join(", ")}: a scope is "chat", a format made by an agent, or "<format>.review" for a format with a reviewer`, 400);
}

function readPatch(body: Record<string, unknown>, scope: string): AgentPickPatch {
  const readOpt = (key: string): string | null => {
    const raw = body[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw new FieldError(`${key} must be a string or null`);
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!PICK_VALUE.test(trimmed)) throw new FieldError(`${key} is not a valid id`);
    return trimmed;
  };
  if (!("agent" in body) && !("model" in body) && !("effort" in body) && !("off" in body)) {
    throw new FieldError("Send agent, model, effort or off");
  }
  const patch: AgentPickPatch = { agent: readOpt("agent"), model: readOpt("model"), effort: readOpt("effort") };
  if ("off" in body) {
    const off = body.off;
    if (off !== null && typeof off !== "boolean") throw new FieldError("off must be true, false or null");
    if (off === true && !isReviewScope(scope)) throw new FieldError(`Only a reviewer can be off; ${scope} is not a review scope`);
    patch.off = off;
  }
  return patch;
}

function modelIds(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MODELS || !value.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) {
    throw new FieldError(`${name} must be at most ${MAX_MODELS} model ids`);
  }
  return value as string[];
}

function pickView(pick: AgentPick): ScopePick {
  return {
    ...(pick.agent ? { agent: pick.agent } : {}),
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.off ? { off: true } : {}),
  };
}

async function picksOf(deps: EngineDeps, ownerId: string): Promise<PicksByScope> {
  const picks: PicksByScope = {};
  for (const pick of await deps.repos.providerSettings.listPicks(ownerId)) picks[pick.scope] = pickView(pick);
  return picks;
}

async function view(deps: EngineDeps, ownerId: string, fresh = false) {
  const found = deps.chat ? await deps.chat.providers(ownerId, { fresh }) : { configured: false, reachable: false, providers: [] };
  const picks = await picksOf(deps, ownerId);
  return {
    connector: { configured: found.configured, reachable: found.reachable, ...("checkedAt" in found && found.checkedAt ? { checkedAt: found.checkedAt } : {}) },
    providers: found.providers,
    ...(Object.keys(picks).length ? { picks } : {}),
  };
}
