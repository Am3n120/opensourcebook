import type { FetchLike, PaperMetadataProvider, SourceEnvelope } from "../types";
import { isRecord, sleep } from "../net";

export interface OpenAlexProviderOptions {
  baseURL?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Test hook: override the 429 retry delay (production default 5s). */
  retryDelayMs?: number;
  /** Contact email for the OpenAlex polite pool (mailto param) — much higher rate limits. */
  mailto?: string;
}

export interface OpenAlexReference {
  url: string;
}

export interface OpenAlexEnrichment {
  workURL?: string;
  title: string;
  doiURL?: string;
  landingPageURL?: string;
  publicationYear?: number;
  authors: string[];
  venue?: string;
  citedByCount?: number;
  referenceCount: number;
  references: OpenAlexReference[];
}

interface OpenAlexWorkRecord {
  id?: unknown;
  title?: unknown;
  doi?: unknown;
  publication_year?: unknown;
  cited_by_count?: unknown;
  referenced_works?: unknown;
  authorships?: unknown;
  primary_location?: unknown;
  host_venue?: unknown;
  locations?: unknown;
}

const DEFAULT_BASE_URL = "https://api.openalex.org";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 20_000];
const RETRY_DELAY_MULTIPLIERS = [1, 4];
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Best-effort metadata access to the public OpenAlex Works API. It has no
 * credential or paid tier: failures resolve through the research stage rather
 * than preventing a source from being taught from its original evidence.
 */
export class OpenAlexProvider implements PaperMetadataProvider {
  readonly name = "openalex";
  private readonly baseURL: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly mailto?: string;

  constructor(options: OpenAlexProviderOptions = {}) {
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? RATE_LIMIT_RETRY_DELAYS_MS[0];
    this.mailto = options.mailto?.trim() || undefined;
  }

  /** Looks up a paper by OpenAlex/DOI/arXiv identity, then by its title. */
  async enrich(source: SourceEnvelope): Promise<OpenAlexEnrichment | undefined> {
    const identifiers = sourceIdentifiers(source);
    for (const identifier of identifiers) {
      const work = await this.fetchWork(identifier);
      if (work) {
        const enrichment = normalizeWork(work);
        if (enrichment) return enrichment;
      }
    }

    const title = titleForSearch(source);
    if (!title) return undefined;
    const results = await this.searchWorks(title);
    const match = selectTitleMatch(results, title);
    return match ? normalizeWork(match) : undefined;
  }

  private async fetchWork(identifier: string): Promise<OpenAlexWorkRecord | undefined> {
    const endpoint = `${this.baseURL}/works/${encodeURIComponent(identifier)}`;
    const payload = await this.fetchJSON(endpoint, true);
    return isRecord(payload) ? (payload as OpenAlexWorkRecord) : undefined;
  }

  private async searchWorks(title: string): Promise<OpenAlexWorkRecord[]> {
    const endpoint = new URL(`${this.baseURL}/works`);
    endpoint.searchParams.set("search", title);
    endpoint.searchParams.set("per-page", "5");
    const payload = await this.fetchJSON(endpoint.toString(), false);
    if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
    return payload.results.filter(isRecord) as OpenAlexWorkRecord[];
  }

  private async fetchJSON(endpoint: string, allowNotFound: boolean): Promise<unknown> {
    // Shared datacenter egress IPs hit OpenAlex's anonymous rate limit often
    // (observed as sustained 429 from Workers in production, 2026-08-10); two
    // delayed retries ride out short windows. The durable fix is the polite
    // pool (mailto param), pending a contact email to register.
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.fetchJSONOnce(endpoint, allowNotFound);
      } catch (error) {
        const retryable = error instanceof OpenAlexProviderError && (error.status === 429 || error.code === "NETWORK");
        if (!retryable || attempt === RATE_LIMIT_RETRY_DELAYS_MS.length) throw error;
        await sleep(this.retryDelayMs * RETRY_DELAY_MULTIPLIERS[attempt]);
      }
    }
    throw new OpenAlexProviderError("OpenAlex request failed", "NETWORK");
  }

  private async fetchJSONOnce(endpoint: string, allowNotFound: boolean): Promise<unknown> {
    // Polite pool: identifying with a contact email gets a dedicated, much
    // higher rate limit — anonymous shared-IP egress was 429ing in prod.
    const url = new URL(endpoint);
    if (this.mailto) url.searchParams.set("mailto", this.mailto);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "OpenSourcebook-Engine/1.0 (OpenAlex paper metadata)",
        },
        signal: controller.signal,
      });
      if (allowNotFound && response.status === 404) return undefined;
      if (!response.ok) {
        throw new OpenAlexProviderError(`OpenAlex request failed (${response.status})`, "UPSTREAM_HTTP", response.status);
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_CHARS) {
        throw new OpenAlexProviderError("OpenAlex response exceeded the metadata limit", "RESPONSE_TOO_LARGE");
      }
      try {
        return JSON.parse(body) as unknown;
      } catch (cause) {
        throw new OpenAlexProviderError("OpenAlex returned invalid JSON", "INVALID_JSON", undefined, cause);
      }
    } catch (cause) {
      if (cause instanceof OpenAlexProviderError) throw cause;
      const message = cause instanceof Error && cause.name === "AbortError" ? "OpenAlex request timed out" : "OpenAlex request failed";
      throw new OpenAlexProviderError(message, "NETWORK", undefined, cause);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenAlexProviderError extends Error {
  constructor(
    message: string,
    readonly code: "UPSTREAM_HTTP" | "RESPONSE_TOO_LARGE" | "INVALID_JSON" | "NETWORK",
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenAlexProviderError";
  }
}

export function createOpenAlexProvider(options: OpenAlexProviderOptions = {}): OpenAlexProvider {
  return new OpenAlexProvider(options);
}

function sourceIdentifiers(source: SourceEnvelope): string[] {
  const candidates: string[] = [];
  const urls = [source.originalURL, source.canonicalURL, ...source.references.map((reference) => reference.url)].filter(
    (value): value is string => typeof value === "string",
  );
  for (const url of urls) {
    const openAlexID = openAlexIdentifier(url);
    if (openAlexID) candidates.push(openAlexID);
    const doi = doiFromURL(url);
    if (doi) candidates.push(`https://doi.org/${doi}`);
    const arxiv = arxivIdentifier(url);
    if (arxiv) candidates.push(`https://arxiv.org/abs/${arxiv}`);
  }
  return [...new Set(candidates)];
}

function normalizeWork(work: OpenAlexWorkRecord): OpenAlexEnrichment | undefined {
  const title = cleanString(work.title, 500);
  if (!title) return undefined;

  const authors = Array.isArray(work.authorships)
    ? work.authorships
        .map((entry) => (isRecord(entry) && isRecord(entry.author) ? cleanString(entry.author.display_name, 250) : undefined))
        .filter((entry): entry is string => Boolean(entry))
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .slice(0, 20)
    : [];
  const primaryLocation = isRecord(work.primary_location) ? work.primary_location : undefined;
  const primarySource = primaryLocation && isRecord(primaryLocation.source) ? primaryLocation.source : undefined;
  const hostVenue = isRecord(work.host_venue) ? work.host_venue : undefined;
  const venue = cleanString(primarySource?.display_name, 300) ?? cleanString(hostVenue?.display_name, 300);
  const locations = Array.isArray(work.locations) ? work.locations : [];
  const landingPageURL = firstHTTPURL([
    primaryLocation?.landing_page_url,
    primaryLocation?.pdf_url,
    ...locations.map((entry) => (isRecord(entry) ? entry.landing_page_url : undefined)),
  ]);
  const doiURL = normalizeDOIURL(work.doi);
  const workURL = normalizeOpenAlexURL(work.id);
  const publicationYear = finiteInteger(work.publication_year);
  const citedByCount = finiteInteger(work.cited_by_count);
  const referencedWorks = Array.isArray(work.referenced_works)
    ? work.referenced_works
        .map((reference) => normalizeOpenAlexURL(reference))
        .filter((reference): reference is string => Boolean(reference))
        .filter((reference, index, all) => all.indexOf(reference) === index)
    : [];

  return {
    ...(workURL ? { workURL } : {}),
    title,
    ...(doiURL ? { doiURL } : {}),
    ...(landingPageURL ? { landingPageURL } : {}),
    ...(publicationYear !== undefined ? { publicationYear } : {}),
    authors,
    ...(venue ? { venue } : {}),
    ...(citedByCount !== undefined ? { citedByCount } : {}),
    referenceCount: referencedWorks.length,
    references: referencedWorks.slice(0, 20).map((url) => ({ url })),
  };
}

function selectTitleMatch(results: OpenAlexWorkRecord[], title: string): OpenAlexWorkRecord | undefined {
  const target = titleKey(title);
  if (!target) return undefined;
  const exact = results.find((result) => titleKey(result.title) === target);
  if (exact) return exact;

  // OpenAlex search is fuzzy. Require strong token overlap before accepting a
  // result so a generic paper title cannot silently enrich from the wrong work.
  let best: { result: OpenAlexWorkRecord; score: number } | undefined;
  for (const result of results) {
    const candidate = titleKey(result.title);
    if (!candidate) continue;
    const score = titleOverlap(target, candidate);
    if (!best || score > best.score) best = { result, score };
  }
  return best && best.score >= 0.8 ? best.result : undefined;
}

function titleForSearch(source: SourceEnvelope): string | undefined {
  const explicit = cleanString(source.title, 500);
  if (explicit) return explicit;
  const firstLine = source.text
    .split(/\n+/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length >= 8);
  return cleanString(firstLine, 300);
}

function titleKey(value: unknown): string {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function titleOverlap(a: string, b: string): number {
  const left = new Set(a.split(" ").filter((token) => token.length > 2));
  const right = new Set(b.split(" ").filter((token) => token.length > 2));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function openAlexIdentifier(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/(^|\.)openalex\.org$/i.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/\/(W\d+)\/?$/i);
    return match ? `https://openalex.org/${match[1].toUpperCase()}` : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOpenAlexURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/(?:openalex\.org|api\.openalex\.org\/works)[/:]+(W\d+)/i);
  return match ? `https://openalex.org/${match[1].toUpperCase()}` : undefined;
}

function doiFromURL(value: string): string | undefined {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the original URL when it contains malformed percent escapes.
  }
  const match = decoded.match(/(?:doi\.org\/|doi:\s*|\/doi\/[^/]*\/)(10\.\d{4,9}\/[\-._;()/:A-Z0-9]+)/i);
  if (!match) return undefined;
  return match[1].replace(/[.,;:!?)}\]]+$/, "");
}

function normalizeDOIURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const doi = doiFromURL(value) ?? (value.startsWith("10.") ? value : undefined);
  return doi ? `https://doi.org/${doi}` : undefined;
}

function arxivIdentifier(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,6}(?:v\d+)?)(?:\.pdf)?\/?$/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function firstHTTPURL(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {
      // Ignore malformed location fields from upstream metadata.
    }
  }
  return undefined;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0 ? value : undefined;
}

