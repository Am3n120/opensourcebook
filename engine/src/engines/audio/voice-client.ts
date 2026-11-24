/**
 * The engine's side of the scenes service's audio calls (engine/docs/audio.md,
 * "The scenes service's audio calls"): start voicing an audio's parts, read how
 * it goes, stop it, fetch the file. Whether the service can voice audio at all
 * is the service's own word in its `/status`, read from what the video maker's
 * client last heard (`cachedScenesStatus`), so nothing here decides it.
 */
import { isRecord } from "../../net";
import type { FetchLike } from "../../types/provider";
import { cachedScenesStatus, type ScenesConfig } from "../video/scenes/client";

export type VoicingState = "voicing" | "mastering" | "done" | "failed" | "stopped";

export interface VoicedResult {
  durationMs: number;
  bytes: number;
  contentType: string;
  voice: { id: string; label: string; real: boolean };
  loudness?: { lufs: number; truePeak: number };
  parts: Array<{ id: string; startMs: number; endMs: number; words: Array<{ text: string; startMs: number; endMs: number }> }>;
}

export interface VoicingJob {
  id: string;
  state: VoicingState;
  progress: number;
  step: string;
  failure?: { code: string; message: string };
  result?: VoicedResult;
}

/** The service did not answer, or not with the contract. */
export class VoiceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUnreachableError";
  }
}

/** The service answered that it has no voice to speak with. */
export class NoVoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoVoiceError";
  }
}

const CALL_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;
const STATES: readonly VoicingState[] = ["voicing", "mastering", "done", "failed", "stopped"];

export class AudioVoiceClient {
  constructor(
    readonly config: ScenesConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** What the service last said about voicing audio: undefined when it has not been heard yet. */
  heard(): { ready: boolean; problem?: string } | undefined {
    const status = cachedScenesStatus(this.config.url);
    if (!status) return undefined;
    if (!status.reachable) return { ready: false, problem: "Audio is voiced by Open Sourcebook's scene maker on this computer, and it isn't running: start Open Sourcebook again." };
    return status.audio ?? { ready: false, problem: "Open Sourcebook's scene maker on this computer cannot voice audio: update Open Sourcebook and start it again." };
  }

  async start(audio: { id: string; title: string; parts: Array<{ id: string; text: string }> }, signal?: AbortSignal): Promise<void> {
    const response = await this.call("POST", "/audio", audio, CALL_TIMEOUT_MS, signal);
    if (response.status === 202 || response.status === 200) return;
    const text = await response.text().catch(() => "");
    if (response.status === 409) {
      const body = safeJson(text);
      throw new NoVoiceError(isRecord(body) && typeof body.message === "string" ? body.message : "The scene maker has no voice to speak with.");
    }
    throw refused(response.status, text, "start voicing the audio");
  }

  async get(id: string, signal?: AbortSignal): Promise<VoicingJob | undefined> {
    const response = await this.call("GET", `/audio/${encodeURIComponent(id)}`, undefined, CALL_TIMEOUT_MS, signal);
    if (response.status === 404) return undefined;
    const text = await response.text().catch(() => "");
    if (!response.ok) throw refused(response.status, text, "read the audio");
    const job = readJob(safeJson(text));
    if (!job) throw new VoiceUnreachableError("The scene maker answered with an audio it did not describe.");
    return job;
  }

  async file(id: string, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const response = await this.call("GET", `/audio/${encodeURIComponent(id)}/file`, undefined, FILE_TIMEOUT_MS, signal);
    if (!response.ok) throw refused(response.status, await response.text().catch(() => ""), "send the audio file");
    return { bytes: await response.arrayBuffer(), contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mp4" };
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/audio/${encodeURIComponent(id)}/stop`, {}, 4_000).catch(() => undefined);
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(`${this.config.url.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new VoiceUnreachableError(`Open Sourcebook's scene maker at ${this.config.url} did not answer ${method} ${path}: ${String(error)}`);
    }
  }
}

function refused(status: number, text: string, what: string): Error {
  const message = `The scene maker would not ${what} (HTTP ${status})${text ? `: ${text.slice(0, 300)}` : ""}`;
  return status >= 500 || status === 401 || status === 403 ? new VoiceUnreachableError(message) : new Error(message);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readJob(body: unknown): VoicingJob | undefined {
  if (!isRecord(body) || typeof body.id !== "string" || !STATES.includes(body.state as VoicingState)) return undefined;
  const failure = isRecord(body.failure) ? body.failure : undefined;
  return {
    id: body.id,
    state: body.state as VoicingState,
    progress: typeof body.progress === "number" && Number.isFinite(body.progress) ? Math.min(1, Math.max(0, body.progress)) : 0,
    step: typeof body.step === "string" ? body.step : "",
    ...(failure ? { failure: { code: String(failure.code ?? "error"), message: String(failure.message ?? "") } } : {}),
    ...(isRecord(body.result) ? { result: body.result as unknown as VoicedResult } : {}),
  };
}
