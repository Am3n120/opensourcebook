/**
 * Picture search over Wikimedia Commons (`PictureSearch`). Free, keyless, and
 * every file page states its licence and author, which the video engine must
 * keep and show. Files whose licence Commons does not
 * state are dropped rather than guessed.
 */
import { isRecord } from "../net";
import type { FetchLike, UsageSink } from "../types/provider";
import type { MediaCallContext, PictureCandidate, PictureSearch, PictureSearchRequest } from "../types/media";
import { meteredCall } from "./media";

export interface CommonsSearchOptions {
  fetchImpl?: FetchLike;
  baseURL?: string;
  usageSink?: UsageSink;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const METADATA_FIELDS = "LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription";

export class CommonsProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CommonsProviderError";
  }
}

export class CommonsPictureSearch implements PictureSearch {
  readonly name = "wikimedia-commons";
  private readonly fetchImpl: FetchLike;
  private readonly baseURL: string;
  private readonly usageSink?: UsageSink;
  private readonly timeoutMs: number;

  constructor(options: CommonsSearchOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.usageSink = options.usageSink;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(request: PictureSearchRequest, ctx: MediaCallContext): Promise<PictureCandidate[]> {
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const url = new URL(this.baseURL);
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "search",
      gsrsearch: `filetype:bitmap ${request.query}`,
      gsrnamespace: "6",
      gsrlimit: String(limit),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiextmetadatafilter: METADATA_FIELDS,
    }).toString();
    const payload = await meteredCall({
      provider: this.name,
      model: "commons-search",
      task: "searchPictures",
      ctx,
      usage: this.usageSink,
      estimateUSD: 0,
      call: async (signal) => {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(url.toString(), {
          headers: { accept: "application/json", "user-agent": "OpenSourcebook-Engine/0.2 (picture search)" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new CommonsProviderError(`Commons search failed (${response.status})`, response.status);
        const body: unknown = await response.json();
        // Commons sometimes answers 200 with an error body when it is busy.
        if (isRecord(body) && isRecord(body.error)) {
          throw new CommonsProviderError(`Commons search failed: ${String(body.error.info ?? body.error.code ?? "error")}`);
        }
        return { result: body };
      },
    });
    return candidatesFromCommons(payload, request.minWidth);
  }
}

/** Commons API answer → candidates in search order, licensed files only. */
export function candidatesFromCommons(payload: unknown, minWidth?: number): PictureCandidate[] {
  if (!isRecord(payload) || !isRecord(payload.query) || !Array.isArray(payload.query.pages)) return [];
  const pages = payload.query.pages.filter(isRecord);
  pages.sort((a, b) => numberOr(a.index, Infinity) - numberOr(b.index, Infinity));
  const candidates: PictureCandidate[] = [];
  for (const page of pages) {
    const info = Array.isArray(page.imageinfo) && isRecord(page.imageinfo[0]) ? page.imageinfo[0] : undefined;
    if (!info || typeof info.url !== "string" || typeof info.descriptionurl !== "string") continue;
    const meta = isRecord(info.extmetadata) ? info.extmetadata : {};
    const licenceName = metaText(meta, "LicenseShortName");
    if (!licenceName) continue;
    const width = typeof info.width === "number" ? info.width : undefined;
    if (minWidth !== undefined && (width === undefined || width < minWidth)) continue;
    const licenceURL = metaText(meta, "LicenseUrl");
    const description = metaText(meta, "ImageDescription");
    const credit = metaText(meta, "Artist") ?? metaText(meta, "Credit") ?? "Unknown author, via Wikimedia Commons";
    candidates.push({
      url: info.url,
      pageURL: info.descriptionurl,
      title: typeof page.title === "string" ? page.title.replace(/^File:/, "") : info.url,
      ...(width !== undefined ? { width } : {}),
      ...(typeof info.height === "number" ? { height: info.height } : {}),
      ...(typeof info.mime === "string" ? { contentType: info.mime } : {}),
      ...(description ? { description } : {}),
      licence: { name: licenceName, ...(licenceURL ? { url: licenceURL } : {}) },
      credit,
      archive: "Wikimedia Commons",
    });
  }
  return candidates;
}

function metaText(meta: Record<string, unknown>, key: string): string | undefined {
  const field = meta[key];
  if (!isRecord(field) || typeof field.value !== "string") return undefined;
  const text = stripHTML(field.value);
  return text.length > 0 ? text : undefined;
}

/** Commons metadata is HTML; keep the words. */
export function stripHTML(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
