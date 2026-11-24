import { hostname } from "../net";
import {
  type AccessLevel,
  type ByteDepth,
  type FetchLike,
} from "../types";

export type { ModuleExtraction } from "./module";
import { titleFromText } from "./context";
import { gaps } from "./limits";
import type { ModuleExtraction } from "./module";

export interface PlainModuleInput {
  url: string;
  contentType: string;
  sourceText: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export async function extractPlainModule(input: PlainModuleInput): Promise<ModuleExtraction | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs || DEFAULT_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await input.fetchImpl(input.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) return undefined;
    const raw = (await response.text()).slice(0, input.maxBytes);
    const read = readPlainText(raw, { name: input.url, contentType: input.contentType, sourceText: input.sourceText, maxTextChars: input.maxTextChars });
    if (!read) return undefined;
    return {
      ...read,
      canonicalURL: input.url,
      references: [{ url: input.url, domain: hostname(input.url), label: "source" }],
    };
  } catch {
    return undefined;
  }
}

/**
 * Shapes raw text (Markdown, plain text, CSV, JSON, XML, feeds) into a module
 * result. `name` is a URL or file name, read only for its extension. Used for
 * a fetched data link and for an uploaded text file alike; undefined when the
 * text is blank.
 */
export function readPlainText(
  raw: string,
  input: { name: string; contentType: string; sourceText: string; maxTextChars: number },
): ModuleExtraction | undefined {
  if (!raw.trim()) return undefined;
  const format = detectFormat(input.name, input.contentType, raw);
  const shaped = shape(format, raw, input.maxTextChars);
  const text = [input.sourceText, shaped.text].filter(Boolean).join("\n\n").trim();
  return {
    text,
    title: shaped.title,
    excerpt: shaped.excerpt,
    references: [],
    metadata: { extraction: `plain-${format}`, ...(shaped.meta ?? {}) },
    // All of it was read unless a gap the person should know about says otherwise; length alone never makes it partial.
    accessLevel: !text ? "metadata" : shaped.gapLines.some(([plain]) => plain) ? "partial" : "full",
    depthCap: capForLength(text.length),
    ...gaps(...shaped.gapLines),
  };
}

type PlainFormat = "json" | "rss" | "atom" | "xml" | "sitemap" | "robots" | "csv" | "markdown" | "text";

function detectFormat(url: string, contentType: string, raw: string): PlainFormat {
  const type = contentType.toLowerCase();
  const path = url.toLowerCase().split(/[?#]/)[0];
  if (type.includes("json")) return "json";
  if (type.includes("rss")) return "rss";
  if (type.includes("atom")) return "atom";
  if (type.includes("csv")) return "csv";
  if (type.includes("tab-separated")) return "csv";
  if (type.includes("markdown")) return "markdown";
  if (type.includes("xml")) return "xml";
  if (path.endsWith("/robots.txt")) return "robots";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".csv") || path.endsWith(".tsv")) return "csv";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  if (path.endsWith(".xml") || path.endsWith(".rss") || path.endsWith(".atom")) return "xml";
  // Sniff the payload when the headers are vague.
  const head = raw.trimStart().slice(0, 400);
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (/<feed[\s>]/i.test(head)) return "atom";
  if (/<rss[\s>]/i.test(head)) return "rss";
  if (/<urlset[\s>]|<sitemapindex[\s>]/i.test(head)) return "sitemap";
  if (/^user-agent\s*:/im.test(head)) return "robots";
  if (/<\?xml/i.test(head)) return "xml";
  if (/^#\s|\n##?\s/m.test(head)) return "markdown";
  return "text";
}

interface Shaped {
  text: string;
  title?: string;
  excerpt?: string;
  meta?: Record<string, string>;
  /** [plain line or undefined for a note only, technical note] */
  gapLines: Array<[string | undefined, string]>;
}

function shape(format: PlainFormat, raw: string, maxTextChars: number): Shaped {
  switch (format) {
    case "json":
      return shapeJson(raw, maxTextChars);
    case "rss":
    case "atom":
      return shapeFeed(raw, format);
    case "sitemap":
      return shapeSitemap(raw);
    case "robots":
      return { text: raw.slice(0, maxTextChars), title: "robots.txt", gapLines: [], meta: { directives: String(countLines(raw, /^(allow|disallow)\s*:/im)) } };
    case "csv":
      return shapeCsv(raw, maxTextChars);
    case "markdown": {
      const title = markdownHeading(raw) ?? titleFromText(raw);
      return { text: raw.slice(0, maxTextChars), ...(title ? { title } : {}), gapLines: cutLines(raw, maxTextChars) };
    }
    case "text": {
      const title = titleFromText(raw);
      return { text: raw.slice(0, maxTextChars), ...(title ? { title } : {}), gapLines: cutLines(raw, maxTextChars) };
    }
    case "xml":
    default:
      return { text: raw.slice(0, maxTextChars), gapLines: cutLines(raw, maxTextChars) };
  }
}

/** The gap line for text longer than what is read of it; none when it fits. */
function cutLines(raw: string, maxTextChars: number): Shaped["gapLines"] {
  if (raw.length <= maxTextChars) return [];
  return [["Only the start of this file was read; it is too long to read whole.", `Plain text cut at ${maxTextChars} of ${raw.length} characters`]];
}

const MAX_HEADING_TITLE = 80;

/** A Markdown file's first `#` heading (any level), marks dropped, when it is short enough to be a name. */
function markdownHeading(raw: string): string | undefined {
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(raw)?.[1]?.replace(/[*_`]/g, "").trim();
  return heading && heading.length <= MAX_HEADING_TITLE && /\p{L}/u.test(heading) ? heading : undefined;
}

function shapeJson(raw: string, maxTextChars: number): Shaped {
  try {
    const value = JSON.parse(raw) as unknown;
    const lines: string[] = [];
    if (Array.isArray(value)) {
      lines.push(`JSON array with ${value.length} item(s).`);
      for (const entry of value.slice(0, 20)) lines.push(summarizeValue(entry));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      lines.push(`JSON object with ${entries.length} top-level field(s).`);
      for (const [key, entry] of entries.slice(0, 40)) lines.push(`${key}: ${summarizeValue(entry)}`);
    } else {
      lines.push(String(value));
    }
    const summary = lines.join("\n");
    return {
      text: `${summary}\n\nRaw content (truncated):\n${raw.slice(0, Math.max(1_000, maxTextChars - summary.length - 60))}`.slice(0, maxTextChars),
      excerpt: summary.slice(0, 500),
      gapLines: [],
      meta: { jsonShape: Array.isArray(value) ? "array" : typeof value },
    };
  } catch {
    return { text: raw.slice(0, maxTextChars), gapLines: [[undefined, "JSON payload did not parse cleanly; raw text preserved"]], meta: { jsonShape: "unparsed" } };
  }
}

function shapeFeed(raw: string, format: "rss" | "atom"): Shaped {
  const items: string[] = [];
  const entryPattern = format === "rss" ? /<item[\s>]([\s\S]*?)<\/item>/gi : /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(raw)) !== null && items.length < 40) {
    const body = match[1];
    const title = tagText(body, "title") ?? "(untitled)";
    const date = tagText(body, "pubDate") ?? tagText(body, "published") ?? tagText(body, "updated");
    items.push(`- ${title}${date ? ` (${date})` : ""}`);
  }
  const channelTitle = tagText(raw, "title") ?? "Feed";
  const text = `${channelTitle}\n${items.length} entr${items.length === 1 ? "y" : "ies"}:\n${items.join("\n")}`;
  return {
    text,
    title: channelTitle,
    excerpt: items.slice(0, 5).join(" • "),
    meta: { entries: String(items.length), feedFormat: format },
    gapLines: items.length === 0 ? [["This feed has no entries.", "The feed exposed no entries"]] : [],
  };
}

function shapeSitemap(raw: string): Shaped {
  const urls = [...raw.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  const host = urls[0] ? hostname(urls[0]) : undefined;
  const text = `Sitemap with ${urls.length} URL(s)${host ? ` for ${host}` : ""}:\n${urls.slice(0, 50).join("\n")}${urls.length > 50 ? `\n…and ${urls.length - 50} more` : ""}`;
  return {
    text,
    title: host ? `Sitemap — ${host}` : "Sitemap",
    excerpt: `${urls.length} URLs`,
    meta: { urlCount: String(urls.length) },
    gapLines: [],
  };
}

function shapeCsv(raw: string, maxTextChars: number): Shaped {
  const delimiter = raw.includes("\t") && !raw.slice(0, 2_000).includes(",") ? "\t" : ",";
  const rows = raw.split(/\r?\n/).filter((line) => line.trim());
  const header = rows[0] ?? "";
  const columns = header.split(delimiter).map((c) => c.trim()).filter(Boolean);
  const preview = rows.slice(0, 40).join("\n");
  const text = `Table with ${Math.max(rows.length - 1, 0)} row(s) and ${columns.length} column(s): ${columns.join(", ")}\n\n${preview}`.slice(0, maxTextChars);
  return {
    text,
    excerpt: `${rows.length - 1} rows × ${columns.length} columns`,
    meta: { rows: String(Math.max(rows.length - 1, 0)), columns: String(columns.length), delimiter: delimiter === "\t" ? "tab" : "comma" },
    gapLines: rows.length > 40
      ? [[`Only the first 40 of this table's ${rows.length - 1} rows were read.`, `Only the first 40 rows are included in the extraction preview (${rows.length - 1} total)`]]
      : [],
  };
}

function tagText(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match?.[1]) return undefined;
  const cleaned = match[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item(s)]`;
  if (typeof value === "object") return `{${Object.keys(value as object).slice(0, 8).join(", ")}}`;
  return String(value);
}

function countLines(text: string, pattern: RegExp): number {
  return text.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

function capForLength(length: number): ByteDepth {
  if (length >= 30_000) return "veryDeep";
  if (length >= 4_000) return "deep";
  if (length >= 600) return "medium";
  if (length > 0) return "light";
  return "saveOnly";
}

