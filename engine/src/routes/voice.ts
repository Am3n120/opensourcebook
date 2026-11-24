/**
 * The voice, set up in the app (docs/api.md, "Voice"). The voice runs in the scenes service on this computer, which
 * the web cannot reach or hold the token of; the engine passes each call on and reads each answer field by field, so
 * nothing the service did not mean to say reaches the browser. A key goes in and never comes back: answers say only
 * whether one is set and its last four characters.
 *
 *   GET    /v1/voice                                            → 200 VoiceSetup
 *   PUT    /v1/voice                                            { service, voice? } → 200 VoiceSetup
 *   PUT    /v1/voice/services/:service/key                      { key } → 200 { service } with its health
 *   DELETE /v1/voice/services/:service/key                      → 200 VoiceSetup
 *   GET    /v1/voice/services/:service/voices                   → 200 { voices }
 *   GET    /v1/voice/services/:service/voices/:voiceId/sample   → 200 audio
 *
 * After a change the maker status is read again at once, so audio's readiness and the video maker's voice notice
 * follow it.
 */
import { refreshScenesStatusNow, ScenesUnreachableError, ScenesVoiceError, type ScenesClient } from "../engines/video/scenes/client";
import { authenticate, errorResponse, json, readJsonObject } from "../http";
import type { EngineDeps } from "../wiring";

const MOST_KEY = 400;
const MOST_ID = 200;

type Scenes = Pick<ScenesClient, "config" | "status" | "voiceSetup" | "setVoice" | "setVoiceKey" | "clearVoiceKey" | "voiceOptions" | "voiceSample">;

async function ready(request: Request, deps: EngineDeps): Promise<{ scenes: Scenes } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  if (!deps.scenes) return { response: unavailable() };
  return { scenes: deps.scenes };
}

function unavailable(): Response {
  return errorResponse("voice_unavailable", "The voice is set up in Open Sourcebook's scene maker on this computer, and it is not running. Start Open Sourcebook again to set the voice.", 503);
}

/** A call to the scenes service, its refusals passed on with their own code and words. */
async function passOn(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ScenesVoiceError) return errorResponse(error.code, error.message, error.status);
    if (error instanceof ScenesUnreachableError) return unavailable();
    throw error;
  }
}

/** After a change: what the makers say about the voice is read again now, not in twenty seconds. */
async function refreshed(scenes: Scenes): Promise<void> {
  await refreshScenesStatusNow(scenes).catch(() => undefined);
}

export async function getVoice(request: Request, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  return passOn(async () => json(await r.scenes.voiceSetup(request.signal)));
}

export async function putVoice(request: Request, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { service, voice } = read.body;
  if (service !== null && (typeof service !== "string" || !service.trim() || service.length > MOST_ID)) return errorResponse("invalid_request", "service must be a voice service's id, or null for none", 400);
  if (voice !== undefined && voice !== null && (typeof voice !== "string" || !voice.trim() || voice.length > MOST_ID)) return errorResponse("invalid_request", "voice must be a voice id, or null", 400);
  return passOn(async () => {
    const setup = await r.scenes.setVoice({ service: service === null ? null : service.trim(), ...(voice !== undefined ? { voice: voice === null ? null : voice.trim() } : {}) }, request.signal);
    await refreshed(r.scenes);
    return json(setup);
  });
}

export async function putVoiceKey(request: Request, service: string, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const key = read.body.key;
  if (typeof key !== "string" || !key.trim() || key.trim().length > MOST_KEY) return errorResponse("invalid_request", `key must be the key as the service gave it, 1 to ${MOST_KEY} characters`, 400);
  return passOn(async () => {
    const answer = await r.scenes.setVoiceKey(service, key.trim(), request.signal);
    await refreshed(r.scenes);
    return json(answer);
  });
}

export async function deleteVoiceKey(request: Request, service: string, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  return passOn(async () => {
    const setup = await r.scenes.clearVoiceKey(service, request.signal);
    await refreshed(r.scenes);
    return json(setup);
  });
}

export async function listVoiceOptions(request: Request, service: string, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  return passOn(async () => json({ voices: await r.scenes.voiceOptions(service, request.signal) }));
}

export async function voiceSample(request: Request, service: string, voiceId: string, deps: EngineDeps): Promise<Response> {
  const r = await ready(request, deps);
  if ("response" in r) return r.response;
  return passOn(async () => {
    const sample = await r.scenes.voiceSample(service, voiceId, request.signal);
    const type = sample?.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!sample?.body || !type.startsWith("audio/")) return errorResponse("not_found", "That voice has no sample to hear", 404);
    return new Response(sample.body, { status: 200, headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
  });
}
