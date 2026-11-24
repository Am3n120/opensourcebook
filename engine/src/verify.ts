import { isAssetPath } from "./assets";
import { guardedFetch } from "./guard";
import { boundedFetch } from "./net";
import { fetchYouTubeOEmbed } from "./extract";
import type {
  ByteBlock,
  FetchLike,
  URLCheck,
  URLVerificationReport,
} from "./types";

export interface VerificationOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxURLs?: number;
  maxConcurrency?: number;
  warningURLs?: readonly string[];
}

interface URLTarget {
  url: string;
  kind: "link" | "image" | "audio" | "youtube";
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_URLS = 24;
const DEFAULT_MAX_CONCURRENCY = 4;
const plainFetch: FetchLike = (input, init) => fetch(input, init);

/** What can be verified: a set of cards (each side's blocks), a version 2 byte (its bits' blocks) or a version 1 page (its blocks). */
export type VerifiablePayload =
  | { cards: ReadonlyArray<{ front: ByteBlock[]; back?: ByteBlock[] }> }
  | { bits: ReadonlyArray<{ blocks: ByteBlock[] }> }
  | { blocks: ByteBlock[] };

/** The payload's blocks in groups, each with the path its errors are reported at. */
function blockGroups(payload: VerifiablePayload): Array<{ blocks: ByteBlock[]; path: string }> {
  if ("cards" in payload) {
    return payload.cards.flatMap((card, index) => [
      { blocks: card.front, path: `$.cards[${index}].front` },
      ...(card.back ? [{ blocks: card.back, path: `$.cards[${index}].back` }] : []),
    ]);
  }
  if ("bits" in payload) return payload.bits.map((bit, index) => ({ blocks: bit.blocks, path: `$.bits[${index}].blocks` }));
  return [{ blocks: payload.blocks, path: "$.blocks" }];
}

export async function verifyPayloadURLs(payload: VerifiablePayload, options: VerificationOptions = {}): Promise<URLVerificationReport> {
  // The links are a model's: each is checked, every redirect hop too, before it is opened.
  const given = options.fetchImpl ?? plainFetch;
  const fetchImpl = "check" in given ? given : guardedFetch(given);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxURLs = options.maxURLs ?? DEFAULT_MAX_URLS;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const warningURLs = new Set((options.warningURLs ?? []).map(urlKey));
  const groups = blockGroups(payload);
  const allTargets = collectURLTargets(groups.flatMap((group) => group.blocks));
  const targets = allTargets.slice(0, maxURLs);
  const checked = await mapBounded(targets, maxConcurrency, async (target) => {
    // Worker-relative asset paths are same-origin and immutable; they pass on
    // pattern match alone and are never fetched over the network.
    if (isAssetPath(target.url)) return { url: target.url, ok: true };
    if (target.kind === "youtube") {
      const oembed = await fetchYouTubeOEmbed(target.url, fetchImpl, timeoutMs);
      return oembed
        ? { url: target.url, ok: true, method: "oEmbed" as const, status: 200, contentType: "application/json" }
        : { url: target.url, ok: false, method: "oEmbed" as const, error: "YouTube oEmbed did not return metadata" };
    }
    return checkURL(target.url, fetchImpl, timeoutMs, target.kind);
  });

  const warnings: string[] = [];
  const chartErrors: string[] = [];
  if (targets.length < allTargets.length) warnings.push(`URL verification bounded at ${maxURLs} URLs`);
  for (const group of groups) inspectCharts(group.blocks, group.path, chartErrors);
  if (chartErrors.length > 0) warnings.push("One or more charts failed finite/consistent data checks");
  const failures: URLCheck[] = [];
  checked.forEach((entry, index) => {
    const target = targets[index];
    if (entry.ok || target.kind !== "link" || !warningURLs.has(urlKey(entry.url))) {
      if (!entry.ok) failures.push(entry);
      return;
    }
    warnings.push(`Original source URL could not be verified (${entry.url}): ${entry.error ?? "non-success response"}${entry.status ? ` (HTTP ${entry.status})` : ""}`);
  });

  return {
    checked,
    failures,
    warnings,
    mediaChecked: collectMedia(groups.flatMap((group) => group.blocks)).length,
    chartErrors,
    valid: failures.length === 0 && chartErrors.length === 0,
  };
}

export class URLVerifier {
  constructor(private readonly options: VerificationOptions = {}) {}

  verify(payload: VerifiablePayload, options: VerificationOptions = {}): Promise<URLVerificationReport> {
    return verifyPayloadURLs(payload, {
      ...this.options,
      ...options,
      ...(options.warningURLs ? { warningURLs: options.warningURLs } : {}),
    });
  }
}

async function mapBounded<T, R>(items: T[], maxConcurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()));
  return results;
}

async function checkURL(url: string, fetchImpl: FetchLike, timeoutMs: number, kind: URLTarget["kind"]): Promise<URLCheck> {
  const head = await boundedFetch(url, fetchImpl, { method: "HEAD", redirect: "follow" }, timeoutMs);
  if (head?.ok) {
    const contentType = head.headers.get("content-type") ?? undefined;
    const contentError = expectedContentTypeError(kind, contentType);
    if (!contentError) return { url, ok: true, method: "HEAD", status: head.status, ...(contentType ? { contentType } : {}) };
  }
  const get = await boundedFetch(url, fetchImpl, { method: "GET", redirect: "follow", headers: { range: "bytes=0-2048" } }, timeoutMs);
  if (get?.ok) {
    const contentType = get.headers.get("content-type") ?? undefined;
    const contentError = expectedContentTypeError(kind, contentType);
    if (!contentError) return { url, ok: true, method: "GET", status: get.status, ...(contentType ? { contentType } : {}) };
    return { url, ok: false, method: "GET", status: get.status, ...(contentType ? { contentType } : {}), error: contentError };
  }
  return {
    url,
    ok: false,
    method: get ? "GET" : head ? "HEAD" : undefined,
    ...(get || head ? { status: get?.status ?? head?.status } : {}),
    error: get || head ? "URL returned a non-success response" : "URL request failed or timed out",
  };
}

function expectedContentTypeError(kind: URLTarget["kind"], contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  if (kind === "image" && !/^image\//i.test(contentType)) return `Expected image media but received ${contentType}`;
  if (kind === "audio" && !/^(audio\/|video\/)/i.test(contentType)) return `Expected audio media but received ${contentType}`;
  return undefined;
}

function collectURLTargets(blocks: ByteBlock[]): URLTarget[] {
  const found = new Map<string, URLTarget>();
  const visit = (blocks: ByteBlock[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case "image":
          if (block.url) found.set(block.url, { url: block.url, kind: "image" });
          break;
        case "video": {
          const url = `https://www.youtube.com/watch?v=${encodeURIComponent(block.youtubeID)}`;
          found.set(url, { url, kind: "youtube" });
          break;
        }
        case "audio":
          found.set(block.url, { url: block.url, kind: "audio" });
          break;
        case "linkCard":
          found.set(block.url, { url: block.url, kind: "link" });
          break;
        case "figure":
        case "labelPicture":
          found.set(block.url, { url: block.url, kind: "image" });
          break;
        case "gallery":
          for (const image of block.images) found.set(image.url, { url: image.url, kind: "image" });
          break;
        case "clip":
          found.set(block.url, { url: block.url, kind: "link" });
          if (block.posterURL) found.set(block.posterURL, { url: block.posterURL, kind: "image" });
          break;
        case "reveal":
          visit(block.blocks);
          break;
        default:
          break;
      }
    }
  };
  visit(blocks);
  return [...found.values()];
}

function collectMedia(blocks: ByteBlock[]): string[] {
  const media: string[] = [];
  for (const block of blocks) {
    if (block.type === "image" || block.type === "video" || block.type === "audio"
      || block.type === "figure" || block.type === "gallery" || block.type === "clip") media.push(block.type);
    if (block.type === "reveal") media.push(...collectMedia(block.blocks));
  }
  return media;
}

function inspectCharts(blocks: ByteBlock[], path: string, errors: string[]): void {
  blocks.forEach((block, index) => {
    const blockPath = `${path}[${index}]`;
    if (block.type === "lineChart") {
      if (block.xLabels.length === 0 || block.series.length === 0) errors.push(`${blockPath}: lineChart has no data`);
      for (const series of block.series) {
        if (series.values.length !== block.xLabels.length) errors.push(`${blockPath}: series '${series.name}' length does not match xLabels`);
        if (series.values.some((value) => !Number.isFinite(value))) errors.push(`${blockPath}: series '${series.name}' contains a non-finite value`);
      }
    } else if (block.type === "barChart") {
      if (block.items.length === 0) errors.push(`${blockPath}: barChart has no data`);
      if (block.items.some((item) => !Number.isFinite(item.value))) errors.push(`${blockPath}: barChart contains a non-finite value`);
    } else if (block.type === "reveal") {
      inspectCharts(block.blocks, `${blockPath}.blocks`, errors);
    }
  });
}

function urlKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
