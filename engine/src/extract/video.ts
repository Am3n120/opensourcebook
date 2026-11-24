import { boundedFetch, hostname, sleep } from "../net";
import { type AssetStore } from "../assets";
import { type AssetRef, type FetchLike } from "../types";

const MAX_THUMBNAIL_BYTES = 2_000_000;
const MAX_CHAPTERS = 100;
const MAX_FRAME_REQUEST = 32;
/** Said whenever a video's words could not be read and only what is written about it was. */
export const VIDEO_TITLE_AND_DESCRIPTION_ONLY = "Only this video's title and description could be read, not what is said in it.";

export type { ModuleExtraction } from "./module";
import { ReadingGaps } from "./limits";
import type { ModuleExtraction } from "./module";

interface SidecarChapter {
  title?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

interface SidecarPayload {
  ok?: unknown;
  title?: unknown;
  uploader?: unknown;
  duration_seconds?: unknown;
  webpage_url?: unknown;
  extractor?: unknown;
  description?: unknown;
  transcript?: unknown;
  transcript_source?: unknown;
  thumbnail?: unknown;
  chapters?: unknown;
  frames?: unknown;
}

interface SidecarFrame {
  timestamp_ms?: unknown;
  data_base64?: unknown;
  content_type?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * Universal video/social tier backed by the yt-dlp sidecar service
 * (services/ytdlp-sidecar): one generalized extractor for the ~1800 sites
 * yt-dlp supports, returning metadata plus subtitles when they exist. With no
 * sidecar configured — or when the call fails in any way — this resolves
 * `undefined` so the ladder keeps its existing Gemini → oEmbed behavior. The
 * caller-supplied text stays with the ladder; `text` here is only the newly
 * extracted content.
 */
export async function extractVideoModule(input: {
  url: string;
  sourceText: string;
  /** For what the source names (its thumbnail). */
  fetchImpl: FetchLike;
  /** For the sidecar itself, Open Sourcebook's own program at its set-up address; `fetchImpl` when not given. */
  sidecarFetchImpl?: FetchLike;
  /** The check a source address must pass before the sidecar is sent it to open. */
  checkAddress?: (raw: string) => Promise<URL>;
  assetStore?: AssetStore;
  sidecarURL?: string;
  sidecarToken?: string;
  timeoutMs: number;
  maxTextChars: number;
  /** Test hook: override the cold-start retry delay (production default 10s). */
  sidecarRetryDelayMs?: number;
}): Promise<ModuleExtraction | undefined> {
  const base = input.sidecarURL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  if (input.checkAddress && !(await input.checkAddress(input.url).then(() => true, () => false))) return undefined;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.sidecarToken) headers.authorization = `Bearer ${input.sidecarToken}`;
  const endpoint = `${base}/extract?url=${encodeURIComponent(input.url)}`;
  const response = await fetchSidecar(endpoint, input.sidecarFetchImpl ?? input.fetchImpl, { method: "GET", headers }, input.timeoutMs, input.sidecarRetryDelayMs);
  if (!response?.ok) return undefined;

  let payload: SidecarPayload;
  try {
    payload = (await response.json()) as SidecarPayload;
  } catch {
    return undefined;
  }
  if (payload.ok !== true) return undefined;

  const title = cleanText(asString(payload.title), 2_000);
  const author = cleanText(asString(payload.uploader), 2_000);
  const transcript = cleanText(asString(payload.transcript), input.maxTextChars);
  const description = cleanText(asString(payload.description), 4_000);
  if (!title && !author && !transcript && !description) return undefined;

  const canonicalURL = normalizeURL(asString(payload.webpage_url)) ?? normalizeURL(input.url);
  const referenceURL = canonicalURL ?? input.url;
  const chapters = cleanChapters(payload.chapters);
  const durationText = formatDuration(asNumber(payload.duration_seconds));

  const gaps = new ReadingGaps();
  if (!transcript) {
    gaps.add(VIDEO_TITLE_AND_DESCRIPTION_ONLY, "No subtitles available; transcript empty");
  } else if (payload.transcript_source === "automatic") {
    gaps.add("This video's words come from automatic captions and may have mistakes.", "Transcript is auto-generated and may contain errors");
  }

  const metadata: Record<string, string> = { extraction: "ytdlp-sidecar" };
  const extractor = cleanText(asString(payload.extractor), 200);
  if (extractor) metadata.extractor = extractor;
  if (durationText) metadata.durationText = durationText;
  if (chapters.length > 0) {
    metadata.chapters = JSON.stringify(chapters);
    metadata.chapterCount = String(chapters.length);
  }

  const thumbnail = await harvestThumbnail(input, asString(payload.thumbnail));
  const frameAssets = await harvestFrames(input, input.url, chapters, payload.frames);

  return {
    title,
    author,
    canonicalURL,
    excerpt: description?.slice(0, 500),
    text: [transcript, description].filter(Boolean).join("\n\n").slice(0, input.maxTextChars) || undefined,
    metadata,
    ...((thumbnail || frameAssets.length > 0) ? { assets: [ ...(thumbnail ? [thumbnail] : []), ...frameAssets ] } : {}),
    references: [{ url: referenceURL, title, domain: hostname(referenceURL), label: "source" }],
    accessLevel: transcript ? "full" : "metadata",
    depthCap: depthCapFor(transcript?.length ?? 0, Boolean(description)),
    ...gaps.fields(),
  };
}

/** The thumbnail rides along as a remote reference unless an asset store can persist the bytes. */
async function harvestFrames(
  input: { fetchImpl: FetchLike; sidecarFetchImpl?: FetchLike; assetStore?: AssetStore; sidecarURL?: string; sidecarToken?: string; timeoutMs: number; sidecarRetryDelayMs?: number },
  sourceURL: string,
  chapters: Array<{ title?: string; start_time: number; end_time?: number }>,
  payloadFrames: unknown,
): Promise<AssetRef[]> {
  const base = input.sidecarURL?.trim().replace(/\/+$/, "");
  const timestamps = chapters.map((chapter) => Math.max(0, Math.round(chapter.start_time * 1000))).slice(0, MAX_FRAME_REQUEST);
  // Frame bytes need an asset store to become usable worker-relative assets;
  // avoid an extra sidecar request when extraction is running without R2.
  if (!input.assetStore) return [];
  if (!base || timestamps.length === 0) return persistFramePayload(input, sourceURL, payloadFrames, chapters);
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (input.sidecarToken) headers.authorization = `Bearer ${input.sidecarToken}`;
  const response = await fetchSidecar(`${base}/frames`, input.sidecarFetchImpl ?? input.fetchImpl, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: sourceURL, timestamps_ms: timestamps }),
  }, input.timeoutMs, input.sidecarRetryDelayMs);
  if (!response?.ok) return persistFramePayload(input, sourceURL, payloadFrames, chapters);
  try {
    const payload = (await response.json()) as { ok?: unknown; frames?: unknown };
    return persistFramePayload(input, sourceURL, payload.ok === true ? payload.frames : payloadFrames, chapters);
  } catch {
    return persistFramePayload(input, sourceURL, payloadFrames, chapters);
  }
}

async function persistFramePayload(
  input: { assetStore?: AssetStore },
  sourceURL: string,
  value: unknown,
  chapters: Array<{ title?: string; start_time: number; end_time?: number }>,
): Promise<AssetRef[]> {
  if (!input.assetStore || !Array.isArray(value)) return [];
  const assets: AssetRef[] = [];
  for (const entry of value.slice(0, MAX_FRAME_REQUEST)) {
    if (typeof entry !== "object" || entry === null) continue;
    const frame = entry as SidecarFrame;
    const timestampMs = asNumber(frame.timestamp_ms);
    const data = asString(frame.data_base64);
    if (timestampMs === undefined || timestampMs < 0 || !data) continue;
    const bytes = decodeBase64(data);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) continue;
    const contentType = asString(frame.content_type) || "image/jpeg";
    const chapter = chapters.find((entry) => Math.round(entry.start_time * 1000) === timestampMs);
    try {
      const stored = await input.assetStore.putAsset(bytes, {
        kind: "frame",
        sourceURL,
        ...(chapter?.title ? { caption: chapter.title } : {}),
        timestampMs,
        ...(asNumber(frame.width) !== undefined ? { width: asNumber(frame.width) } : {}),
        ...(asNumber(frame.height) !== undefined ? { height: asNumber(frame.height) } : {}),
        contentType,
      });
      if (stored) assets.push(stored);
    } catch {
      // A frame is optional media; preserve the video extraction if R2 rejects it.
    }
  }
  return assets;
}

function decodeBase64(value: string): ArrayBuffer | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return undefined;
  }
}

/** The thumbnail rides along as a remote reference unless an asset store can persist the bytes. */
async function harvestThumbnail(
  input: { fetchImpl: FetchLike; assetStore?: AssetStore; timeoutMs: number },
  thumbnailURL: string | undefined,
): Promise<AssetRef | undefined> {
  const sourceURL = normalizeURL(thumbnailURL);
  if (!sourceURL) return undefined;
  if (input.assetStore) {
    const stored = await storeThumbnail(input.fetchImpl, input.assetStore, sourceURL, input.timeoutMs);
    if (stored) return stored;
  }
  return { id: await remoteAssetID(sourceURL), kind: "thumbnail", url: sourceURL, sourceURL };
}

async function storeThumbnail(
  fetchImpl: FetchLike,
  assetStore: AssetStore,
  sourceURL: string,
  timeoutMs: number,
): Promise<AssetRef | undefined> {
  const response = await boundedFetch(sourceURL, fetchImpl, { method: "GET", headers: { accept: "image/*" } }, timeoutMs);
  if (!response?.ok) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) return undefined;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_THUMBNAIL_BYTES) return undefined;
  try {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined;
    return await assetStore.putAsset(bytes, {
      kind: "thumbnail",
      sourceURL,
      ...(contentType ? { contentType } : {}),
    });
  } catch {
    return undefined;
  }
}

/** Remote-only thumbnails get a stable content-style id derived from the URL. */
async function remoteAssetID(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function depthCapFor(transcriptLength: number, hasDescription: boolean): ModuleExtraction["depthCap"] {
  if (transcriptLength >= 4_000) return "veryDeep";
  if (transcriptLength >= 600) return "deep";
  if (transcriptLength > 0 || hasDescription) return "light";
  return "tiny";
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  if (hours === 0) return `${minutes}:${rest}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
}

function cleanChapters(value: unknown): Array<{ title?: string; start_time: number; end_time?: number }> {
  if (!Array.isArray(value)) return [];
  const chapters: Array<{ title?: string; start_time: number; end_time?: number }> = [];
  for (const entry of value.slice(0, MAX_CHAPTERS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const chapter = entry as SidecarChapter;
    const start = asNumber(chapter.start_time);
    if (start === undefined || start < 0) continue;
    const title = cleanText(asString(chapter.title), 500);
    const end = asNumber(chapter.end_time);
    chapters.push({
      ...(title ? { title } : {}),
      start_time: start,
      ...(end !== undefined && end > start ? { end_time: end } : {}),
    });
  }
  return chapters;
}

/**
 * The sidecar container scales to zero when idle, and a cold start stacks on
 * top of an already-slow extraction (a 20-minute video's subtitle fetch took
 * 83s warm in production, 2026-08-09), so a first call can die at the client
 * timeout while still waking the container. Transient failures — network
 * error, timeout, or a 5xx from a starting container — get exactly one retry
 * after a cold-start delay (an immediate retry lands on the still-starting
 * container; production 503s arrived 35ms apart and both died, 2026-08-10),
 * which then lands on the warm instance. Permanent answers (401/404/422, or an
 * ok:false body) are returned as-is so the ladder falls through immediately.
 */
async function fetchSidecar(
  endpoint: string,
  fetchImpl: FetchLike,
  init: RequestInit,
  timeoutMs: number,
  retryDelayMs = SIDECAR_COLD_START_DELAY_MS,
): Promise<Response | undefined> {
  const first = await boundedFetch(endpoint, fetchImpl, init, timeoutMs);
  if (first && first.status < 500) return first;
  await sleep(retryDelayMs);
  return boundedFetch(endpoint, fetchImpl, init, timeoutMs);
}

/** How long to wait before retrying a starting container: image pull + boot. */
const SIDECAR_COLD_START_DELAY_MS = 10_000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}
