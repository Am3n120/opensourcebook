import { boundedFetch, hostname } from "../net";
import type { AssetStore } from "../assets";
import type { AccessLevel, AssetRef, ByteDepth, FetchLike, SourceReference, StructuredProvider } from "../types";

export type { ModuleExtraction } from "./module";
import { ReadingGaps } from "./limits";
import type { ModuleExtraction } from "./module";
export type { ImageDescription, ImageDescribingProvider } from "../types";
import type { ImageDescription, ImageDescribingProvider } from "../types";

export interface ExtractImageInput {
  /** Raw image bytes when the caller already has them; wins over `url`. */
  bytes?: ArrayBuffer;
  url?: string;
  /** Declared content type for `bytes`; the URL path uses the response header instead. */
  contentType?: string;
  sourceText: string;
  provider?: StructuredProvider;
  fetchImpl: FetchLike;
  assetStore?: AssetStore;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
}

/**
 * Image tier: resolves raw bytes (supplied or bounded GET), persists them as
 * an image asset when a store is bound, and asks a vision-capable provider
 * for a caption/OCR description. The stored asset is the payload; the caller-
 * supplied text stays with the ladder, so `text` here is only the newly
 * extracted description. Resolves undefined when no usable image bytes exist,
 * so the extraction ladder keeps its existing fallback. Never throws.
 */
export async function extractImageModule(input: ExtractImageInput): Promise<ModuleExtraction | undefined> {
  const sourceURL = input.url ? normalizeURL(input.url) : undefined;
  const resolved = await resolveImageBytes(input, sourceURL);
  if (!resolved) return undefined;
  const { bytes, contentType } = resolved;

  const gaps = new ReadingGaps();
  const canDescribe = hasDescribeImage(input.provider);
  const description = await describeImage(input.provider, bytes, contentType, input.maxTextChars);
  const hasCaption = Boolean(description?.caption || description?.textContent);

  const asset = await persistImage(input, bytes, contentType, sourceURL, description?.caption, gaps);
  if (!asset && !hasCaption) return undefined;
  // Only a picture that cannot be shown at all (not kept, no link to it) matters to the person.
  if (!asset) gaps.add("The picture itself could not be kept, only what it shows.", "No asset reference: the image was neither persisted nor linkable");

  if (!hasCaption) {
    if (canDescribe) {
      gaps.add("What this picture shows could not be described.", "The image was stored, but the vision provider returned no caption");
    } else {
      gaps.add(
        "Describing pictures is not set up, so what this picture shows was not read.",
        "The image was stored, but no vision caption is available: the configured provider cannot describe images",
      );
    }
  }

  const text = [description?.caption, description?.textContent].filter(Boolean).join("\n\n") || undefined;
  return {
    ...(text ? { text } : {}),
    ...(description?.title ? { title: description.title } : {}),
    ...(sourceURL ? { canonicalURL: sourceURL } : {}),
    ...(description?.caption ? { excerpt: description.caption.slice(0, 500) } : {}),
    metadata: {
      extraction: hasCaption ? "image-vision" : "image-bytes",
      contentType,
      byteLength: String(bytes.byteLength),
    },
    ...(asset ? { assets: [asset] } : {}),
    ...(sourceURL ? { references: [{ url: sourceURL, domain: hostname(sourceURL), label: "source" as const }] } : {}),
    accessLevel: hasCaption ? "partial" : "metadata",
    depthCap: depthCapFor(Boolean(asset), hasCaption),
    ...gaps.fields(),
  };
}

interface ResolvedImage {
  bytes: ArrayBuffer;
  contentType: string;
}

/** Supplied bytes win; otherwise a bounded GET. Non-image or oversize bodies are rejected, not sliced. */
async function resolveImageBytes(input: ExtractImageInput, sourceURL: string | undefined): Promise<ResolvedImage | undefined> {
  if (input.bytes) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.maxBytes) return undefined;
    const contentType = resolveContentType(input.contentType, input.bytes);
    return contentType ? { bytes: input.bytes, contentType } : undefined;
  }
  if (!sourceURL) return undefined;
  const response = await boundedFetch(sourceURL, input.fetchImpl, { method: "GET", headers: { accept: "image/*" } }, input.timeoutMs);
  if (!response?.ok) return undefined;
  const declaredType = response.headers.get("content-type") ?? undefined;
  if (declaredType && !isImageContentType(declaredType)) return undefined;
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

/** The declared type wins when present; without one, common image magics are sniffed. */
function resolveContentType(declared: string | undefined, bytes: ArrayBuffer): string | undefined {
  if (declared) return isImageContentType(declared) ? declared.split(";")[0].trim().toLowerCase() : undefined;
  return sniffImageContentType(new Uint8Array(bytes));
}

function isImageContentType(value: string): boolean {
  return value.trim().toLowerCase().startsWith("image/");
}

function sniffImageContentType(data: Uint8Array): string | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && String.fromCharCode(...data.subarray(0, 4)) === "GIF8") return "image/gif";
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

/** A truncated image cannot be rendered or described, so oversize bodies are rejected, not sliced. */
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

/** True only when the provider carries the vision extension; absence is a different story than failure. */
function hasDescribeImage(provider: StructuredProvider | undefined): boolean {
  return typeof (provider as ImageDescribingProvider | undefined)?.describeImage === "function";
}

/** Vision captioning is opportunistic: only providers with the describeImage extension are asked. */
async function describeImage(
  provider: StructuredProvider | undefined,
  bytes: ArrayBuffer,
  contentType: string,
  maxTextChars: number,
): Promise<{ title?: string; caption?: string; textContent?: string } | undefined> {
  const vision = provider as ImageDescribingProvider | undefined;
  if (typeof vision?.describeImage !== "function") return undefined;
  let description: ImageDescription | undefined;
  try {
    description = await vision.describeImage(bytes, contentType);
  } catch {
    return undefined;
  }
  if (!description || typeof description !== "object") return undefined;
  const title = cleanText(asString(description.title), 2_000);
  const caption = cleanText(asString(description.caption), 2_000);
  const textContent = cleanText(asString(description.textContent), maxTextChars);
  if (!title && !caption && !textContent) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(caption ? { caption } : {}),
    ...(textContent ? { textContent } : {}),
  };
}

/**
 * Persists the image as an asset. Without a store the bytes ride along as a
 * remote reference when a source URL exists, and the gap is said out loud.
 */
async function persistImage(
  input: ExtractImageInput,
  bytes: ArrayBuffer,
  contentType: string,
  sourceURL: string | undefined,
  caption: string | undefined,
  gaps: ReadingGaps,
): Promise<AssetRef | undefined> {
  if (input.assetStore) {
    try {
      const ref = await input.assetStore.putAsset(bytes, {
        kind: "image",
        ...(sourceURL ? { sourceURL } : {}),
        ...(caption ? { caption } : {}),
        contentType,
      });
      if (ref) return ref;
    } catch {
      // Falls through to the remote reference / limitation below.
    }
    gaps.note("The image could not be persisted to the asset store");
  } else {
    gaps.note("The image was not persisted because no asset store is configured");
  }
  if (!sourceURL) return undefined;
  try {
    return { id: await remoteAssetID(sourceURL), kind: "image", url: sourceURL, sourceURL, contentType };
  } catch {
    return undefined;
  }
}

/** Remote-only images get a stable content-style id derived from the URL. */
async function remoteAssetID(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stored (or referenced) plus a caption is light; the asset alone is tiny. */
function depthCapFor(hasAsset: boolean, hasCaption: boolean): ByteDepth {
  if (hasAsset && hasCaption) return "light";
  if (hasAsset) return "tiny";
  return "light";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
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

