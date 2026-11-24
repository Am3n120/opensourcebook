import type { AssetStore } from "../assets";
import { ACCESS_LEVELS, depthRank } from "../types";
import type {
  AccessLevel,
  BrowserBindingLike,
  ByteDepth,
  FetchLike,
  SourceEnvelope,
  SourceKind,
  SourceReference,
} from "../types";
import { dohResolver, guardedFetch, guardOf } from "../guard";
import { hostname, isHTTPURL } from "../net";
import { gaps } from "./limits";
import type { ModuleExtraction } from "./module";
import { extractVideoModule } from "./video";

const DEFAULT_MAX_BYTES = 1_000_000;
/** PDFs are binary documents, not pages — they get their own, larger cap. */
const DEFAULT_PDF_MAX_BYTES = 25_000_000;
/**
 * The most text a source keeps (engine/docs/long-sources.md): about a
 * 200-page book or seven hours of speech, and at most 1.2 MB, inside a D1
 * row. Every maker reads the part it needs (`sources/reading.ts`), so this
 * bounds storage, not the size of a model call. Above it the text is cut
 * here, at one place, and says so (`capSourceText`).
 */
export const MAX_SOURCE_CHARS = 400_000;
const DEFAULT_MAX_TEXT = MAX_SOURCE_CHARS;
/**
 * How much text the ladders may read before the cut, so the cut can say how
 * long the source really is. The fetch byte limits still bound the work.
 */
const DEFAULT_READ_TEXT = 1_000_000;
export const DEFAULT_TIMEOUT_MS = 12_000;
/** The yt-dlp sidecar cold-starts a container and then asks the site for
 *  subtitles; long videos legitimately take 60–90s. Separate from the page
 *  fetch budget so slow video extraction no longer falls back to oEmbed. */
const DEFAULT_VIDEO_TIMEOUT_MS = 95_000;

export interface ExtractionOptions {
  maxBytes?: number;
  /** Separate, larger cap for PDF documents (papers are routinely 2–20MB). */
  pdfMaxBytes?: number;
  maxTextChars?: number;
  /** How much text a ladder reads before the cut to `maxTextChars` (at least `maxTextChars`). */
  readTextChars?: number;
  timeoutMs?: number;
  /** Separate, longer budget for the yt-dlp sidecar tier (cold-starting container + subtitle fetches). */
  videoTimeoutMs?: number;
  /** yt-dlp sidecar base URL enabling the deep video/social tier; absent = tier disabled. */
  sidecarURL?: string;
  /** Bearer token sent to the sidecar when one is configured. */
  sidecarToken?: string;
  /** Browser launcher enabling the headless render tier for thin/blocked web pages; absent = tier disabled. */
  browser?: BrowserBindingLike;
  /** Jina Reader API key enabling the reader-service escalation tier; without it the tier is skipped (its anonymous tier bot-blocks Workers IPs). */
  jinaApiKey?: string;
}

export interface ResolvedExtractionOptions {
  maxBytes: number;
  pdfMaxBytes: number;
  maxTextChars: number;
  readTextChars: number;
  timeoutMs: number;
  videoTimeoutMs: number;
  sidecarURL?: string;
  sidecarToken?: string;
  browser?: BrowserBindingLike;
  jinaApiKey?: string;
}

export function resolveExtractionOptions(options: ExtractionOptions = {}): ResolvedExtractionOptions {
  return {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    pdfMaxBytes: options.pdfMaxBytes ?? DEFAULT_PDF_MAX_BYTES,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT,
    readTextChars: Math.max(options.readTextChars ?? DEFAULT_READ_TEXT, options.maxTextChars ?? DEFAULT_MAX_TEXT),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    videoTimeoutMs: options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    sidecarURL: options.sidecarURL,
    sidecarToken: options.sidecarToken,
    browser: options.browser,
    jinaApiKey: options.jinaApiKey,
  };
}

/** Everything a ladder needs besides the request itself. */
export interface LadderContext {
  options: ResolvedExtractionOptions;
}

export function textEnvelope(sourceText: string, kind: SourceKind, fetchedAt: string): SourceEnvelope {
  const hasText = sourceText.length > 0;
  // Pasted text has no file name to fall back on: at worst it is named by its opening words.
  const title = titleFromText(sourceText, { opening: true });
  return {
    originalText: sourceText,
    kind,
    ...(title ? { title } : {}),
    text: sourceText,
    references: [],
    metadata: {},
    accessLevel: hasText ? "full" : "none",
    depthCap: hasText ? "veryDeep" : "saveOnly",
    ...gaps(!hasText && ["Nothing was given to read.", "No source text or URL was supplied"]),
    fetchedAt,
  };
}

const MAX_TEXT_TITLE = 80;

/** How many words a title made from the opening words keeps. */
const OPENING_WORDS = 8;

/**
 * A title for pasted text that came without one: its first line when that
 * is short (a heading, Markdown marks dropped), else its first sentence or
 * the first part of it (up to a comma, colon or dash) when that is short.
 * With `opening` (pasted text, which has no file name to fall back on),
 * else its opening words with "…", so it is named by what it says rather
 * than "Pasted text". Undefined when none of these fits.
 */
export function titleFromText(text: string, { opening = false }: { opening?: boolean } = {}): string | undefined {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  const firstSentence = /^[^.!?\n]+[.!?]?/.exec(trimmed)?.[0]?.trim() ?? "";
  const firstClause = /^[^.!?\n,:;—–]+/.exec(firstSentence)?.[0]?.replace(/\s+-\s+.*$/, "").trim() ?? "";
  // A part of a sentence names the text only when it is a few words, not a lone "However".
  for (const [candidate, fewest] of [[firstLine, 1], [firstSentence, 1], [firstClause, 3]] as const) {
    const clean = candidate.replace(/[.:;,\s]+$/, "");
    if (clean && clean.length <= MAX_TEXT_TITLE && /\p{L}/u.test(clean) && clean.split(/\s+/).length >= fewest) return clean;
  }
  const words = firstLine.split(/\s+/).filter(Boolean);
  if (!opening || !words.some((w) => /\p{L}/u.test(w))) return undefined;
  let start = words.slice(0, OPENING_WORDS).join(" ").replace(/[.:;,\s]+$/, "");
  if (start.length > MAX_TEXT_TITLE) start = start.slice(0, MAX_TEXT_TITLE - 1).replace(/\s+\S*$/, "") || start.slice(0, MAX_TEXT_TITLE - 1);
  return `${start}…`;
}

export function videoTier(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  fetcher: FetchLike,
  assetStore: AssetStore | undefined,
): Promise<ModuleExtraction | undefined> {
  // The sidecar is Open Sourcebook's own program, at the address it is set up with; the source address it is sent is checked.
  const guard = guardOf(fetcher);
  return extractVideoModule({
    url: sourceURL,
    sourceText,
    fetchImpl: fetcher,
    sidecarFetchImpl: guard.unguarded,
    checkAddress: guard.check,
    ...(assetStore ? { assetStore } : {}),
    ...(ctx.options.sidecarURL ? { sidecarURL: ctx.options.sidecarURL } : {}),
    ...(ctx.options.sidecarToken ? { sidecarToken: ctx.options.sidecarToken } : {}),
    // The sidecar runs a real browser-grade extractor on a container that
    // cold-starts; a 20-minute video's subtitle fetch took 83s in production
    // (2026-08-09), so this tier gets its own, much longer budget than the
    // 12s page-fetch default.
    timeoutMs: ctx.options.videoTimeoutMs,
    maxTextChars: ctx.options.maxTextChars,
  });
}

/**
 * Folds a module result into an envelope while preserving the ladder's
 * invariants: original fields and kind are untouched, the original source
 * reference always leads, and access/depth may only rise above what the old
 * fallback ladder would have guaranteed — never drop below it. Uploads have
 * no URL, so sourceURL is optional and the URL-derived fields drop out.
 */
export function mergeModuleResult(ctx: LadderContext, params: {
  result: ModuleExtraction;
  kind: SourceKind;
  sourceText: string;
  sourceURL?: string;
  /** True when the module's text already contains the supplied source text. */
  textIncludesSource: boolean;
  minAccessLevel: AccessLevel;
  minDepthCap: ByteDepth;
  now: () => string;
}): SourceEnvelope {
  const { result, kind, sourceText, sourceURL, now } = params;
  const text = params.textIncludesSource
    ? result.text ?? sourceText
    : [sourceText, result.text].filter(Boolean).join("\n\n").slice(0, ctx.options.maxTextChars).trim();
  return {
    originalText: sourceText,
    ...(sourceURL ? { originalURL: sourceURL } : {}),
    canonicalURL: result.canonicalURL ?? sourceURL,
    kind,
    title: result.title,
    author: result.author,
    sourceDomain: hostname(sourceURL),
    excerpt: result.excerpt,
    text,
    references: sourceURL ? mergeReferences(sourceURL, result.references) : (result.references ?? []),
    ...(result.assets?.length ? { assets: result.assets } : {}),
    metadata: { ...result.metadata },
    accessLevel: maxAccessLevel(result.accessLevel ?? "none", params.minAccessLevel),
    depthCap: maxDepth(result.depthCap ?? "saveOnly", params.minDepthCap),
    limitations: result.limitations ?? [],
    extractionNotes: result.extractionNotes ?? [],
    fetchedAt: now(),
  };
}

export function buildSourceReference(url: string): SourceEnvelope["references"][number] {
  return { url, domain: hostname(url), label: "source" };
}
export const sourceReference = buildSourceReference;

/** The original source reference always leads; module references are deduped by URL. */
export function mergeReferences(sourceURL: string, moduleReferences: SourceReference[] | undefined): SourceReference[] {
  const references = [sourceReference(sourceURL)];
  const seen = new Set([sourceURL]);
  for (const reference of moduleReferences ?? []) {
    if (!isHTTPURL(reference.url) || seen.has(reference.url)) continue;
    seen.add(reference.url);
    references.push(reference);
  }
  return references;
}

/** ACCESS_LEVELS is ordered best → worst. */
export function maxAccessLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return ACCESS_LEVELS.indexOf(a) <= ACCESS_LEVELS.indexOf(b) ? a : b;
}

export function maxDepth(a: ByteDepth, b: ByteDepth): ByteDepth {
  return depthRank(a) >= depthRank(b) ? a : b;
}
export function capForWeb(access: AccessLevel, textLength: number): ByteDepth {
  if (access === "full" && textLength >= 4_000) return "veryDeep";
  if (access === "full") return "deep";
  if (access === "partial") return textLength >= 600 ? "medium" : "light";
  if (access === "metadata") return "tiny";
  return "saveOnly";
}
const ENGINE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OpenSourcebook-Engine/1.0";

/** The plain fetch with the engine's own headers, for Open Sourcebook's own programs (the yt-dlp sidecar) and under the guard. */
export const serviceFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", ENGINE_USER_AGENT);
  if (!headers.has("accept-language")) headers.set("accept-language", "en-US,en;q=0.9");
  return fetch(input, { ...init, headers });
};

/**
 * How a source is read when no fetch is handed in: every address it names, and every hop it redirects to, checked
 * by the engine's guard (`../guard.ts`) first, the names looked up over DNS over HTTPS.
 */
export const defaultFetch: FetchLike = guardedFetch(serviceFetch, { resolve: dohResolver() });

/**
 * Cuts a source's text to what the engines use, at the last paragraph or
 * sentence end before the limit (never mid-word when it can help it), and
 * says so: a limitation in plain words, and `metadata.textChars` (how long
 * the text was), `textUsedChars` (how much is kept) and `textCut: "true"`.
 * `atLeast` is true when the reading itself stopped at its ceiling, so the
 * source is longer still.
 */
export function capSourceText(envelope: SourceEnvelope, maxChars: number, readCeiling: number): SourceEnvelope {
  const full = envelope.text.length;
  if (full <= maxChars) return envelope;
  const used = cutPoint(envelope.text, maxChars);
  const text = envelope.text.slice(0, used).trimEnd();
  const atLeast = full >= readCeiling;
  const share = Math.max(1, Math.floor((text.length / full) * 100));
  const limitation = `Only the first ${grouped(text.length)} of ${atLeast ? "more than " : ""}${grouped(full)} characters of this source are used (about ${share}%); the rest is not read by anything made from it.`;
  return {
    ...envelope,
    text,
    limitations: [...envelope.limitations, limitation],
    extractionNotes: [...(envelope.extractionNotes ?? []), `Source text cut at ${text.length} of ${atLeast ? ">=" : ""}${full} characters`],
    metadata: { ...envelope.metadata, textChars: String(full), textUsedChars: String(text.length), textCut: "true" },
  };
}

/** The last paragraph break, else sentence end, else space, in the final fifth before `max`. */
function cutPoint(text: string, max: number): number {
  const window = text.slice(Math.floor(max * 0.8), max);
  const base = Math.floor(max * 0.8);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0) return base + paragraph;
  const sentence = Math.max(...[". ", "! ", "? ", ".\n"].map((end) => window.lastIndexOf(end)));
  if (sentence >= 0) return base + sentence + 1;
  const space = window.search(/\s\S*$/);
  return space >= 0 ? base + space : max;
}

function grouped(value: number): string {
  return value.toLocaleString("en-US");
}
