import { boundedFetch, hostname } from "../net";
import type { AssetStore } from "../assets";
import type { AccessLevel, AssetRef, ByteDepth, FetchLike, SourceReference } from "../types";

const MAX_IMAGES = 8;
/** Embedded media below this many bytes are usually icons, bullets, or theme artifacts. */
const MIN_IMAGE_BYTES = 10_000;
const MAX_SHEETS = 10;
const MAX_ROWS_PER_SHEET = 500;
/** Zip-bomb guards: absurd member counts or inflated entry sizes are rejected. */
const MAX_ZIP_ENTRIES = 2_048;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
/** EOCD is 22 bytes plus up to 64KB of trailing comment. */
const EOCD_MIN_BYTES = 22;
const EOCD_SCAN_BYTES = 65_535 + EOCD_MIN_BYTES;

export type { ModuleExtraction } from "./module";
import { ReadingGaps, SOME_PICTURES_LEFT_OUT } from "./limits";
import type { ModuleExtraction } from "./module";

export interface ExtractOfficeInput {
  bytes?: ArrayBuffer;
  url?: string;
  filename?: string;
  contentType?: string;
  sourceText: string;
  fetchImpl: FetchLike;
  assetStore?: AssetStore;
  timeoutMs: number;
  maxBytes: number;
  maxTextChars: number;
}

type OfficeFormat = "docx" | "xlsx" | "pptx";

const OFFICE_CONTENT_TYPES: Record<OfficeFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
};

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = raw deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface OfficeImageCandidate {
  /** Raw embedded bytes, persisted as-is. */
  bytes: Uint8Array;
  contentType: string;
  /** Archive entry name (e.g. "word/media/image1.png"), kept as caption provenance. */
  entryName: string;
}

interface OfficeParseOutput {
  text: string;
  title?: string;
  author?: string;
  images: OfficeImageCandidate[];
  counts: Record<string, string>;
}

/**
 * Real Office extraction: reads DOCX/XLSX/PPTX bytes with a dependency-free
 * ZIP + XML reader (store and raw-deflate entries only), harvests embedded
 * media as image assets, and reports depth honestly from the text recovered.
 * Any failure resolves undefined so the caller keeps its fallback.
 */
export async function extractOfficeModule(input: ExtractOfficeInput): Promise<ModuleExtraction | undefined> {
  try {
    const sourceURL = input.url ? normalizeURL(input.url) : undefined;
    const data = await resolveOfficeBytes(input, sourceURL);
    if (!data) return undefined;
    const entries = readCentralDirectory(data);
    if (!entries) return undefined;
    const filename = input.filename ?? (sourceURL ? urlBasename(sourceURL) : undefined);
    const format = detectFormat(input.contentType, filename, entries);
    if (!format) return undefined;

    const zip: ZipReader = { data, entries };
    const gaps = new ReadingGaps();
    const parsed =
      format === "docx" ? await parseDocx(zip) : format === "xlsx" ? await parseXlsx(zip, gaps) : await parsePptx(zip);
    if (!parsed) return undefined;

    const suppliedText = input.sourceText.trim();
    const extractedText = cleanOfficeText(parsed.text);
    const title = cleanMetaValue(parsed.title);
    const author = cleanMetaValue(parsed.author);
    const text = [suppliedText, extractedText].filter(Boolean).join("\n\n").slice(0, input.maxTextChars);
    // Depth reflects the full recovered text even though the handoff is truncated.
    const textLength = suppliedText.length + extractedText.length;

    const images = await harvestImages(parsed.images, sourceURL, input.assetStore, gaps);

    if (!extractedText) {
      gaps.add("No text could be read from this file. It may be empty.", "The document has no extractable text; it may be empty or use unsupported markup");
    }

    return {
      ...(text ? { text } : {}),
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(sourceURL ? { canonicalURL: sourceURL } : {}),
      ...(extractedText ? { excerpt: extractedText.slice(0, 500) } : {}),
      metadata: {
        extraction: `office-${format}`,
        contentType: OFFICE_CONTENT_TYPES[format],
        ...parsed.counts,
        ...(images.length > 0 ? { harvestedImages: String(images.length) } : {}),
      },
      ...(images.length > 0 ? { assets: images } : {}),
      ...(sourceURL ? { references: [{ url: sourceURL, domain: hostname(sourceURL), label: "source" as const }] } : {}),
      accessLevel: extractedText ? "full" : "metadata",
      depthCap: depthCapForText(textLength),
      ...gaps.fields(),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Byte resolution (mirrors pdf.ts: oversized or non-ZIP bodies are rejected)
// ---------------------------------------------------------------------------

async function resolveOfficeBytes(input: ExtractOfficeInput, sourceURL: string | undefined): Promise<Uint8Array | undefined> {
  if (input.bytes) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.maxBytes) return undefined;
    const data = new Uint8Array(input.bytes);
    return hasZipMagic(data) ? data : undefined;
  }
  if (!sourceURL) return undefined;
  return fetchOfficeBytes(sourceURL, input.fetchImpl, input.timeoutMs, input.maxBytes);
}

async function fetchOfficeBytes(url: string, fetchImpl: FetchLike, timeoutMs: number, maxBytes: number): Promise<Uint8Array | undefined> {
  const accept = Object.values(OFFICE_CONTENT_TYPES).join(",");
  const response = await boundedFetch(url, fetchImpl, { method: "GET", headers: { accept } }, timeoutMs);
  if (!response?.ok) return undefined;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) return undefined;
  try {
    const data = await readBodyWithCap(response, maxBytes);
    return data && hasZipMagic(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** A truncated archive cannot be read (its central directory lives at the end), so oversize bodies are rejected, not sliced. */
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

function hasZipMagic(data: Uint8Array): boolean {
  // A non-empty archive always opens with a PK\x03\x04 local file header.
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader: central directory walk + store/deflate-raw inflation.
// Office archives always carry a central directory, so local-header streaming
// is never needed. CRCs are trusted, not verified.
// ---------------------------------------------------------------------------

interface ZipReader {
  data: Uint8Array;
  entries: ZipEntry[];
}

function readCentralDirectory(data: Uint8Array): ZipEntry[] | undefined {
  if (data.length < EOCD_MIN_BYTES) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  const scanStart = Math.max(0, data.length - EOCD_SCAN_BYTES);
  for (let i = data.length - EOCD_MIN_BYTES; i >= scanStart; i--) {
    if (view.getUint32(i, true) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) return undefined;
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) return undefined;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength > data.length) return undefined;
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array | undefined> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > data.length || view.getUint32(offset, true) !== ZIP_LOCAL_HEADER) return undefined;
  // Local name/extra lengths can differ from the central directory's, so the
  // data start must come from the local header while sizes come from central.
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) return undefined;
  const raw = data.subarray(start, end);
  if (entry.method === 0) return new Uint8Array(raw);
  if (entry.method === 8) {
    try {
      // ZIP deflate is raw DEFLATE, without the two-byte zlib wrapper.
      return new Uint8Array(
        await new Response(new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readZipText(zip: ZipReader, name: string): Promise<string | undefined> {
  const entry = zip.entries.find((candidate) => candidate.name === name);
  if (!entry) return undefined;
  return decodeEntry(zip, entry);
}

async function decodeEntry(zip: ZipReader, entry: ZipEntry): Promise<string | undefined> {
  const bytes = await inflateEntry(zip.data, entry);
  if (!bytes) return undefined;
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Format detection: explicit hints first, then entry sniffing.
// ---------------------------------------------------------------------------

function detectFormat(contentType: string | undefined, filename: string | undefined, entries: ZipEntry[]): OfficeFormat | undefined {
  const type = contentType?.toLowerCase() ?? "";
  const name = filename?.toLowerCase() ?? "";
  if (type.includes("wordprocessingml") || name.endsWith(".docx")) return "docx";
  if (type.includes("spreadsheetml") || name.endsWith(".xlsx")) return "xlsx";
  if (type.includes("presentationml") || name.endsWith(".pptx")) return "pptx";
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has("word/document.xml")) return "docx";
  if (names.has("ppt/presentation.xml")) return "pptx";
  if (names.has("xl/workbook.xml")) return "xlsx";
  return undefined;
}

// ---------------------------------------------------------------------------
// DOCX: word/document.xml paragraphs, headings, and tables in document order.
// ---------------------------------------------------------------------------

async function parseDocx(zip: ZipReader): Promise<OfficeParseOutput | undefined> {
  const documentXml = await readZipText(zip, "word/document.xml");
  if (!documentXml) return undefined;
  const { text, paragraphs } = parseDocxDocument(documentXml);
  const core = await readCoreProps(zip);
  const images = await collectMedia(zip, "word/media/");
  return { text, ...core, images, counts: { paragraphCount: String(paragraphs) } };
}

function parseDocxDocument(xml: string): { text: string; paragraphs: number } {
  const blocks: string[] = [];
  let paragraphs = 0;
  // Body-level scan; tables are consumed whole so their inner <w:p> runs are
  // not double-counted as paragraphs.
  const tokenRe = /<w:(tbl|p)(?=[\s/>])/g;
  for (;;) {
    const match = tokenRe.exec(xml);
    if (!match) break;
    if (match[1] === "tbl") {
      const end = xml.indexOf("</w:tbl>", match.index);
      if (end < 0) break;
      const table = parseDocxTable(xml.slice(match.index, end));
      if (table) blocks.push(table);
      tokenRe.lastIndex = end + "</w:tbl>".length;
    } else {
      const end = xml.indexOf("</w:p>", match.index);
      if (end < 0) break;
      const paragraph = parseDocxParagraph(xml.slice(match.index, end));
      tokenRe.lastIndex = end + "</w:p>".length;
      if (!paragraph) continue;
      paragraphs += 1;
      blocks.push(paragraph);
    }
  }
  return { text: blocks.join("\n"), paragraphs };
}

function parseDocxParagraph(xml: string): string {
  const style = /<w:pStyle\s[^>]*?w:val="([^"]+)"/.exec(xml)?.[1] ?? "";
  const text = docxInlineText(xml).trim();
  if (!text) return "";
  const heading = /^Heading\s*([1-6])$/i.exec(style);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;
  if (/^Title$/i.test(style)) return `# ${text}`;
  return text;
}

function parseDocxTable(xml: string): string {
  const rows: string[] = [];
  const rowRe = /<w:tr(?=[\s/>])/g;
  for (;;) {
    const rowMatch = rowRe.exec(xml);
    if (!rowMatch) break;
    const rowEnd = xml.indexOf("</w:tr>", rowMatch.index);
    if (rowEnd < 0) break;
    const rowXml = xml.slice(rowMatch.index, rowEnd);
    rowRe.lastIndex = rowEnd + "</w:tr>".length;
    const cells: string[] = [];
    const cellRe = /<w:tc(?=[\s/>])/g;
    for (;;) {
      const cellMatch = cellRe.exec(rowXml);
      if (!cellMatch) break;
      const cellEnd = rowXml.indexOf("</w:tc>", cellMatch.index);
      if (cellEnd < 0) break;
      cells.push(docxInlineText(rowXml.slice(cellMatch.index, cellEnd)).replace(/\s+/g, " ").trim());
      cellRe.lastIndex = cellEnd + "</w:tc>".length;
    }
    if (cells.length > 0) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/** Run text in document order, honoring explicit tabs and line breaks between runs. */
function docxInlineText(xml: string): string {
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\s*\/>/g;
  let text = "";
  for (;;) {
    const match = tokenRe.exec(xml);
    if (!match) break;
    if (match[1] !== undefined) text += unescapeXml(match[1]);
    else text += match[2] === "tab" ? "\t" : " ";
  }
  return text;
}

// ---------------------------------------------------------------------------
// XLSX: sharedStrings + worksheet rows rendered as TSV sections.
// ---------------------------------------------------------------------------

async function parseXlsx(zip: ZipReader, gaps: ReadingGaps): Promise<OfficeParseOutput | undefined> {
  const sheets = await resolveSheetPaths(zip);
  if (sheets.length === 0) return undefined;
  const sharedXml = await readZipText(zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const sections: string[] = [];
  let sheetCount = 0;
  for (const sheet of sheets) {
    if (sheetCount >= MAX_SHEETS) {
      gaps.add(`Only the first ${MAX_SHEETS} sheets of this file were read.`, `Workbook was truncated at ${MAX_SHEETS} sheets`);
      break;
    }
    const xml = await readZipText(zip, sheet.path);
    if (xml === undefined) continue;
    sheetCount += 1;
    const { rows, truncated } = parseWorksheet(xml, shared);
    if (truncated) {
      gaps.add(
        `Only the first ${MAX_ROWS_PER_SHEET} rows of each sheet were read.`,
        `Worksheet rows were truncated at ${MAX_ROWS_PER_SHEET} rows per sheet`,
      );
    }
    const body = rows.map((row) => row.join("\t")).join("\n");
    sections.push(sheet.name ? `Sheet: ${sheet.name}\n${body}` : body);
  }
  const core = await readCoreProps(zip);
  const images = await collectMedia(zip, "xl/media/");
  return { text: sections.join("\n\n"), ...core, images, counts: { sheetCount: String(sheetCount) } };
}

/** Sheet order comes from workbook.xml + its rels; without them, worksheet entries are enumerated numerically. */
async function resolveSheetPaths(zip: ZipReader): Promise<Array<{ name?: string; path: string }>> {
  const workbookXml = await readZipText(zip, "xl/workbook.xml");
  const relsXml = await readZipText(zip, "xl/_rels/workbook.xml.rels");
  if (workbookXml && relsXml) {
    const targets = new Map<string, string>();
    const relRe = /<Relationship\b[^>]*>/g;
    for (;;) {
      const match = relRe.exec(relsXml);
      if (!match) break;
      const id = xmlAttr(match[0], "Id");
      const target = xmlAttr(match[0], "Target");
      if (id && target) targets.set(id, target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
    }
    const sheets: Array<{ name?: string; path: string }> = [];
    const sheetRe = /<sheet\b[^>]*>/g;
    for (;;) {
      const match = sheetRe.exec(workbookXml);
      if (!match) break;
      const relId = xmlAttr(match[0], "r:id");
      const path = relId ? targets.get(relId) : undefined;
      if (!path) continue;
      const name = xmlAttr(match[0], "name");
      sheets.push({ ...(name ? { name } : {}), path });
    }
    if (sheets.length > 0) return sheets;
  }
  return zip.entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => sheetNumber(a.name) - sheetNumber(b.name))
    .map((entry) => ({ path: entry.name }));
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si(?=[\s/>])/g;
  for (;;) {
    const match = siRe.exec(xml);
    if (!match) break;
    const end = xml.indexOf("</si>", match.index);
    if (end < 0) break;
    // Rich-text <si> entries hold several <r><t> runs; concatenate them.
    strings.push(extractXmlTagTexts(xml.slice(match.index, end), "t").join(""));
    siRe.lastIndex = end + "</si>".length;
  }
  return strings;
}

function parseWorksheet(xml: string, shared: string[]): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  const rowRe = /<row(?=[\s/>])/g;
  for (;;) {
    const match = rowRe.exec(xml);
    if (!match) break;
    if (rows.length >= MAX_ROWS_PER_SHEET) {
      truncated = true;
      break;
    }
    const end = xml.indexOf("</row>", match.index);
    const rowXml = end < 0 ? xml.slice(match.index) : xml.slice(match.index, end);
    rows.push(parseWorksheetRow(rowXml, shared));
    if (end < 0) break;
    rowRe.lastIndex = end + "</row>".length;
  }
  return { rows, truncated };
}

function parseWorksheetRow(xml: string, shared: string[]): string[] {
  const cells: string[] = [];
  const cellRe = /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g;
  for (;;) {
    const match = cellRe.exec(xml);
    if (!match) break;
    const ref = xmlAttr(match[0], "r") ?? "";
    // Sparse sheets skip cells; pad with empty fields so columns stay aligned.
    const column = columnIndex(ref);
    while (column > cells.length) cells.push("");
    cells.push(cellValue(match[0], shared));
  }
  return cells;
}

function cellValue(cellXml: string, shared: string[]): string {
  const type = xmlAttr(cellXml, "t");
  if (type === "inlineStr") return extractXmlTagTexts(cellXml, "t").join("");
  const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
  if (raw === undefined) return "";
  const value = unescapeXml(raw);
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

/** "C5" -> 2; unparseable refs keep the cell at the next position. */
function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index > 0 ? index - 1 : 0;
}

function sheetNumber(name: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

// ---------------------------------------------------------------------------
// PPTX: one text section per slide, slides ordered by file number (the usual
// producer order; the presentation.xml ordering is not resolved).
// ---------------------------------------------------------------------------

async function parsePptx(zip: ZipReader): Promise<OfficeParseOutput | undefined> {
  const slideEntries = zip.entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  if (slideEntries.length === 0) return undefined;
  const sections: string[] = [];
  for (const entry of slideEntries) {
    const xml = await decodeEntry(zip, entry);
    if (xml === undefined) continue;
    const text = parsePptxSlide(xml);
    if (text) sections.push(text);
  }
  const core = await readCoreProps(zip);
  const images = await collectMedia(zip, "ppt/media/");
  return { text: sections.join("\n\n"), ...core, images, counts: { slideCount: String(slideEntries.length) } };
}

function parsePptxSlide(xml: string): string {
  const paragraphs: string[] = [];
  const paragraphRe = /<a:p(?=[\s/>])/g;
  for (;;) {
    const match = paragraphRe.exec(xml);
    if (!match) break;
    const end = xml.indexOf("</a:p>", match.index);
    if (end < 0) break;
    const text = extractXmlTagTexts(xml.slice(match.index, end), "a:t").join("").trim();
    if (text) paragraphs.push(text);
    paragraphRe.lastIndex = end + "</a:p>".length;
  }
  return paragraphs.join("\n");
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

// ---------------------------------------------------------------------------
// Shared: core properties, embedded media harvest, XML helpers.
// ---------------------------------------------------------------------------

async function readCoreProps(zip: ZipReader): Promise<{ title?: string; author?: string }> {
  const xml = await readZipText(zip, "docProps/core.xml");
  if (!xml) return {};
  const title = firstTagText(xml, "dc:title");
  const creator = firstTagText(xml, "dc:creator");
  return { ...(title ? { title } : {}), ...(creator ? { author: creator } : {}) };
}

/** Collects embedded media entries at or above the icon-size floor, capped per document. */
async function collectMedia(zip: ZipReader, prefix: string): Promise<OfficeImageCandidate[]> {
  const images: OfficeImageCandidate[] = [];
  const entries = zip.entries
    .filter((entry) => entry.name.startsWith(prefix) && !entry.name.endsWith("/"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (images.length >= MAX_IMAGES) break;
    if (entry.uncompressedSize < MIN_IMAGE_BYTES) continue;
    const bytes = await inflateEntry(zip.data, entry);
    if (!bytes || bytes.byteLength < MIN_IMAGE_BYTES) continue;
    images.push({ bytes, contentType: imageContentType(entry.name), entryName: entry.name });
  }
  return images;
}

/** Persists harvested images as image assets; without a store they are skipped and said so. */
async function harvestImages(
  images: OfficeImageCandidate[],
  sourceURL: string | undefined,
  assetStore: AssetStore | undefined,
  gaps: ReadingGaps,
): Promise<AssetRef[]> {
  if (images.length === 0) return [];
  if (!assetStore) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Embedded images were skipped because no asset store is configured to persist them");
    return [];
  }
  const harvested: AssetRef[] = [];
  for (const image of images) {
    try {
      const ref = await assetStore.putAsset(image.bytes, {
        kind: "image",
        ...(sourceURL ? { sourceURL } : {}),
        caption: image.entryName,
        contentType: image.contentType,
      });
      if (ref) harvested.push(ref);
    } catch {
      // Counted via the harvested/images gap below.
    }
  }
  if (harvested.length < images.length) {
    gaps.add(SOME_PICTURES_LEFT_OUT, "Some embedded images could not be persisted to the asset store");
  }
  return harvested;
}

function imageContentType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function firstTagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  const text = match ? unescapeXml(match[1]).trim() : "";
  return text || undefined;
}

function extractXmlTagTexts(xml: string, tag: string): string[] {
  const texts: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (;;) {
    const match = re.exec(xml);
    if (!match) break;
    texts.push(unescapeXml(match[1]));
  }
  return texts;
}

function xmlAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : undefined;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => safeCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Invalid numeric character references decode to nothing instead of throwing. */
function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

function depthCapForText(textLength: number): ByteDepth {
  if (textLength >= 30_000) return "veryDeep";
  if (textLength >= 4_000) return "deep";
  if (textLength >= 600) return "medium";
  if (textLength > 0) return "light";
  return "saveOnly";
}

function cleanMetaValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 2_000) : undefined;
}

/** Paragraph structure is meaningful, so only trailing spaces and blank runs collapse. */
function cleanOfficeText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function urlBasename(value: string): string | undefined {
  try {
    const path = new URL(value).pathname;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name || undefined;
  } catch {
    return undefined;
  }
}
