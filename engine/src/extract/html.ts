/** Lightweight HTML metadata/text reader used by the ladders' last-resort tiers. */
import type { FetchLike } from "../types";
import { boundedFetch, isHTTPURL } from "../net";
import type { ResolvedExtractionOptions } from "./context";

export interface HTMLExtraction {
  title?: string;
  author?: string;
  description?: string;
  imageURL?: string;
  canonicalURL?: string;
  text: string;
}

export async function fetchHTML(sourceURL: string, fetchImpl: FetchLike, options: ResolvedExtractionOptions): Promise<HTMLExtraction | undefined> {
  const response = await boundedFetch(sourceURL, fetchImpl, { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }, options.timeoutMs);
  if (!response?.ok) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return undefined;
  try {
    const raw = (await response.text()).slice(0, options.maxBytes);
    const title = metaContent(raw, "og:title") ?? tagContent(raw, "title");
    const description = metaContent(raw, "og:description") ?? metaContent(raw, "description");
    const author = metaContent(raw, "author") ?? metaContent(raw, "article:author");
    const imageURL = metaContent(raw, "og:image");
    const canonicalURL = linkHref(raw, "canonical");
    const text = htmlToText(raw).slice(0, options.maxTextChars);
    return { title: cleanOptional(title), description: cleanOptional(description), author: cleanOptional(author), imageURL: normalizeURL(imageURL), canonicalURL: normalizeURL(canonicalURL), text };
  } catch {
    return undefined;
  }
}

export function normalizeURL(value: string | undefined): string | undefined {
  if (!value || !isHTTPURL(value)) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

export function cleanText(value: string | undefined, maxLength: number): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

export function cleanOptional(value: string | undefined): string | undefined {
  return cleanText(value, 2_000);
}

export function cleanStringArray(value: string[] | undefined, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 1_000)).filter((item): item is string => Boolean(item)).slice(0, maxItems);
}

export function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return undefined;
}

export function linkHref(html: string, rel: string): string | undefined {
  const match = html.match(new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']+)["'][^>]*>`, "i"));
  return match?.[1] ? decodeEntities(match[1]) : undefined;
}

export function tagContent(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? htmlToText(match[1]).slice(0, 2_000) : undefined;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
