import { boundedFetch, hostname, sleep } from "../net";
import type { AssetStore } from "../assets";
import type { AccessLevel, AssetRef, ByteDepth, FetchLike, SourceReference, StructuredProvider } from "../types";

export type { ModuleExtraction } from "./module";
import { ReadingGaps } from "./limits";
import { audioLengthMs, runningTime } from "./audio-length";
import type { ModuleExtraction } from "./module";
export type { AudioTranscription, AudioTranscribingProvider } from "../types";
import type { AudioTranscription, AudioTranscribingProvider } from "../types";

export interface ExtractAudioInput {
  /** Raw audio bytes when the caller already has them; wins over `url`. */
  bytes?: ArrayBuffer;
  url?: string;
  /** Declared content type for `bytes`; the URL path uses the response header instead. */
  contentType?: string;
  sourceText: string;
  provider?: StructuredProvider;
  fetchImpl: FetchLike;
  assetStore?: AssetStore;
  /** Optional self-hosted faster-whisper sidecar base URL. */
  sidecarURL?: string;
  /** Bearer token sent to the sidecar when configured. */
  sidecarToken?: string;
  /** Test hook: override the cold-start retry delay (production default 10s). */
  sidecarRetryDelayMs?: number;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
}

/**
 * Audio tier: resolves raw bytes (supplied or bounded GET), transcribes them
 * when the provider has the transcribeAudio extension, and persists short
 * clips (≤ maxBytes) as an audio asset when a store is bound. The transcript
 * drives the depth cap; without one the clip is save-only with an honest
 * limitation. The caller-supplied text stays with the ladder, so `text` here
 * is only the transcript. Resolves undefined when no usable audio bytes
 * exist, so the ladder keeps its existing fallback. Never throws.
 */
export async function extractAudioModule(input: ExtractAudioInput): Promise<ModuleExtraction | undefined> {
  const sourceURL = input.url ? normalizeURL(input.url) : undefined;
  const resolved = await resolveAudioBytes(input, sourceURL);
  if (!resolved) return undefined;
  const { bytes, contentType } = resolved;

  const gaps = new ReadingGaps();
  const sidecar = await transcribeWithSidecar(input, bytes, contentType, sourceURL);
  const canTranscribe = Boolean(sidecar) || hasTranscribeAudio(input.provider);
  const transcription = sidecar ?? await transcribeAudio(input.provider, bytes, contentType);
  const transcript = transcription?.text;

  const asset = await persistAudio(input, bytes, contentType, sourceURL, gaps);
  if (!asset && !transcript) return undefined;
  // Only audio that cannot be played at all (not kept, no link to it) matters to the person.
  if (!asset) gaps.add("The audio itself could not be kept, only its words.", "No asset reference: the audio was neither persisted nor linkable");
  // How long it plays, from the file's own header, so a list can say it (sources/detail.ts).
  const length = audioLengthMs(new Uint8Array(bytes));

  if (!transcript) {
    if (canTranscribe) {
      gaps.add("The audio's words could not be turned into text.", "The audio was stored, but the transcription provider returned no transcript");
    } else {
      gaps.add(
        "Turning speech into text is not set up, so the audio's words were not read.",
        "The audio was stored, but no transcription is available: the configured provider cannot transcribe audio",
      );
    }
  }

  return {
    ...(transcript ? { text: transcript.slice(0, input.maxTextChars) } : {}),
    ...(transcript ? { excerpt: transcript.slice(0, 500) } : {}),
    ...(sourceURL ? { canonicalURL: sourceURL } : {}),
    metadata: {
      extraction: transcript ? "audio-transcription" : "audio-metadata",
      ...(transcription?.source ? { transcriptionSource: transcription.source } : {}),
      contentType,
      byteLength: String(bytes.byteLength),
      ...(length !== undefined ? { durationText: runningTime(length) } : {}),
      ...(transcription?.language ? { language: transcription.language } : {}),
    },
    ...(asset ? { assets: [asset] } : {}),
    ...(sourceURL ? { references: [{ url: sourceURL, domain: hostname(sourceURL), label: "source" as const }] } : {}),
    accessLevel: transcript ? "full" : "metadata",
    depthCap: depthCapForTranscript(transcript?.length ?? 0),
    ...gaps.fields(),
  };
}

interface ResolvedAudio {
  bytes: ArrayBuffer;
  contentType: string;
}

/** Supplied bytes win; otherwise a bounded GET. Non-audio or oversize bodies are rejected, not sliced. */
async function resolveAudioBytes(input: ExtractAudioInput, sourceURL: string | undefined): Promise<ResolvedAudio | undefined> {
  if (input.bytes) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.maxBytes) return undefined;
    const contentType = resolveContentType(input.contentType, input.bytes);
    return contentType ? { bytes: input.bytes, contentType } : undefined;
  }
  if (!sourceURL) return undefined;
  const response = await boundedFetch(sourceURL, input.fetchImpl, { method: "GET", headers: { accept: "audio/*" } }, input.timeoutMs);
  if (!response?.ok) return undefined;
  const declaredType = response.headers.get("content-type") ?? undefined;
  if (declaredType && !isAudioContentType(declaredType)) return undefined;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > input.maxBytes) return undefined;
  try {
    const bytes = await readBodyWithCap(response, input.maxBytes);
    if (!bytes) return undefined;
    const contentType = resolveContentType(declaredType, bytes);
    return contentType ? { bytes, contentType } : undefined;
  } catch {
    return undefined;
  }
}

/** The declared type wins when present; without one, common audio container magics are sniffed. */
function resolveContentType(declared: string | undefined, bytes: ArrayBuffer): string | undefined {
  if (declared) return isAudioContentType(declared) ? declared.split(";")[0].trim().toLowerCase() : undefined;
  return sniffAudioContentType(new Uint8Array(bytes));
}

function isAudioContentType(value: string): boolean {
  return value.trim().toLowerCase().startsWith("audio/");
}

function sniffAudioContentType(data: Uint8Array): string | undefined {
  const head = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data.length >= 3 && head(0, 3) === "ID3") return "audio/mpeg";
  // MP3 frame sync: eleven consecutive set bits.
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (data.length >= 12 && head(0, 4) === "RIFF" && head(8, 12) === "WAVE") return "audio/wav";
  if (data.length >= 4 && head(0, 4) === "OggS") return "audio/ogg";
  if (data.length >= 4 && head(0, 4) === "fLaC") return "audio/flac";
  if (data.length >= 8 && head(4, 8) === "ftyp") return "audio/mp4";
  return undefined;
}

/** A truncated clip cannot be played or transcribed, so oversize bodies are rejected, not sliced. */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<ArrayBuffer | undefined> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > 0 && buffer.byteLength <= maxBytes ? buffer : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  if (total === 0) return undefined;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

/** True only when the provider carries the transcription extension; absence is a different story than failure. */
function hasTranscribeAudio(provider: StructuredProvider | undefined): boolean {
  return typeof (provider as AudioTranscribingProvider | undefined)?.transcribeAudio === "function";
}

/** Transcription is opportunistic: only providers with the transcribeAudio extension are asked. */
async function transcribeAudio(
  provider: StructuredProvider | undefined,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<AudioTranscription | undefined> {
  const transcriber = provider as AudioTranscribingProvider | undefined;
  if (typeof transcriber?.transcribeAudio !== "function") return undefined;
  let transcription: AudioTranscription | undefined;
  try {
    transcription = await transcriber.transcribeAudio(bytes, contentType);
  } catch {
    return undefined;
  }
  if (!transcription || typeof transcription !== "object") return undefined;
  const text = cleanText(asString(transcription.text));
  const language = cleanText(asString(transcription.language));
  if (!text) return undefined;
  return { text, ...(language ? { language } : {}), ...(transcription.source ? { source: transcription.source } : {}) };
}

/**
 * Try the sidecar first; failures resolve undefined so the existing provider
 * ladder remains intact. Two production realities shape the call: CPU whisper
 * inference far exceeds the 12s page-fetch default, so the transcription gets
 * its own budget; and a cold-starting container answers 503 immediately, so a
 * transient failure earns one retry after a cold-start delay.
 */
async function transcribeWithSidecar(
  input: ExtractAudioInput,
  bytes: ArrayBuffer,
  contentType: string,
  sourceURL: string | undefined,
): Promise<AudioTranscription | undefined> {
  const base = input.sidecarURL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (input.sidecarToken) headers.authorization = `Bearer ${input.sidecarToken}`;
  const body = sourceURL
    ? JSON.stringify({ url: sourceURL, content_type: contentType })
    : JSON.stringify({ audio_base64: toBase64(bytes), content_type: contentType });
  const timeoutMs = Math.max(input.timeoutMs, SIDECAR_TRANSCRIBE_TIMEOUT_MS);
  let response = await boundedFetch(`${base}/transcribe`, input.fetchImpl, { method: "POST", headers, body }, timeoutMs);
  if (!response || response.status >= 500) {
    await sleep(input.sidecarRetryDelayMs ?? SIDECAR_COLD_START_DELAY_MS);
    response = await boundedFetch(`${base}/transcribe`, input.fetchImpl, { method: "POST", headers, body }, timeoutMs);
  }
  if (!response?.ok) return undefined;
  try {
    const payload = (await response.json()) as { ok?: unknown; text?: unknown; language?: unknown };
    if (payload.ok !== true) return undefined;
    const text = cleanText(asString(payload.text));
    if (!text) return undefined;
    const language = cleanText(asString(payload.language));
    return { text, ...(language ? { language } : {}), source: "faster-whisper" };
  } catch {
    return undefined;
  }
}

/** CPU whisper on a container: model load + inference for multi-minute audio. */
const SIDECAR_TRANSCRIBE_TIMEOUT_MS = 120_000;
/** How long to wait before retrying a starting container: image pull + boot. */
const SIDECAR_COLD_START_DELAY_MS = 10_000;

function toBase64(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  return btoa(binary);
}

/** Short clips persist as audio assets; without a store a source URL rides along as a remote reference. */
async function persistAudio(
  input: ExtractAudioInput,
  bytes: ArrayBuffer,
  contentType: string,
  sourceURL: string | undefined,
  gaps: ReadingGaps,
): Promise<AssetRef | undefined> {
  if (input.assetStore) {
    try {
      const ref = await input.assetStore.putAsset(bytes, {
        kind: "audio",
        ...(sourceURL ? { sourceURL } : {}),
        contentType,
      });
      if (ref) return ref;
    } catch {
      // Falls through to the remote reference / limitation below.
    }
    gaps.note("The audio clip could not be persisted to the asset store");
  } else {
    gaps.note("The audio clip was not persisted because no asset store is configured");
  }
  if (!sourceURL) return undefined;
  try {
    return { id: await remoteAssetID(sourceURL), kind: "audio", url: sourceURL, sourceURL, contentType };
  } catch {
    return undefined;
  }
}

/** Remote-only clips get a stable content-style id derived from the URL. */
async function remoteAssetID(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Depth reflects the full transcript even though the handoff text is truncated. */
function depthCapForTranscript(transcriptLength: number): ByteDepth {
  if (transcriptLength >= 30_000) return "veryDeep";
  if (transcriptLength >= 4_000) return "deep";
  if (transcriptLength >= 600) return "medium";
  if (transcriptLength > 0) return "light";
  return "saveOnly";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function normalizeURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

