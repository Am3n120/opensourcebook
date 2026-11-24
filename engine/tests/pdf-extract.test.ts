import { describe, expect, it } from "vitest";
import { AssetStore, isAssetPath } from "../src/assets";
import {
  encodePng,
  extractPdfModule,
  type ExtractPdfInput,
  type PdfParseOutput,
  type PdfParser,
  type PdfParserOptions,
} from "../src/extract/pdf";
import { PAGE_BREAK, type FetchLike, type R2BucketLike } from "../src/types";

// ---------------------------------------------------------------------------
// Minimal PDF fixture builder. Assembles byte-accurate PDFs (valid xref) so
// the real unpdf/pdf.js boundary can be exercised without binary fixtures.
// ---------------------------------------------------------------------------

interface PdfFixturePage {
  text?: string;
  /** Raw RGB pixel buffers; each becomes an embedded image XObject on the page. */
  images?: Uint8Array[];
}

function fixtureImage(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31) % 256;
  return pixels;
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(options: { pages: PdfFixturePage[]; title?: string; author?: string }): Uint8Array {
  const encoder = new TextEncoder();
  interface PagePlan extends PdfFixturePage {
    id: number;
    contentId?: number;
    imageIds: number[];
  }
  let nextId = 3;
  const pagePlans: PagePlan[] = options.pages.map((page) => {
    const id = nextId++;
    const hasContent = page.text !== undefined || (page.images?.length ?? 0) > 0;
    const contentId = hasContent ? nextId++ : undefined;
    const imageIds = (page.images ?? []).map(() => nextId++);
    return { ...page, id, contentId, imageIds };
  });
  const fontId = nextId++;
  const infoId = options.title !== undefined || options.author !== undefined ? nextId++ : undefined;
  const totalObjects = nextId - 1;

  const chunks: Uint8Array[] = [];
  const push = (value: string | Uint8Array) => chunks.push(typeof value === "string" ? encoder.encode(value) : value);
  const length = () => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const bodies: Array<Array<string | Uint8Array>> = Array.from({ length: totalObjects }, () => []);
  bodies[0] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  bodies[1] = [`<< /Type /Pages /Kids [${pagePlans.map((page) => `${page.id} 0 R`).join(" ")}] /Count ${pagePlans.length} >>`];
  for (const page of pagePlans) {
    const resources: string[] = [];
    if (page.text !== undefined) resources.push(`/Font << /F1 ${fontId} 0 R >>`);
    if (page.imageIds.length > 0) {
      resources.push(`/XObject << ${page.imageIds.map((id, index) => `/Im${index} ${id} 0 R`).join(" ")} >>`);
    }
    const parts = [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]`,
      ...(page.contentId !== undefined ? [` /Contents ${page.contentId} 0 R`] : []),
      ...(resources.length > 0 ? [` /Resources << ${resources.join(" ")} >>`] : []),
      " >>",
    ];
    bodies[page.id - 1] = [parts.join("")];
    if (page.contentId !== undefined) {
      const operations: string[] = [];
      if (page.text !== undefined) {
        // pdf.js drops text painted outside the page box, so wrap into short
        // lines; callers paginate beyond ~60 lines via textPages().
        const lines: string[] = [];
        for (let i = 0; i < page.text.length; i += 70) lines.push(page.text.slice(i, i + 70));
        const showLines = lines.map((line) => `(${escapePdfString(line)}) Tj T*`).join(" ");
        operations.push(`BT /F1 10 Tf 12 TL 72 750 Td ${showLines} ET`);
      }
      page.imageIds.forEach((_, index) => operations.push(`q 200 0 0 200 50 ${500 - index * 250} cm /Im${index} Do Q`));
      const stream = operations.join("\n");
      bodies[page.contentId - 1] = [`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    }
    page.imageIds.forEach((id, index) => {
      const pixels = page.images![index];
      const width = Math.sqrt(pixels.length / 3);
      bodies[id - 1] = [
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${width} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
        pixels,
        "\nendstream",
      ];
    });
  }
  bodies[fontId - 1] = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (infoId !== undefined) {
    const entries: string[] = [];
    if (options.title !== undefined) entries.push(`/Title (${escapePdfString(options.title)})`);
    if (options.author !== undefined) entries.push(`/Author (${escapePdfString(options.author)})`);
    bodies[infoId - 1] = [`<< ${entries.join(" ")} >>`];
  }

  push("%PDF-1.4\n");
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(length());
    push(`${index + 1} 0 obj\n`);
    for (const part of body) push(part);
    push("\nendobj\n");
  });
  const xrefStart = length();
  push(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R${infoId !== undefined ? ` /Info ${infoId} 0 R` : ""} >>\nstartxref\n${xrefStart}\n%%EOF`);

  const bytes = new Uint8Array(length());
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Splits long text across pages so every painted line stays inside the page box. */
function textPages(text: string, charsPerPage = 4_000): PdfFixturePage[] {
  const pages: PdfFixturePage[] = [];
  for (let i = 0; i < text.length; i += charsPerPage) pages.push({ text: text.slice(i, i + charsPerPage) });
  return pages;
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const notFoundFetch: FetchLike = async () => new Response("missing", { status: 404 });

function input(overrides: Partial<ExtractPdfInput> = {}): ExtractPdfInput {
  return {
    sourceText: "",
    fetchImpl: notFoundFetch,
    timeoutMs: 5_000,
    maxBytes: 5_000_000,
    maxTextChars: 24_000,
    ...overrides,
  };
}

function fakeParser(output: PdfParseOutput): PdfParser {
  return { parse: async () => output };
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, { bytes: ArrayBuffer; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();

  async get() {
    return null;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = typeof value === "string"
      ? (new TextEncoder().encode(value).buffer as ArrayBuffer)
      : value instanceof ArrayBuffer
        ? value
        : (value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
    this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    return { key };
  }

  async head() {
    return null;
  }
}

class FailingR2Bucket extends FakeR2Bucket {
  override async put(
    _key: string,
    _value: ArrayBuffer | ArrayBufferView | string,
    _options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ key: string }> {
    throw new Error("R2 unavailable");
  }
}

// ---------------------------------------------------------------------------
// PNG inspection helpers (round-trip verification without a decoder dependency)
// ---------------------------------------------------------------------------

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

function parsePng(png: Uint8Array) {
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number } | undefined;
  let idat = new Uint8Array(0);
  let sawIend = false;
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...png.slice(offset + 4, offset + 8));
    const data = png.slice(offset + 8, offset + 8 + length);
    expect(view.getUint32(8 + length)).toBe(crc32(png.slice(offset + 4, offset + 8 + length)));
    if (type === "IHDR") {
      const headerView = new DataView(data.buffer, data.byteOffset);
      ihdr = { width: headerView.getUint32(0), height: headerView.getUint32(4), bitDepth: data[8], colorType: data[9] };
    } else if (type === "IDAT") {
      const merged = new Uint8Array(idat.length + data.length);
      merged.set(idat);
      merged.set(data, idat.length);
      idat = merged;
    } else if (type === "IEND") {
      sawIend = true;
    }
    offset += 12 + length;
  }
  return { ihdr, idat, sawIend };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Real unpdf boundary
// ---------------------------------------------------------------------------

describe("pdf module with the real unpdf parser", () => {
  it("extracts text, metadata, and references from supplied PDF bytes", async () => {
    const pdf = buildPdf({ title: "Demo Title", author: "Demo Author", pages: [{ text: "Hello (Open Sourcebook) PDF extraction module" }] });
    const result = await extractPdfModule(input({ url: "https://example.com/doc.pdf", pdfBytes: toArrayBuffer(pdf) }));
    expect(result?.title).toBe("Demo Title");
    expect(result?.author).toBe("Demo Author");
    expect(result?.text).toContain("Hello (Open Sourcebook) PDF extraction module");
    expect(result?.excerpt).toContain("Hello (Open Sourcebook)");
    expect(result?.accessLevel).toBe("full");
    expect(result?.depthCap).toBe("light");
    expect(result?.metadata).toMatchObject({ extraction: "unpdf-text", contentType: "application/pdf", pageCount: "1" });
    expect(result?.canonicalURL).toBe("https://example.com/doc.pdf");
    expect(result?.references?.[0]).toMatchObject({ url: "https://example.com/doc.pdf", domain: "example.com", label: "source" });
    expect(result?.assets).toBeUndefined();
    expect(result?.limitations).toEqual([]);
  });

  it("fetches the PDF over the network when only a URL is given", async () => {
    const pdf = buildPdf({ pages: [{ text: "Fetched over the wire" }] });
    const url = "https://example.com/fetched.pdf";
    const fetchImpl: FetchLike = async () => new Response(toArrayBuffer(pdf), { status: 200, headers: { "content-type": "application/pdf" } });
    const result = await extractPdfModule(input({ url, fetchImpl }));
    expect(result?.text).toContain("Fetched over the wire");
    expect(result?.accessLevel).toBe("full");
  });

  it("returns undefined when the fetch fails or the URL is unreachable", async () => {
    const failingFetch: FetchLike = async () => { throw new Error("network down"); };
    await expect(extractPdfModule(input({ url: "https://example.com/a.pdf" }))).resolves.toBeUndefined();
    await expect(extractPdfModule(input({ url: "https://example.com/a.pdf", fetchImpl: failingFetch }))).resolves.toBeUndefined();
  });

  it("returns undefined for bodies that are not PDFs", async () => {
    const html = new TextEncoder().encode("<html><body>not a pdf</body></html>");
    await expect(extractPdfModule(input({ pdfBytes: toArrayBuffer(html) }))).resolves.toBeUndefined();
    const fetchImpl: FetchLike = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    await expect(extractPdfModule(input({ url: "https://example.com/x", fetchImpl }))).resolves.toBeUndefined();
  });

  it("returns undefined for corrupt PDF bytes instead of throwing", async () => {
    const corrupt = new TextEncoder().encode("%PDF-1.4\nthis is not a real document structure\n%%EOF");
    await expect(extractPdfModule(input({ pdfBytes: toArrayBuffer(corrupt) }))).resolves.toBeUndefined();
  });

  it("returns undefined when the body exceeds maxBytes", async () => {
    const pdf = buildPdf({ pages: [{ text: "size guard" }] });
    const fetchImpl: FetchLike = async () => new Response(toArrayBuffer(pdf), { status: 200, headers: { "content-type": "application/pdf" } });
    await expect(extractPdfModule(input({ url: "https://example.com/big.pdf", fetchImpl, maxBytes: pdf.length - 1 }))).resolves.toBeUndefined();
    await expect(extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf), maxBytes: pdf.length - 1 }))).resolves.toBeUndefined();
  });

  it("reports a text-less PDF honestly as metadata-only", async () => {
    const pdf = buildPdf({ title: "Scanned Contract", pages: [{}] });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf) }));
    expect(result?.title).toBe("Scanned Contract");
    expect(result?.text).toBeUndefined();
    expect(result?.excerpt).toBeUndefined();
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.depthCap).toBe("saveOnly");
    expect(result?.metadata?.extraction).toBe("unpdf-metadata");
    expect(result?.extractionNotes?.join(" ")).toMatch(/text layer/i);
  });

  it("reaches a deep depth cap for long documents", async () => {
    const pdf = buildPdf({ pages: textPages("substantial document content ".repeat(200)) });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf) }));
    expect(result?.accessLevel).toBe("full");
    expect(result?.depthCap).toBe("deep");
    expect(result?.metadata?.pageCount).toBe("2");
  });

  it("harvests embedded images as figure assets with their page numbers", async () => {
    const pdf = buildPdf({
      pages: [{ text: "Page one has no images" }, { images: [fixtureImage(64, 64)] }],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractPdfModule(
      input({ url: "https://example.com/figures.pdf", pdfBytes: toArrayBuffer(pdf), assetStore: new AssetStore(bucket) }),
    );
    expect(result?.assets).toHaveLength(1);
    const figure = result?.assets?.[0];
    expect(figure?.kind).toBe("figure");
    expect(figure?.page).toBe(2);
    expect(figure?.contentType).toBe("image/png");
    expect(figure?.width).toBe(64);
    expect(figure?.height).toBe(64);
    expect(figure?.sourceURL).toBe("https://example.com/figures.pdf");
    expect(figure && isAssetPath(figure.url)).toBe(true);
    expect(result?.metadata?.harvestedFigures).toBe("1");
    expect(bucket.objects.size).toBe(1);
    const stored = [...bucket.objects.values()][0];
    expect(stored.httpMetadata?.contentType).toBe("image/png");
    expect(stored.customMetadata).toMatchObject({ kind: "figure", page: "2" });
    // The stored PNG decodes back to the exact pixels the PDF embedded.
    const parsed = parsePng(new Uint8Array(stored.bytes));
    expect(parsed.ihdr).toEqual({ width: 64, height: 64, bitDepth: 8, colorType: 2 });
    const scanlines = await inflate(parsed.idat);
    const expected = new Uint8Array(64 * (64 * 3 + 1));
    for (let y = 0; y < 64; y++) expected.set(fixtureImage(64, 64).subarray(y * 192, (y + 1) * 192), y * 193 + 1);
    expect(scanlines).toEqual(expected);
  });

  it("skips embedded images when no asset store is configured and says so", async () => {
    const pdf = buildPdf({ pages: [{ text: "text", images: [fixtureImage(64, 64)] }] });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf) }));
    expect(result?.assets).toBeUndefined();
    expect(result?.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });

  it("skips icon-sized images as artifacts", async () => {
    const pdf = buildPdf({ pages: [{ text: "text", images: [fixtureImage(16, 16)] }] });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf), assetStore: new AssetStore(new FakeR2Bucket()) }));
    expect(result?.assets).toBeUndefined();
    expect(result?.extractionNotes ?? []).not.toContain(expect.stringMatching(/asset store/i));
  });

  it("caps harvested figures at eight per document", async () => {
    const pdf = buildPdf({
      pages: [{ images: Array.from({ length: 9 }, () => fixtureImage(64, 64)) }],
    });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf), assetStore: new AssetStore(new FakeR2Bucket()) }));
    expect(result?.assets).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Mapping rules, exercised through a mocked parser boundary
// ---------------------------------------------------------------------------

describe("pdf module mapping with a mocked parser", () => {
  const depthCases: Array<[number, string, string]> = [
    [35_000, "veryDeep", "full"],
    [4_500, "deep", "full"],
    [700, "medium", "full"],
    [100, "light", "full"],
    [0, "saveOnly", "metadata"],
  ];

  it.each(depthCases)("maps %i chars of text to depthCap %s", async (textLength, depthCap, accessLevel) => {
    const parser = fakeParser({ text: "x".repeat(textLength), totalPages: 4, images: [] });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })), parser }));
    expect(result?.depthCap).toBe(depthCap);
    expect(result?.accessLevel).toBe(accessLevel);
  });

  it("combines supplied text with extracted text and counts both toward depth", async () => {
    const parser = fakeParser({ text: "PDF body ".repeat(80), totalPages: 1, images: [] });
    const result = await extractPdfModule(input({ sourceText: "Caller note", parser, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }));
    expect(result?.text).toMatch(/^Caller note\n\nPDF body/);
    expect(result?.depthCap).toBe("medium");
  });

  it("truncates the handoff text at maxTextChars but keeps depth honest", async () => {
    const parser = fakeParser({ text: "x".repeat(50_000), totalPages: 40, images: [] });
    const result = await extractPdfModule(input({ parser, maxTextChars: 1_000, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }));
    expect(result?.text).toHaveLength(1_000);
    expect(result?.depthCap).toBe("veryDeep");
  });

  it("keeps pages apart with a page break, empty pages included", async () => {
    const parser = fakeParser({ text: "unused", pages: ["  First   page. ", "", "Third page."], totalPages: 3, images: [] });
    const result = await extractPdfModule(input({ parser, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }));
    expect(result?.text).toBe(["First page.", "", "Third page."].join(PAGE_BREAK));
    expect(result?.excerpt).toBe("First page. Third page.");
  });

  it("reads each page of a real PDF apart", async () => {
    const pdf = buildPdf({ pages: [{ text: "Alpha on one" }, { text: "Beta on two" }] });
    const result = await extractPdfModule(input({ pdfBytes: toArrayBuffer(pdf) }));
    expect((result?.text ?? "").split("\f").map((page) => page.trim())).toEqual(["Alpha on one", "Beta on two"]);
  });

  it("maps metadata fields and omits absent ones", async () => {
    const parser = fakeParser({ text: "body", totalPages: 7, title: "  Spaced   Title ", images: [] });
    const result = await extractPdfModule(input({ parser, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }));
    expect(result?.title).toBe("Spaced Title");
    expect(result?.author).toBeUndefined();
    expect(result?.metadata?.pageCount).toBe("7");
  });

  it("persists mocked figure candidates through the asset store", async () => {
    const bytes = await encodePng(new Uint8Array(10 * 10 * 3), 10, 10, 3);
    const parser = fakeParser({
      text: "body",
      totalPages: 3,
      images: [{ bytes, contentType: "image/png", width: 10, height: 10, page: 3 }],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractPdfModule(
      input({ url: "https://example.com/paper.pdf", parser, assetStore: new AssetStore(bucket), pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]).toMatchObject({ kind: "figure", page: 3, width: 10, height: 10, contentType: "image/png", sourceURL: "https://example.com/paper.pdf" });
    expect([...bucket.objects.values()][0].customMetadata).toMatchObject({ kind: "figure", page: "3", sourceURL: "https://example.com/paper.pdf" });
  });

  it("reports a limitation when the asset store fails mid-harvest", async () => {
    const parser = fakeParser({
      text: "body",
      totalPages: 1,
      images: [{ bytes: new Uint8Array(20_000), contentType: "image/png", page: 1 }],
    });
    const result = await extractPdfModule(
      input({ parser, assetStore: new AssetStore(new FailingR2Bucket()), pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }),
    );
    expect(result?.assets).toBeUndefined();
    expect(result?.extractionNotes?.join(" ")).toMatch(/could not be persisted/i);
  });

  it("returns undefined when the parser itself fails", async () => {
    const parser: PdfParser = { parse: async () => { throw new Error("boom"); } };
    await expect(extractPdfModule(input({ parser, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }))).resolves.toBeUndefined();
  });

  it("runs text-only for very large PDFs: skips figure extraction but keeps the text layer (cursed GPT-3 paper, 75pp)", async () => {
    const small = await encodePng(new Uint8Array(10 * 10 * 3), 10, 10, 3);
    const parser = fakeParser({
      text: "x".repeat(4_500),
      totalPages: 75,
      images: [{ bytes: small, contentType: "image/png", width: 10, height: 10, page: 3 }],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractPdfModule(
      input({ url: "https://arxiv.org/pdf/2005.14165", parser, assetStore: new AssetStore(bucket), pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }),
    );
    expect(result?.text).toMatch(/x{4500}/);
    expect(result?.assets).toBeUndefined();
    expect(bucket.objects.size).toBe(0);
    expect(result?.extractionNotes?.join(" ")).toMatch(/60 pages/);
  });

  it("skips single images above the raw-byte cap and says so", async () => {
    const parser = fakeParser({
      text: "body",
      totalPages: 1,
      images: [{ bytes: new Uint8Array(25 * 1024 * 1024), contentType: "image/png", width: 4000, height: 2000, page: 1 }],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractPdfModule(
      input({ parser, assetStore: new AssetStore(bucket), pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }),
    );
    expect(result?.assets).toBeUndefined();
    expect(bucket.objects.size).toBe(0);
    expect(result?.extractionNotes?.join(" ")).toMatch(/Oversized/);
  });

  it("stops harvesting once the cumulative decoded-bytes budget is exceeded", async () => {
    const parser = fakeParser({
      text: "body",
      totalPages: 4,
      images: [
        { bytes: new Uint8Array(13 * 1024 * 1024), contentType: "image/png", width: 1000, height: 1000, page: 1 },
        { bytes: new Uint8Array(13 * 1024 * 1024), contentType: "image/png", width: 1000, height: 1000, page: 2 },
      ],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractPdfModule(
      input({ parser, assetStore: new AssetStore(bucket), pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]).toMatchObject({ page: 1 });
    expect(result?.extractionNotes?.join(" ")).toMatch(/budget exceeded/);
  });

  it("passes the bounded-memory limits through to the parser", async () => {
    let seenOptions: PdfParserOptions | undefined;
    const recordingParser: PdfParser = {
      async parse(data, options) {
        seenOptions = options;
        return { text: "body", totalPages: 1, images: [] };
      },
    };
    await extractPdfModule(input({ parser: recordingParser, pdfBytes: toArrayBuffer(buildPdf({ pages: [{ text: "ignored" }] })) }));
    expect(seenOptions).toMatchObject({ maxImages: 8, minImageBytes: 10_000, maxImageRawBytes: 24 * 1024 * 1024, maxTotalDecodedBytes: 24 * 1024 * 1024 });
  });
});

// ---------------------------------------------------------------------------
// encodePng
// ---------------------------------------------------------------------------

describe("encodePng", () => {
  it("round-trips RGB pixels through a standards-compliant PNG", async () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const png = await encodePng(pixels, 2, 2, 3);
    const { ihdr, idat, sawIend } = parsePng(png);
    expect(ihdr).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: 2 });
    expect(sawIend).toBe(true);
    const scanlines = await inflate(idat);
    expect(Array.from(scanlines)).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("uses the grayscale and alpha color types for 1- and 4-channel input", async () => {
    const gray = await encodePng(new Uint8Array(4), 2, 2, 1);
    expect(parsePng(gray).ihdr?.colorType).toBe(0);
    const rgba = await encodePng(new Uint8Array(16), 2, 2, 4);
    expect(parsePng(rgba).ihdr?.colorType).toBe(6);
  });
});
