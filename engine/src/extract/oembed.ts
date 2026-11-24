import { boundedFetch, isRecord } from "../net";
import { parseHTML } from "linkedom";
import type { FetchLike } from "../types";

/**
 * The provider-neutral subset of the oEmbed response that crosses the
 * extraction/generation boundary. `html` is deliberately not sanitized or
 * rewritten: the iOS WebView receives the provider's embed document verbatim.
 */
export interface OEmbedMetadata {
  type?: string;
  version?: string;
  title?: string;
  authorName?: string;
  authorURL?: string;
  providerName?: string;
  providerURL?: string;
  cacheAge?: string;
  thumbnailURL?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  html?: string;
  width?: number;
  height?: number;
}

export interface OEmbedResult {
  endpoint: string;
  metadata: OEmbedMetadata;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const OEMBED_TYPE = "application/json+oembed";

/**
 * Discovers and fetches a page's JSON oEmbed endpoint. The link may be
 * absolute or relative and may already contain the source URL/format query
 * parameters; missing parameters are added according to the oEmbed spec.
 * Any malformed, non-JSON, oversized, or unsuccessful response resolves
 * undefined so the caller can keep its link-preview fallback.
 */
export async function fetchOEmbedFromHTML(
  pageHTML: string,
  pageURL: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<OEmbedResult | undefined> {
  const endpoint = discoverOEmbedEndpoint(pageHTML, pageURL);
  if (!endpoint) return undefined;

  const response = await boundedFetch(
    endpoint,
    fetchImpl,
    { method: "GET", headers: { accept: "application/json" } },
    timeoutMs,
  );
  if (!response?.ok) return undefined;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) return undefined;

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return undefined;
  }
  if (raw.length > maxResponseBytes) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const metadata = normalizeOEmbed(payload, endpoint);
  return metadata ? { endpoint, metadata } : undefined;
}

/** Finds the first JSON oEmbed discovery link and resolves it against the page. */
export function discoverOEmbedEndpoint(pageHTML: string, pageURL: string): string | undefined {
  try {
    const { document } = parseHTML(pageHTML);
    for (const link of Array.from(document.querySelectorAll("link"))) {
      const type = link.getAttribute("type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== OEMBED_TYPE) continue;
      const href = link.getAttribute("href")?.trim();
      if (!href) continue;
      const endpoint = new URL(href, pageURL);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") continue;
      if (!endpoint.searchParams.has("url")) endpoint.searchParams.set("url", pageURL);
      if (!endpoint.searchParams.has("format")) endpoint.searchParams.set("format", "json");
      return endpoint.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeOEmbed(payload: Record<string, unknown>, endpoint: string): OEmbedMetadata | undefined {
  const metadata: OEmbedMetadata = {
    ...(stringValue(payload.type) ? { type: stringValue(payload.type) } : {}),
    ...(stringValue(payload.version) ? { version: stringValue(payload.version) } : {}),
    ...(stringValue(payload.title) ? { title: stringValue(payload.title) } : {}),
    ...(stringValue(payload.author_name) ? { authorName: stringValue(payload.author_name) } : {}),
    ...(absoluteURL(payload.author_url, endpoint) ? { authorURL: absoluteURL(payload.author_url, endpoint) } : {}),
    ...(stringValue(payload.provider_name) ? { providerName: stringValue(payload.provider_name) } : {}),
    ...(absoluteURL(payload.provider_url, endpoint) ? { providerURL: absoluteURL(payload.provider_url, endpoint) } : {}),
    ...(stringValue(payload.cache_age) ? { cacheAge: stringValue(payload.cache_age) } : {}),
    ...(absoluteURL(payload.thumbnail_url, endpoint) ? { thumbnailURL: absoluteURL(payload.thumbnail_url, endpoint) } : {}),
    ...(finiteNumber(payload.thumbnail_width) !== undefined ? { thumbnailWidth: finiteNumber(payload.thumbnail_width) } : {}),
    ...(finiteNumber(payload.thumbnail_height) !== undefined ? { thumbnailHeight: finiteNumber(payload.thumbnail_height) } : {}),
    // Do not trim/collapse provider HTML: consumers depend on the exact embed markup.
    ...(typeof payload.html === "string" && payload.html.length > 0 ? { html: payload.html } : {}),
    ...(finiteNumber(payload.width) !== undefined ? { width: finiteNumber(payload.width) } : {}),
    ...(finiteNumber(payload.height) !== undefined ? { height: finiteNumber(payload.height) } : {}),
  };

  // `type` and `version` are the only required oEmbed response fields. A
  // title-only object is usually an error page serialized as JSON, not a
  // usable widget response, so it must keep the caller's link fallback.
  if (!metadata.type || !metadata.version) return undefined;
  return metadata;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const result = value.trim();
    return result || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function absoluteURL(value: unknown, baseURL: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, baseURL);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

