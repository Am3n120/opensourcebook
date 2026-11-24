/** Source-kind inference and content-type routing rules shared by the ladders. */
import type { SourceKind } from "../types";
import { hostname } from "../net";
import type { ModuleExtraction } from "./module";

export const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);
/** Google Drive and Docs: their links are read as the file's public export (ladders/drive.ts), not as a page. */
export const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const SOCIAL_HOST_PATTERN = /(^|\.)((x|twitter|reddit|instagram|tiktok|linkedin)\.com|threads\.net)$/i;

export function inferKind(kind: SourceKind, url: string | undefined): SourceKind {
  if (url) {
    const host = hostname(url)?.toLowerCase();
    if (host && YOUTUBE_HOSTS.has(host)) return "youtube";
    if (host && SOCIAL_HOST_PATTERN.test(host)) return "social";
    if (/\.pdf(?:$|[?#])/i.test(url)) return "pdf";
  }
  return kind;
}

/** Office Open XML plus the legacy Office MIME types (doc/xls/ppt families). */
export function isOfficeContentType(contentType: string): boolean {
  return (
    contentType.includes("vnd.openxmlformats") ||
    contentType.includes("msword") ||
    contentType.includes("ms-excel") ||
    contentType.includes("ms-powerpoint")
  );
}

/** Raw data files served as their own documents (the web tier only takes HTML). */
export function isPlainDataContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/plain") ||
    contentType.startsWith("text/markdown") ||
    contentType.startsWith("text/csv") ||
    contentType.startsWith("text/tab-separated-values") ||
    contentType.startsWith("text/xml") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/rss+xml") ||
    contentType.includes("application/atom+xml")
  );
}

/**
 * The office module proves the real format from the bytes; when that is a
 * spreadsheet and the caller's kind is only a generic default (text for
 * uploads, web/unknown for links), specialize to "spreadsheet" so the
 * spreadsheet-specific guidance and byte typing apply. An explicit caller
 * kind always wins.
 */
export function officeSourceKind(kind: SourceKind, result: ModuleExtraction): SourceKind {
  if (result.metadata?.extraction !== "office-xlsx") return kind;
  return kind === "text" || kind === "unknown" || kind === "web" ? "spreadsheet" : kind;
}

/**
 * When the page declares a schema.org Recipe in its JSON-LD (surfaced as
 * metadata.schemaType by the web module) and the caller's kind is only a
 * generic default (web/unknown for links, text for pastes), specialize to
 * "recipe" so the recipe guidance (servingsScaler/timer contract) and byte
 * typing apply. An explicit caller kind always wins.
 */
export function webSourceKind(kind: SourceKind, result: ModuleExtraction): SourceKind {
  if (result.metadata?.schemaType !== "Recipe") return kind;
  return kind === "text" || kind === "unknown" || kind === "web" ? "recipe" : kind;
}

/** A link on a Google Drive or Docs host. */
export function isDriveURL(value: string): boolean {
  const host = hostname(value)?.toLowerCase();
  return Boolean(host && DRIVE_HOSTS.has(host));
}

export function isRedditURL(value: string): boolean {
  try {
    return /(^|\.)reddit\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** arXiv /abs/<id> and /html/<id> pages → the canonical /pdf/<id> document. */
export function arxivPdfURL(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^\/(abs|html)\/(\d{4}\.\d{4,6})(v\d+)?\/?$/i);
    if (!match) return undefined;
    return `https://arxiv.org/pdf/${match[2]}${match[3] ?? ""}`;
  } catch {
    return undefined;
  }
}

/** Channels, handles, user pages, and playlists are not videos. */
export function isYouTubeNonVideoURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    const path = parsed.pathname.toLowerCase();
    return path.startsWith("/channel/") || path.startsWith("/c/") || path.startsWith("/user/") || path.startsWith("/@") || path.startsWith("/playlist");
  } catch {
    return false;
  }
}

const TEXT_FILE_EXTENSIONS = /\.(txt|text|md|markdown|csv|tsv|json)$/i;

/**
 * A text file (notes, Markdown, CSV, JSON): by its content type, or by its
 * name when a browser sent it with no type or as raw bytes.
 */
export function isTextFile(contentType: string, filename: string | undefined): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (isPlainDataContentType(type)) return true;
  return (type === "" || type === "application/octet-stream") && !!filename && TEXT_FILE_EXTENSIONS.test(filename);
}
