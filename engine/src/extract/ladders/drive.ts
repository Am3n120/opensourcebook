import type { AssetStore } from "../../assets";
import { boundedFetch, hostname } from "../../net";
import type { FetchLike, SourceEnvelope, SourceKind, StructuredProvider } from "../../types";
import { contentTypeForName, MAX_UPLOAD_BYTES } from "../../uploads";
import { defaultFetch, sourceReference, type LadderContext } from "../context";
import { DRIVE_HOSTS } from "../kinds";
import { gaps } from "../limits";
import { extractUpload } from "./upload";

/**
 * Google Drive, Docs, Slides and Sheets links shared with anyone who has
 * the link. Open Sourcebook does not sign in to Drive: a link is turned into the file's
 * own public export (a PDF for a document or slides, so pages are kept and
 * a cite opens its page; a spreadsheet file for a sheet; the file itself for
 * a Drive file), fetched through the same address checks as every link,
 * and read by the same code as an uploaded file of that type. A link that
 * is not shared that way, or a folder, says in one plain line what to do.
 */

/** Said when the link answers with a sign-in page or a refusal. */
export const NOT_SHARED =
  "This file can't be read because it isn't shared with anyone who has the link. Share it that way, or download it and add the file.";
/** Said for a folder link. */
export const FOLDER_LINK = "A folder link can't be read. Add the files one by one, or download the folder and choose it.";
/** Said when the file is over the upload cap. */
const TOO_BIG = `This file is bigger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, the most Open Sourcebook reads from one file. Split it, or add the part you need.`;
/** Said when the export could not be fetched at all. */
const UNREACHABLE = "The file could not be downloaded from its link. Try again later.";

export type DriveLink =
  | { kind: "document" | "slides" | "sheet" | "file"; id: string; exportURL: string }
  | { kind: "folder" };

const ID = "[A-Za-z0-9_-]{10,}";

/**
 * What a Drive or Docs link points at, and where its public export is.
 * Undefined for a link on those hosts that is neither a file nor a folder
 * (a form, a page published to the web): those are read as any web page.
 */
export function driveLink(raw: string): DriveLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host)) return undefined;
  const path = url.pathname;
  if (host === "docs.google.com") {
    const match = new RegExp(`^/(document|presentation|spreadsheets)/(?:u/\\d+/)?d/(${ID})(?:/|$)`).exec(path);
    if (!match) return undefined;
    const app = match[1] as "document" | "presentation" | "spreadsheets";
    const id = match[2]!;
    const format = app === "spreadsheets" ? "xlsx" : "pdf";
    return { kind: app === "document" ? "document" : app === "presentation" ? "slides" : "sheet", id, exportURL: `https://docs.google.com/${app}/d/${id}/export?format=${format}` };
  }
  if (/^\/(?:drive\/(?:u\/\d+\/)?)?folders\//.test(path) || path === "/folderview" || path.startsWith("/embeddedfolderview")) return { kind: "folder" };
  const fileId = new RegExp(`^/file/(?:u/\\d+/)?d/(${ID})(?:/|$)`).exec(path)?.[1] ?? (/^\/(open|uc|download)$/.test(path) ? url.searchParams.get("id") : null);
  if (!fileId || !new RegExp(`^${ID}$`).test(fileId)) return undefined;
  return { kind: "file", id: fileId, exportURL: `https://drive.usercontent.google.com/download?id=${fileId}&export=download` };
}

export async function extractDrive(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  link: DriveLink,
  kind: SourceKind,
  provider: StructuredProvider | undefined,
  fetchImpl: FetchLike | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  if (link.kind === "folder") return unread(sourceText, sourceURL, kind, now, FOLDER_LINK, "A Google Drive folder link has no file to export");
  const response = await boundedFetch(link.exportURL, fetchImpl ?? defaultFetch, { method: "GET" }, ctx.options.timeoutMs);
  if (!response) return unread(sourceText, sourceURL, kind, now, UNREACHABLE, "The Google Drive export could not be fetched (network, timeout or a refused address)");
  const declared = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!response.ok || declared.startsWith("text/html")) {
    await response.body?.cancel().catch(() => undefined);
    return unread(sourceText, sourceURL, kind, now, NOT_SHARED, `The Google Drive export answered ${response.status} ${declared || "with no type"}: a sign-in page or a refusal, so the file is not shared with anyone who has the link`);
  }
  const bytes = await readCapped(response, MAX_UPLOAD_BYTES);
  if (bytes === "too big") return unread(sourceText, sourceURL, kind, now, TOO_BIG, `The Google Drive export is over ${MAX_UPLOAD_BYTES} bytes`);
  if (!bytes) return unread(sourceText, sourceURL, kind, now, UNREACHABLE, "The Google Drive export broke off while it was read");
  const filename = filenameOf(response.headers.get("content-disposition"));
  const contentType =
    link.kind === "document" || link.kind === "slides"
      ? "application/pdf"
      : declared && declared !== "application/octet-stream"
        ? declared
        : (contentTypeForName(filename) ?? declared);
  const read = await extractUpload(ctx, sourceText, contentType === "application/pdf" ? "pdf" : kind, { bytes, contentType, ...(filename ? { filename } : {}) }, provider, assetStore, now);
  return {
    ...read,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    sourceDomain: hostname(sourceURL),
    references: [sourceReference(sourceURL), ...read.references],
    metadata: { ...read.metadata, drive: link.kind },
  };
}

function unread(sourceText: string, sourceURL: string, kind: SourceKind, now: () => string, plain: string, note: string): SourceEnvelope {
  const suppliedText = sourceText.length > 0;
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    kind,
    sourceDomain: hostname(sourceURL),
    text: sourceText,
    references: [sourceReference(sourceURL)],
    metadata: { extraction: "drive-unread" },
    accessLevel: suppliedText ? "partial" : "none",
    depthCap: suppliedText ? "light" : "saveOnly",
    ...gaps([plain, note]),
    fetchedAt: now(),
  };
}

/** The body, or "too big" past the cap, or undefined when it broke off. */
async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer | "too big" | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return "too big";
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too big";
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/** The file name a download says it has (`filename*=UTF-8''...` or `filename="..."`). */
function filenameOf(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim()).slice(0, 256);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  return plain?.trim().slice(0, 256) || undefined;
}
