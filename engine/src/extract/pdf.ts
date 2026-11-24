import { boundedFetch, hostname } from "../net";
import { extractImages, getDocumentProxy, getMeta } from "unpdf";
import type { AssetStore } from "../assets";
import { PAGE_BREAK, type AccessLevel, type AssetRef, type ByteDepth, type FetchLike, type SourceReference } from "../types";

const MAX_FIGURES = 8;
/** Embedded images below this many raw pixel bytes are usually icons or rendering artifacts. */
const MIN_FIGURE_BYTES = 10_000;
/** Single decoded images above this many raw bytes are skipped (never PNG-encoded/persisted). */
const MAX_FIGURE_RAW_BYTES = 24 * 1024 * 1024;
/** Once this many raw decoded bytes accumulate, the page walk stops (unpdf decodes eagerly; pdf.js caches per-page decoded images). */
const MAX_TOTAL_DECODED_BYTES = 24 * 1024 * 1024;
/** PDFs longer than this are extracted text-only: figure decoding can exceed the Worker's 128MB isolate. */
const TEXT_ONLY_MAX_PAGES = 60;
/** The PDF header must appear within the first 1KB per the spec, even with leading junk. */
const PDF_MAGIC_SCAN_BYTES = 1_024;
const PNG_CONTENT_TYPE = "image/png";

export type { ModuleExtraction } from "./module";
import { ReadingGaps, SOME_PICTURES_LEFT_OUT } from "./limits";
import type { ModuleExtraction } from "./module";

export interface ExtractPdfInput {
  url?: string;
  pdfBytes?: ArrayBuffer;
  sourceText: string;
  fetchImpl: FetchLike;
  assetStore?: AssetStore;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
  /** Parser seam; production uses unpdf, tests inject a fake. */
  parser?: PdfParser;
}

export interface PdfImageCandidate {
  /** Encoded PNG bytes, ready to persist. */
  bytes: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  /** 1-based page the image was found on. */
  page: number;
}

export interface PdfParseOutput {
  text: string;
  /** Each page's text, in order, when the parser keeps pages apart; `text` is used without it. */
  pages?: string[];
  totalPages: number;
  title?: string;
  /** The first page's heading: its largest text, when it stands out from the rest. */
  heading?: string;
  author?: string;
  images: PdfImageCandidate[];
}

export interface PdfParserOptions {
  maxImages: number;
  minImageBytes: number;
  maxImageRawBytes: number;
  maxTotalDecodedBytes: number;
}

export interface PdfParser {
  parse(data: Uint8Array, options: PdfParserOptions): Promise<PdfParseOutput>;
}

type UnpdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type UnpdfImage = Awaited<ReturnType<typeof extractImages>>[number];

/**
 * Real PDF extraction: parses bytes with unpdf, harvests embedded images as
 * figure assets, and reports depth honestly from the amount of text recovered.
 * Any failure resolves undefined so the caller keeps its HEAD-based fallback.
 */
export async function extractPdfModule(input: ExtractPdfInput): Promise<ModuleExtraction | undefined> {
  const sourceURL = input.url ? normalizeURL(input.url) : undefined;
  const data = await resolvePdfBytes(input, sourceURL);
  if (!data) return undefined;

  const parser = input.parser ?? createUnpdfParser();
  let parsed: PdfParseOutput;
  try {
    parsed = await parser.parse(data, {
      maxImages: MAX_FIGURES,
      minImageBytes: MIN_FIGURE_BYTES,
      maxImageRawBytes: MAX_FIGURE_RAW_BYTES,
      maxTotalDecodedBytes: MAX_TOTAL_DECODED_BYTES,
    });
  } catch {
    return undefined;
  }

  const gaps = new ReadingGaps();
  // Text-only mode for very large PDFs: figure decoding is where the Worker
  // isolate OOM-kills (arXiv 2005.14165, 75pp, hung the queue consumer at
  // "extracting" — see hey.md). The text layer, which is the substance, still
  // extracts fully; figures are the only thing skipped, and we say so.
  if (parsed.totalPages > TEXT_ONLY_MAX_PAGES) {
    gaps.add(
      "Pictures in this file were left out because it is long. All of its text was read.",
      "PDF exceeds 60 pages; embedded-figure extraction skipped to stay within Worker memory limits",
    );
  }
  const figures = await harvestFigures(
    parsed.totalPages > TEXT_ONLY_MAX_PAGES ? [] : filterImagesWithinBudget(parsed.images, gaps),
    sourceURL,
    input.assetStore,
    gaps,
  );
  const suppliedText = input.sourceText.trim();
  // Pages stay apart (a page break between them), so passages can say which page they are on.
  const extractedText = parsed.pages ? joinPages(parsed.pages) : cleanPdfText(parsed.text);
  const title = pdfTitle(parsed.title, parsed.heading);
  const author = cleanMetaValue(parsed.author);
  const text = [suppliedText, extractedText].filter(Boolean).join("\n\n").slice(0, input.maxTextChars);
  // Depth reflects the full recovered text even though the handoff is truncated.
  const textLength = suppliedText.length + extractedText.length;

  if (!extractedText) {
    gaps.add("No text could be read from this file. It may be a scan of printed pages.", "The PDF has no extractable text layer; it may be a scanned document");
  }

  return {
    ...(text ? { text } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(sourceURL ? { canonicalURL: sourceURL } : {}),
    ...(extractedText ? { excerpt: cleanPdfText(extractedText.replace(/^#{2,3} /gm, "")).slice(0, 500) } : {}),
    metadata: {
      extraction: extractedText ? "unpdf-text" : "unpdf-metadata",
      contentType: "application/pdf",
      pageCount: String(parsed.totalPages),
      ...(figures.length > 0 ? { harvestedFigures: String(figures.length) } : {}),
    },
    ...(figures.length > 0 ? { assets: figures } : {}),
    ...(sourceURL ? { references: [{ url: sourceURL, domain: hostname(sourceURL), label: "source" as const }] } : {}),
    accessLevel: extractedText ? "full" : "metadata",
    depthCap: depthCapForText(textLength),
    ...gaps.fields(),
  };
}

async function resolvePdfBytes(input: ExtractPdfInput, sourceURL: string | undefined): Promise<Uint8Array | undefined> {
  if (input.pdfBytes) {
    if (input.pdfBytes.byteLength === 0 || input.pdfBytes.byteLength > input.maxBytes) return undefined;
    const data = new Uint8Array(input.pdfBytes);
    return hasPdfMagic(data) ? data : undefined;
  }
  if (!sourceURL) return undefined;
  return fetchPdfBytes(sourceURL, input.fetchImpl, input.timeoutMs, input.maxBytes);
}

async function fetchPdfBytes(url: string, fetchImpl: FetchLike, timeoutMs: number, maxBytes: number): Promise<Uint8Array | undefined> {
  const response = await boundedFetch(url, fetchImpl, { method: "GET", headers: { accept: "application/pdf" } }, timeoutMs);
  if (!response?.ok) return undefined;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) return undefined;
  try {
    const data = await readBodyWithCap(response, maxBytes);
    return data && hasPdfMagic(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** A truncated PDF cannot be parsed (its xref lives at the end), so oversize bodies are rejected, not sliced. */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength <= maxBytes ? new Uint8Array(buffer) : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function hasPdfMagic(data: Uint8Array): boolean {
  const scan = data.subarray(0, Math.min(data.length, PDF_MAGIC_SCAN_BYTES));
  let text = "";
  for (const byte of scan) text += String.fromCharCode(byte);
  return text.includes("%PDF-");
}

/** Persists harvested images as figure assets; without a store they are skipped and said so. */
async function harvestFigures(images: PdfImageCandidate[], sourceURL: string | undefined, assetStore: AssetStore | undefined, gaps: ReadingGaps): Promise<AssetRef[]> {
  if (images.length === 0) return [];
  if (!assetStore) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Embedded PDF images were skipped because no asset store is configured to persist them");
    return [];
  }
  const figures: AssetRef[] = [];
  for (const image of images) {
    try {
      const ref = await assetStore.putAsset(image.bytes, {
        kind: "figure",
        ...(sourceURL ? { sourceURL } : {}),
        page: image.page,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        contentType: image.contentType,
      });
      if (ref) figures.push(ref);
    } catch {
      // Counted via the figures/images gap below.
    }
  }
  if (figures.length < images.length) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Some embedded PDF images could not be persisted to the asset store");
  }
  return figures;
}

/**
 * Post-parse policy pass (defense in depth — the real parser walk also enforces
 * these limits, but the seam injectable by tests sees raw candidate lists):
 * drops oversized single images and stops once the decoded-bytes budget is spent.
 */
function filterImagesWithinBudget(images: PdfImageCandidate[], gaps: ReadingGaps): PdfImageCandidate[] {
  const kept: PdfImageCandidate[] = [];
  let decodedBytes = 0;
  let skippedOversized = 0;
  let truncatedByBudget = false;
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (image.bytes.byteLength > MAX_FIGURE_RAW_BYTES) {
      skippedOversized += 1;
      continue;
    }
    if (decodedBytes + image.bytes.byteLength > MAX_TOTAL_DECODED_BYTES) {
      truncatedByBudget = true;
      break;
    }
    kept.push(image);
    decodedBytes += image.bytes.byteLength;
  }
  if (skippedOversized > 0) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Oversized embedded images were skipped to stay within Worker memory limits");
  }
  if (truncatedByBudget) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Embedded-image budget exceeded; remaining figures were skipped");
  }
  return kept;
}

function depthCapForText(textLength: number): ByteDepth {
  if (textLength >= 30_000) return "veryDeep";
  if (textLength >= 4_000) return "deep";
  if (textLength >= 600) return "medium";
  if (textLength > 0) return "light";
  return "saveOnly";
}

function createUnpdfParser(): PdfParser {
  return {
    async parse(data, options) {
      const pdf = await getDocumentProxy(data);
      try {
        const [{ totalPages, pages, heading }, meta] = await Promise.all([readPages(pdf), getMeta(pdf)]);
        const images = await extractFigureCandidates(pdf, totalPages, options);
        return {
          text: pages.join(" "),
          pages,
          totalPages,
          title: metaString(meta.info?.Title),
          ...(heading ? { heading } : {}),
          author: metaString(meta.info?.Author),
          images,
        };
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  };
}

/**
 * unpdf decodes embedded images to raw pixels, so candidates are re-encoded as
 * PNG (no encoder dependency exists in Workers) and filtered by raw size.
 * Memory rule: decode is eager and pdf.js caches per-page decoded images, so we
 * skip images above the raw-byte cap and stop the walk once the cumulative
 * decoded budget is spent — never encode/persist multi-tens-of-MB figures.
 */
async function extractFigureCandidates(
  pdf: UnpdfDocument,
  totalPages: number,
  options: PdfParserOptions,
): Promise<PdfImageCandidate[]> {
  const images: PdfImageCandidate[] = [];
  let decodedBytes = 0;
  for (let page = 1; page <= totalPages && images.length < options.maxImages && decodedBytes <= options.maxTotalDecodedBytes; page++) {
    let extracted: UnpdfImage[];
    try {
      extracted = await extractImages(pdf, page);
    } catch {
      continue;
    }
    for (const image of extracted) {
      if (images.length >= options.maxImages) break;
      if (image.data.byteLength < options.minImageBytes) continue;
      // Count every decoded image (even ones we then skip) — the decode already happened.
      decodedBytes += image.data.byteLength;
      if (image.data.byteLength > options.maxImageRawBytes) continue;
      if (decodedBytes > options.maxTotalDecodedBytes) return images;
      try {
        const bytes = await encodePng(image.data, image.width, image.height, image.channels);
        images.push({ bytes, contentType: PNG_CONTENT_TYPE, width: image.width, height: image.height, page });
      } catch {
        // An unencodable image is skipped without losing the rest.
      }
    }
  }
  return images;
}

/** Encodes raw pixels (1, 3, or 4 channels) into a PNG using only web-platform APIs. */
export async function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Promise<Uint8Array> {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const scanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0; // filter: none
    scanlines.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = new Uint8Array(
    await new Response(new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = colorType;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** pdf.js info values are untyped; only strings are usable as metadata. */
const MAX_HEADING = 120;

/**
 * The name a PDF is shown by: the title written into the file when it is a
 * real one, else the heading on its first page, else nothing (the source is then
 * named by the file it came in). Many files carry no title, or
 * one their app wrote for them (`Microsoft Word - lec07_final_v2.docx`,
 * `Presentation1`); those say nothing the file name does not.
 */
export function pdfTitle(metaTitle: string | undefined, heading: string | undefined): string | undefined {
  const meta = cleanMetaValue(metaTitle);
  if (meta && !isPlaceholderTitle(meta)) return meta;
  const head = cleanMetaValue(heading);
  if (head && head.length <= MAX_HEADING && /\p{L}/u.test(head)) return head;
  // An app's own filler names nothing; the name the file came with says more.
  return undefined;
}

/** A title an app filled in by itself: a file name, or an app's default for a new document. */
export function isPlaceholderTitle(title: string): boolean {
  const bare = title.replace(/^Microsoft (?:Word|PowerPoint|Excel)\s*-\s*/i, "").trim();
  if (!bare) return true;
  if (/\.(?:docx?|pptx?|xlsx?|pdf|tex|dvi|key|pages|odt|odp|rtf|txt|md|html?)$/i.test(bare)) return true;
  return /^\(?(?:anonymous|untitled)\)?$|^(?:untitled(?: document)?|document\s*\d*|presentation\s*\d*|powerpoint presentation|slide\s*\d+|title|no title)$/i.test(bare);
}

interface HeadingItem {
  str: string;
  size: number;
}

/**
 * The first page's largest text, joined in reading order, when it is
 * clearly larger than the page's usual text; undefined on a page of one size.
 */
export function headingFromItems(items: HeadingItem[]): string | undefined {
  const words = items.filter((item) => item.str.trim() && item.size > 0);
  if (words.length < 2) return undefined;
  const sizes = words.map((item) => item.size).sort((a, b) => a - b);
  const usual = sizes[Math.floor((sizes.length - 1) / 2)]!;
  const largest = sizes[sizes.length - 1]!;
  if (largest < usual * 1.15) return undefined;
  const parts: string[] = [];
  let started = false;
  for (const item of words) {
    const big = item.size >= largest * 0.9;
    if (big) {
      parts.push(item.str.trim());
      started = true;
    } else if (started) break;
  }
  const heading = parts.join(" ").replace(/\s+/g, " ").trim();
  return heading || undefined;
}

/** One run of text as pdf.js lays it out: where its baseline sits, how big, how wide. */
export interface LaidOutItem {
  str: string;
  /** Baseline height on the page; larger is higher up. */
  y: number;
  size: number;
  width: number;
  hasEOL?: boolean;
}

/**
 * The size most of a document's words are set in: its body text. Each
 * size counts by how many characters use it, so a page of headings and
 * footnotes does not move it. Undefined with no text.
 */
export function bodySize(items: readonly LaidOutItem[]): number | undefined {
  const bySize = new Map<number, number>();
  for (const item of items) {
    const chars = item.str.trim().length;
    if (!chars || !(item.size > 0)) continue;
    const size = Math.round(item.size * 2) / 2;
    bySize.set(size, (bySize.get(size) ?? 0) + chars);
  }
  let best: [number, number] | undefined;
  for (const entry of bySize) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0];
}

/**
 * A paragraph that reads as a heading: set clearly larger than the body
 * text, a line or two long, with letters, not ending like a sentence. The
 * text layer has no other sign a reader can trust (bold at body size is not
 * told apart), so a PDF whose headings are only bold keeps them as
 * paragraphs.
 */
function headingLevel(text: string, size: number, lines: number, body: number | undefined): 2 | 3 | undefined {
  if (!body || size < body * 1.15 || lines > 3 || text.length > 140) return undefined;
  if (!/\p{L}/u.test(text) || /[.,;]$/.test(text)) return undefined;
  return size >= body * 1.6 ? 2 : 3;
}

/**
 * A page's text as paragraphs, from where its lines sit: a new paragraph
 * starts where the gap above a line is clearly wider than the page's usual
 * line spacing, where the text size changes (a heading), where reading jumps
 * back up (a new column), or after a short line that ends a sentence.
 * Lines within a paragraph are joined with a space; paragraphs with a blank
 * line. A paragraph that reads as a heading against `body` (the document's
 * body size; this page's own when not given) starts with `## ` or `### `, as
 * Markdown writes one, so the reader and the agents see the source's parts.
 */
export function paragraphsFromItems(items: LaidOutItem[], body: number | undefined = bodySize(items)): string {
  interface Line { text: string; y: number; size: number; width: number }
  const lines: Line[] = [];
  let current: Line | undefined;
  for (const item of items) {
    const size = item.size > 0 ? item.size : 10;
    if (current && Math.abs(item.y - current.y) > Math.max(current.size, size) * 0.5 && current.text.trim()) {
      lines.push(current);
      current = undefined;
    }
    if (!current) current = { text: "", y: item.y, size, width: 0 };
    current.text += item.str;
    current.size = Math.max(current.size, size);
    current.width += item.width;
    if (item.hasEOL) {
      if (current.text.trim()) lines.push(current);
      current = undefined;
    }
  }
  if (current?.text.trim()) lines.push(current);
  const clean = lines.map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() })).filter((line) => line.text);
  if (clean.length === 0) return "";

  const gaps = clean.slice(1).map((line, k) => clean[k]!.y - line.y).filter((gap) => gap > 0).sort((a, b) => a - b);
  const usualGap = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0;
  const widest = Math.max(...clean.map((line) => line.width));

  const paragraphs: Line[][] = [[clean[0]!]];
  for (let k = 1; k < clean.length; k++) {
    const before = clean[k - 1]!;
    const line = clean[k]!;
    const gap = before.y - line.y;
    const sizeChanged = Math.max(before.size, line.size) / Math.min(before.size, line.size) > 1.15;
    const wideGap = usualGap > 0 && gap > usualGap * 1.4;
    const wentUp = gap < 0;
    const shortEnd = widest > 0 && before.width < widest * 0.7 && /[.!?:"”)]$/.test(before.text);
    if (sizeChanged || wideGap || wentUp || shortEnd) paragraphs.push([line]);
    else paragraphs[paragraphs.length - 1]!.push(line);
  }
  return paragraphs
    .map((lines) => {
      const text = lines.map((line) => line.text).join(" ");
      const level = headingLevel(text, Math.min(...lines.map((line) => line.size)), lines.length, body);
      return level ? `${"#".repeat(level)} ${text}` : text;
    })
    .join("\n\n");
}

/** Every page's text as paragraphs, and the first page's heading, from one pass over the text layer. */
async function readPages(pdf: UnpdfDocument): Promise<{ totalPages: number; pages: string[]; heading?: string }> {
  const totalPages = pdf.numPages;
  const pages: string[] = [];
  let heading: string | undefined;
  const laid: Array<LaidOutItem[] | undefined> = [];
  for (let n = 1; n <= totalPages; n++) {
    try {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items: LaidOutItem[] = content.items.flatMap((item) =>
        "str" in item
          ? [{ str: item.str, y: item.transform[5] ?? 0, size: Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height, width: item.width, hasEOL: item.hasEOL }]
          : [],
      );
      if (n === 1) heading = headingFromItems(items);
      laid.push(items);
    } catch {
      laid.push(undefined);
    }
  }
  // Headings are told against the whole document's body size, so a page that is mostly a heading is still read right.
  const body = bodySize(laid.flatMap((items) => items ?? []));
  for (const items of laid) pages.push(items ? paragraphsFromItems(items, body) : "");
  return { totalPages, pages, ...(heading ? { heading } : {}) };
}

function metaString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanMetaValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 2_000) : undefined;
}

function cleanPdfText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/** A page's text with its paragraphs kept: spaces collapsed within each, one blank line between them. */
function cleanPdfPage(value: string): string {
  return value
    .split(/\n\s*\n/)
    .map(cleanPdfText)
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Pages' text with a page break (`PAGE_BREAK`) between each, empty pages
 * included, so the nth break always starts page n + 1 (`sources/chunk.ts`).
 * Empty when no page has text.
 */
function joinPages(pages: string[]): string {
  const cleaned = pages.map(cleanPdfPage);
  return cleaned.some(Boolean) ? cleaned.join(PAGE_BREAK) : "";
}

function normalizeURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

