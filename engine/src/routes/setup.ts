/**
 * First-time setup (docs/api.md, "First-time setup"): how far the person is, for the three steps the app walks them
 * through (providers, voice, try it), and whether they finished or skipped it.
 *
 *   GET /v1/setup   → 200 SetupState
 *   PUT /v1/setup   { done?: boolean, voice?: { skipped: boolean } } → 200 SetupState
 *
 * Only `done` and whether the voice step was skipped are kept (`owner_settings`); the rest is read fresh each time
 * from what is set up now.
 */
import { authenticate, errorResponse, json, readJsonObject } from "../http";
import { usable } from "../chat/providers";
import type { EngineDeps } from "../wiring";

/** Where `done` is kept in `owner_settings`. */
export const SETUP_DONE_KEY = "setup.done";
/** Where a skipped voice step is kept in `owner_settings`. */
export const SETUP_VOICE_SKIPPED_KEY = "setup.voice.skipped";

export interface SetupState {
  /** Set by the last step, or "Skip" on it. */
  done: boolean;
  /** Providers added and on, and of those, how many are ready. */
  providers: { connected: number; ready: number };
  /** A voice service is chosen; `skipped`: the person skipped the voice step, so it is not shown to them again. */
  voice: { set: boolean; skipped: boolean };
}

export async function getSetup(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  return json(await setupState(deps, auth.ownerId));
}

export async function putSetup(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { done, voice } = read.body;
  const skipped = voice !== null && typeof voice === "object" && !Array.isArray(voice) ? (voice as Record<string, unknown>).skipped : undefined;
  const wrong = (done !== undefined && typeof done !== "boolean") || (voice !== undefined && typeof skipped !== "boolean") || (done === undefined && voice === undefined);
  if (wrong) return errorResponse("invalid_request", "Send done: true or false, voice: { skipped: true or false }, or both", 400);
  if (typeof done === "boolean") await deps.repos.ownerSettings.set(auth.ownerId, SETUP_DONE_KEY, done ? true : null);
  if (typeof skipped === "boolean") await deps.repos.ownerSettings.set(auth.ownerId, SETUP_VOICE_SKIPPED_KEY, skipped ? true : null);
  return json(await setupState(deps, auth.ownerId));
}

export async function setupState(deps: EngineDeps, ownerId: string): Promise<SetupState> {
  const [done, skipped, found, voice] = await Promise.all([
    deps.repos.ownerSettings.get(ownerId, SETUP_DONE_KEY),
    deps.repos.ownerSettings.get(ownerId, SETUP_VOICE_SKIPPED_KEY),
    deps.chat ? deps.chat.providers(ownerId) : Promise.resolve({ providers: [] }),
    deps.voiceChosen ? deps.voiceChosen().catch(() => false) : Promise.resolve(false),
  ]);
  const connected = found.providers.filter((provider) => provider.added && provider.enabled);
  return {
    done: done === true,
    providers: { connected: connected.length, ready: connected.filter(usable).length },
    voice: { set: voice === true, skipped: skipped === true },
  };
}
