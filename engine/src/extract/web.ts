import { boundedFetch, hostname } from "../net";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { type AssetStore } from "../assets";
import { dropPageFurniture } from "./furniture";
import { ReadingGaps } from "./limits";
import { fetchOEmbedFromHTML } from "./oembed";
import {
  type AccessLevel,
  type AssetKind,
  type AssetRef,
  type ByteDepth,
  type FetchLike,
} from "../types";

const MIN_READER_TEXT = 600;
/** Said when a page gives too little text to make much from. */
export const LITTLE_TEXT = "Only a little text could be read from this page.";
const MAX_HARVESTED_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 200;
const JUNK_IMAGE_PATTERN = /logo|icon|avatar|sprite|tracking/i;

/** Docs-Markdown tier bounds: index pages are small, subpages are capped individually. */
const MAX_SUPPLEMENT_PAGES = 2;
const MAX_SUPPLEMENT_CHARS = 10_000;
const MAX_LLMS_INDEX_CHARS = 200_000;
/** A page advertising its documentation index points at a same-origin llms.txt. */
const LLMS_TXT_URL_PATTERN = /https?:\/\/[^\s)\]>"']+\/llms\.txt/i;
/** Index entries whose path contains one of these segments are core docs, not peripheral links. */
const CORE_DOC_SEGMENTS = new Set([
  "get-started",
  "getting-started",
  "quickstart",
  "quick-start",
  "overview",
  "introduction",
  "how-it-works",
  "concepts",
  "guide",
]);
const GITHUB_REPO_PATH_PATTERN = /^\/([\w.-]+)\/([\w.-]+)\/?$/;
/** First path segments on github.com that are site chrome, not user/org names. */
const GITHUB_NON_REPO_OWNERS = new Set([
  "about", "account", "apps", "collections", "contact", "copilot", "customer-stories",
  "enterprise", "events", "explore", "features", "login", "logout", "marketplace", "new",
  "notifications", "orgs", "organizations", "pricing", "readme", "search", "security",
  "settings", "signup", "sponsors", "topics", "trending", "users", "watching",
]);

export type { ModuleExtraction } from "./module";
import type { ModuleExtraction } from "./module";

export interface WebModuleInput {
  url: string;
  sourceText: string;
  fetchImpl: FetchLike;
  assetStore?: AssetStore;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
  /** Pre-rendered page HTML from the browser-render tier; skips the fetch when present. */
  renderedHTML?: string;
}

interface ImageCandidate {
  url: string;
  kind: AssetKind;
  caption?: string;
}

/**
 * Reader-mode web extraction: parses the page with linkedom, runs
 * @mozilla/readability for article text, scrapes OG/meta as a fallback, and
 * harvests article images into the asset store (or keeps remote URLs when no
 * store is bound). Resolves undefined when the page cannot be fetched or is
 * not HTML, so the extraction ladder keeps its existing fallback.
 *
 * Two enrichment tiers sit next to reader mode:
 *
 * - Docs-Markdown tier: sites following the llms.txt convention answer
 *   `Accept: text/markdown` with canonical Markdown. Reader mode strips code
 *   fences, tables, and card grids — the substance of docs pages — so when a
 *   site serves Markdown it wins. A page advertising a same-origin llms.txt
 *   documentation index also yields up to two core subpages (get-started,
 *   concepts, …) as supplemental evidence.
 * - GitHub repo facts: repo roots get stars/forks parsed from the page's own
 *   counter markup, since README text carries no repository stats and the
 *   public API rate-limits datacenter egress IPs. Best effort: when the
 *   counters are absent, the README stands alone.
 *
 * When input.renderedHTML is supplied (browser-render tier), the fetch is
 * skipped and the rendered DOM is parsed instead; relative image URLs still
 * absolutize against the page URL, and metadata.extraction gains a "+render"
 * suffix so the producing tier is identifiable.
 */
export async function extractWebModule(input: WebModuleInput): Promise<ModuleExtraction | undefined> {
  try {
    const rendered = input.renderedHTML !== undefined;
    let html: string;
    let siteMarkdown: string | undefined;
    if (rendered) {
      html = input.renderedHTML!.slice(0, input.maxBytes);
    } else {
      // The Markdown negotiation rides along with the HTML fetch: sites that
      // don't support it answer with HTML (content-type filtered out below).
      const [response, markdownResponse] = await Promise.all([
        boundedFetch(
          input.url,
          input.fetchImpl,
          { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } },
          input.timeoutMs,
        ),
        boundedFetch(
          input.url,
          input.fetchImpl,
          { method: "GET", headers: { accept: "text/markdown" } },
          input.timeoutMs,
        ),
      ]);
      if (!response?.ok) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return undefined;
      html = (await response.text()).slice(0, input.maxBytes);
      siteMarkdown = await readSiteMarkdown(markdownResponse, input.maxTextChars);
    }

    // Readability mutates the document it parses, so meta tags are read from a second parse.
    const readerDoc = parseHTML(html).document;
    // Notes beside the text, navigation, reference lists, footnote marks and
    // back-matter sections are not what the page says (./furniture).
    dropPageFurniture(readerDoc as unknown as Document);
    const reader = new Readability(readerDoc as unknown as Document).parse();
    const { document: metaDoc } = parseHTML(html);

    const ogTitle = metaContent(metaDoc, "og:title");
    const pageDescription = cleanText(reader?.excerpt) ?? metaContent(metaDoc, "og:description") ?? metaContent(metaDoc, "description");
    const pageTitle = cleanText(reader?.title) ?? ogTitle ?? tagText(metaDoc, "title");
    const pageAuthor = cleanText(reader?.byline) ?? metaContent(metaDoc, "author") ?? metaContent(metaDoc, "article:author");
    const canonicalURL = normalizeURL(linkHref(metaDoc, "canonical") ?? metaContent(metaDoc, "og:url"));
    const siteName = cleanText(reader?.siteName) ?? metaContent(metaDoc, "og:site_name");
    const published = metaContent(metaDoc, "article:published_time") ?? cleanText(reader?.publishedTime);
    const schemaType = schemaOrgType(metaDoc);
    // Generic embeds (Vimeo, SoundCloud, Flickr, and any future provider) can
    // publish a standards-based JSON oEmbed link even when no named-platform
    // extractor exists. Keep this best-effort: a missing/broken endpoint must
    // not change the ordinary reader/OG extraction result.
    const oembed = await fetchOEmbedFromHTML(html, input.url, input.fetchImpl, input.timeoutMs);
    // Provider metadata fills only gaps left by the page itself. It does not
    // turn a widget response into readable source text or raise depth.
    const title = pageTitle ?? oembed?.metadata.title;
    const author = pageAuthor ?? oembed?.metadata.authorName;
    const description = pageDescription;
    const ogImage = metaContent(metaDoc, "og:image") ?? oembed?.metadata.thumbnailURL;

    const readerText = cleanText(reader?.textContent, input.maxTextChars) ?? "";
    const readerOK = readerText.length >= MIN_READER_TEXT;
    const sourceText = input.sourceText.trim();

    // Docs-Markdown tier: canonical site Markdown beats reader mode (which
    // strips code fences, tables, and card grids). When the page advertises a
    // same-origin llms.txt documentation index, up to two core subpages join
    // as supplemental evidence. GitHub repo roots get star/fork stats parsed
    // from the page's own counter markup — README text carries none.
    const supplements = siteMarkdown
      ? await fetchLlmsSupplements(input.url, siteMarkdown, input.fetchImpl, input.timeoutMs)
      : [];
    const repoFacts = parseGitHubRepoFacts(html, input.url);
    const docsText = siteMarkdown
      ? [siteMarkdown, ...supplements.map(formatSupplement)].join("\n\n---\n\n")
      : undefined;

    const primaryText = docsText ?? readerText;
    const primaryOK = primaryText.length >= MIN_READER_TEXT;
    const text = [sourceText, repoFacts, primaryText].filter(Boolean).join("\n\n").slice(0, input.maxTextChars).trim();

    const accessLevel: AccessLevel = primaryOK ? "full" : sourceText || title || description ? "partial" : "metadata";
    const candidates = collectImageCandidates(reader?.content, input.url, ogImage);
    const assets = await harvestImages(candidates, input);

    // How the page was read is a note for the logs; only what is missing is said to the person.
    const gaps = new ReadingGaps().note(
      docsText
        ? "Site-served Markdown extraction excludes scripts, styles, and authenticated content"
        : "Reader-mode extraction excludes scripts, styles, and authenticated content",
    );
    if (oembed) gaps.note("oEmbed metadata is provider-supplied; its HTML is preserved for the client embed renderer");
    if (supplements.length > 0) {
      gaps.note(`Included ${supplements.length} core subpage(s) advertised by the site's documentation index`);
    }
    if (rendered) gaps.note("Page HTML was rendered in a headless browser before parsing");
    if (!docsText && !reader) {
      gaps.add(
        "Only the page's title, description and preview picture could be read.",
        "Reader-mode parsing found no article; only page metadata and the preview image were used",
      );
    } else if (!primaryOK) {
      gaps.add(LITTLE_TEXT, "The page exposed limited readable text");
    }
    if (gitHubRepoSlug(input.url) && !repoFacts) gaps.note("GitHub repository statistics were unavailable");

    return {
      text: text || undefined,
      title,
      author,
      canonicalURL,
      excerpt: description ?? (primaryText ? primaryText.slice(0, 500) : undefined),
      metadata: {
        extraction: `${docsText ? `site-markdown${supplements.length ? "+llms-index" : ""}` : readerOK ? "readability" : reader ? "readability-thin+og" : "og-meta"}${rendered ? "+render" : ""}${repoFacts ? "+repo-stats" : ""}${oembed ? "+oembed" : ""}`,
        ...(siteName ? { siteName } : {}),
        ...(published ? { published } : {}),
        ...(schemaType ? { schemaType } : {}),
        ...(oembed ? { oembedEndpoint: oembed.endpoint, oembedJSON: JSON.stringify(oembed.metadata) } : {}),
        images: String(assets.length),
      },
      assets,
      references: [
        { url: input.url, domain: hostname(input.url), label: "source" },
        ...supplements.map((supplement) => ({
          url: supplement.url,
          ...(supplement.title ? { title: supplement.title } : {}),
          domain: hostname(supplement.url),
          label: "supplemental" as const,
          relation: "llms-index",
        })),
      ],
      accessLevel,
      depthCap: capForWeb(accessLevel, primaryText.length),
      ...gaps.fields(),
    };
  } catch {
    return undefined;
  }
}

/** Picks article images (plus the OG preview as a leading thumbnail), capped and junk-filtered. */
function collectImageCandidates(readerContent: string | null | undefined, pageURL: string, ogImage: string | undefined): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined, kind: AssetKind, caption?: string) => {
    if (!raw || raw.trim().startsWith("data:")) return;
    const absolute = absoluteURL(raw, pageURL);
    if (!absolute || seen.has(absolute)) return;
    seen.add(absolute);
    candidates.push({ url: absolute, kind, ...(caption ? { caption } : {}) });
  };

  push(ogImage, "thumbnail");
  if (readerContent) {
    const { document: contentDoc } = parseHTML(readerContent);
    for (const img of Array.from(contentDoc.querySelectorAll("img"))) {
      const raw = bestFromSrcset(img.getAttribute("srcset")) ?? img.getAttribute("src");
      if (!raw || raw.trim().startsWith("data:")) continue;
      if (isSmallImage(img.getAttribute("width"), img.getAttribute("height"))) continue;
      if (JUNK_IMAGE_PATTERN.test(raw)) continue;
      const figure = img.closest("figure");
      const caption = cleanText(figure?.querySelector("figcaption")?.textContent) ?? cleanText(img.getAttribute("alt"));
      push(raw, "image", caption);
    }
  }
  return candidates.slice(0, MAX_HARVESTED_IMAGES);
}

/**
 * Persists candidates through the asset store, bounded to 5MB image/* bodies.
 * Without a store (or when a store without a bucket resolves undefined) the
 * remote absolute URL is kept instead. Images that fail to fetch are dropped.
 */
async function harvestImages(candidates: ImageCandidate[], input: WebModuleInput): Promise<AssetRef[]> {
  if (!input.assetStore) return candidates.map((candidate) => remoteImageRef(candidate, input.url));
  const store = input.assetStore;
  const harvested = await Promise.all(candidates.map(async (candidate): Promise<AssetRef | undefined> => {
    try {
      const response = await boundedFetch(candidate.url, input.fetchImpl, { method: "GET", headers: { accept: "image/*" } }, input.timeoutMs);
      if (!response?.ok) return undefined;
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("image/")) return undefined;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return undefined;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
      const stored = await store.putAsset(bytes, {
        kind: candidate.kind,
        sourceURL: input.url,
        caption: candidate.caption,
        contentType,
      });
      return stored ?? remoteImageRef(candidate, input.url);
    } catch {
      return undefined;
    }
  }));
  return harvested.filter((ref): ref is AssetRef => Boolean(ref));
}

function remoteImageRef(candidate: ImageCandidate, pageURL: string): AssetRef {
  return {
    id: candidate.url,
    kind: candidate.kind,
    url: candidate.url,
    sourceURL: pageURL,
    ...(candidate.caption ? { caption: candidate.caption } : {}),
  };
}

/** Picks the highest-density/largest candidate out of a srcset attribute. */
function bestFromSrcset(srcset: string | null | undefined): string | undefined {
  if (!srcset) return undefined;
  let best: string | undefined;
  let bestScore = -1;
  for (const part of srcset.split(",")) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url || url.startsWith("data:")) continue;
    let score = 1;
    if (descriptor) {
      const value = Number.parseFloat(descriptor);
      // Density descriptors outrank width descriptors only when widths are absent.
      if (Number.isFinite(value)) score = descriptor.endsWith("x") ? value * 1000 : value;
    }
    if (score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

/** Treats images with explicit sub-200px dimensions as trackers or chrome. */
function isSmallImage(width: string | null, height: string | null): boolean {
  for (const value of [width, height]) {
    if (value === null || value === "") continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < MIN_IMAGE_DIMENSION) return true;
  }
  return false;
}

interface DocsSupplement {
  url: string;
  title?: string;
  text: string;
}

function formatSupplement(supplement: DocsSupplement): string {
  return `Supplementary documentation — ${supplement.title ?? supplement.url} (${supplement.url}):\n${supplement.text}`;
}

/** Reads a content-negotiated Markdown response; undefined when the site answered with anything else. */
async function readSiteMarkdown(response: Response | undefined, maxChars: number): Promise<string | undefined> {
  try {
    if (!response?.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(x-)?markdown/i.test(contentType)) return undefined;
    const body = stripMarkdownFrontmatter(await response.text());
    const cleaned = body.replace(/\n{3,}/g, "\n\n").trim();
    return cleaned ? cleaned.slice(0, maxChars) : undefined;
  } catch {
    return undefined;
  }
}

/** Strips a leading YAML frontmatter block (--- ... ---) from Markdown text. */
function stripMarkdownFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

/**
 * Follows the page's advertised llms.txt documentation index and fetches up
 * to MAX_SUPPLEMENT_PAGES core subpages as Markdown. Links are restricted to
 * the source's origin and first path segment (the saved product's docs), the
 * source page itself is skipped, and core sections (get-started, concepts, …)
 * outrank peripheral links while index order breaks ties. Never throws — a
 * missing or unusable index simply yields no supplements.
 */
async function fetchLlmsSupplements(
  pageURL: string,
  pageMarkdown: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DocsSupplement[]> {
  try {
    const indexURL = LLMS_TXT_URL_PATTERN.exec(pageMarkdown)?.[0];
    if (!indexURL || !sameOrigin(indexURL, pageURL)) return [];
    const response = await boundedFetch(indexURL, fetchImpl, { method: "GET", headers: { accept: "text/markdown, text/plain" } }, timeoutMs);
    if (!response?.ok) return [];
    const index = (await response.text()).slice(0, MAX_LLMS_INDEX_CHARS);

    const prefix = firstPathSegment(pageURL);
    const selfKey = docURLKey(pageURL);
    const seen = new Set<string>(selfKey ? [selfKey] : []);
    const candidates: Array<{ url: string; title?: string; coreAt: number; order: number }> = [];
    const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let match: RegExpExecArray | null;
    let order = 0;
    while ((match = linkPattern.exec(index)) !== null) {
      order += 1;
      const url = match[2];
      if (!sameOrigin(url, pageURL)) continue;
      if (!prefix || firstPathSegment(url) !== prefix) continue;
      const key = docURLKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const coreAt = pathSegments(url).findIndex((segment) => CORE_DOC_SEGMENTS.has(segment));
      candidates.push({
        url,
        ...(match[1] ? { title: match[1] } : {}),
        coreAt: coreAt === -1 ? Number.MAX_SAFE_INTEGER : coreAt,
        order,
      });
    }
    // Core docs first; among them, a core segment closer to the product root
    // (/workers/get-started/guide) beats a nested feature's own get-started
    // (/workers/testing/miniflare/get-started); index order breaks ties.
    candidates.sort((a, b) => a.coreAt - b.coreAt || a.order - b.order);
    const picks = candidates.slice(0, MAX_SUPPLEMENT_PAGES);

    const pages = await Promise.all(
      picks.map(async (pick): Promise<DocsSupplement | undefined> => {
        const pageResponse = await boundedFetch(pick.url, fetchImpl, { method: "GET", headers: { accept: "text/markdown" } }, timeoutMs);
        if (!pageResponse?.ok) return undefined;
        const contentType = pageResponse.headers.get("content-type") ?? "";
        if (!/text\/(x-)?markdown|text\/plain/i.test(contentType)) return undefined;
        const body = stripMarkdownFrontmatter(await pageResponse.text()).replace(/\n{3,}/g, "\n\n").trim();
        if (!body) return undefined;
        return { url: pick.url, ...(pick.title ? { title: pick.title } : {}), text: body.slice(0, MAX_SUPPLEMENT_CHARS) };
      }),
    );
    return pages.filter((page): page is DocsSupplement => Boolean(page));
  } catch {
    return [];
  }
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** First path segment ("/workers/get-started" → "workers"); undefined at the root. */
function firstPathSegment(url: string): string | undefined {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Trailing index markers are dropped so /workers/, /workers/index.md, and /workers.md compare equal. */
function docURLKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/(index\.md)?$/, "").replace(/\.md$/, "").toLowerCase();
    return `${parsed.origin}${path}`;
  } catch {
    return undefined;
  }
}

function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/** "owner/repo" for github.com repo roots; undefined for any other page. */
function gitHubRepoSlug(pageURL: string): string | undefined {
  try {
    const url = new URL(pageURL);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const match = GITHUB_REPO_PATH_PATTERN.exec(url.pathname);
    if (!match || GITHUB_NON_REPO_OWNERS.has(match[1].toLowerCase())) return undefined;
    return `${match[1]}/${match[2]}`;
  } catch {
    return undefined;
  }
}

/**
 * Repository facts from the repo page's own counter markup, rendered as one
 * compact evidence paragraph. The public GitHub API rate-limits datacenter
 * egress IPs, but the server-rendered page always carries exact star/fork
 * counts — aria-label or title hold the unrounded number. Best effort: a
 * markup redesign resolves undefined and the caller notes the stats gap in
 * its extraction notes.
 */
function parseGitHubRepoFacts(html: string, pageURL: string): string | undefined {
  const slug = gitHubRepoSlug(pageURL);
  if (!slug) return undefined;
  const stars = repoCounter(html, "repo-stars-counter-star");
  const forks = repoCounter(html, "repo-network-counter");
  if (stars === undefined && forks === undefined) return undefined;
  const stats: string[] = [];
  if (stars !== undefined) stats.push(`Stars: ${stars}`);
  if (forks !== undefined) stats.push(`Forks: ${forks}`);
  return `Repository facts from the GitHub page: ${slug}. ${stats.join(". ")}.`;
}

/** Exact count from a repo-page counter element; aria-label and title carry the unrounded number. */
function repoCounter(html: string, id: string): number | undefined {
  const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(html)?.[0];
  if (!tag) return undefined;
  const raw = /aria-label="([\d,]+)/.exec(tag)?.[1] ?? /title="([\d,]+)"/.exec(tag)?.[1];
  if (!raw) return undefined;
  const value = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : undefined;
}

function capForWeb(access: AccessLevel, textLength: number): ByteDepth {
  if (access === "full" && textLength >= 4_000) return "veryDeep";
  if (access === "full") return "deep";
  if (access === "partial") return textLength >= 600 ? "medium" : "light";
  if (access === "metadata") return "tiny";
  return "saveOnly";
}

function metaContent(doc: { querySelector(selector: string): unknown }, key: string): string | undefined {
  const element = doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`) as {
    getAttribute(name: string): string | null;
  } | null;
  return cleanText(element?.getAttribute("content"));
}

/**
 * schema.org JSON-LD sniffing: recipe pages declare a Recipe node in an
 * application/ld+json script — top-level, in an array, or inside @graph. The
 * declared @type lets the extraction ladder specialize generic web kinds
 * (e.g. recipe guidance firing for recipe pages). Only Recipe is recognized
 * today; add more types here when a kind needs them.
 */
function schemaOrgType(doc: { querySelectorAll(selector: string): unknown }): string | undefined {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts as ArrayLike<{ textContent?: string | null }>)) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue; // malformed JSON-LD is common in the wild; it is not evidence
    }
    if (containsSchemaType(data, "recipe")) return "Recipe";
  }
  return undefined;
}

function containsSchemaType(node: unknown, wanted: string, depth = 0): boolean {
  if (!node || typeof node !== "object" || depth > 6) return false;
  if (Array.isArray(node)) return node.some((entry) => containsSchemaType(entry, wanted, depth + 1));
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string" && type.toLowerCase() === wanted) return true;
  if (Array.isArray(type) && type.some((entry) => typeof entry === "string" && entry.toLowerCase() === wanted)) return true;
  return containsSchemaType(record["@graph"], wanted, depth + 1);
}

function linkHref(doc: { querySelector(selector: string): unknown }, rel: string): string | undefined {
  const element = doc.querySelector(`link[rel="${rel}"]`) as { getAttribute(name: string): string | null } | null;
  return cleanText(element?.getAttribute("href"));
}

function tagText(doc: { querySelector(selector: string): unknown }, tag: string): string | undefined {
  const element = doc.querySelector(tag) as { textContent: string | null } | null;
  return cleanText(element?.textContent ?? undefined);
}

function cleanText(value: string | null | undefined, maxLength = 2_000): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function absoluteURL(raw: string, baseURL: string): string | undefined {
  try {
    const url = new URL(raw, baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

