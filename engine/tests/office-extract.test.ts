import { describe, expect, it } from "vitest";
import { AssetStore, isAssetPath } from "../src/assets";
import { createSourceExtractor } from "../src/extract";
import { extractOfficeModule, type ExtractOfficeInput } from "../src/extract/office";
import type { FetchLike, R2BucketLike } from "../src/types";

// ---------------------------------------------------------------------------
// Minimal ZIP fixture builder. Writes byte-accurate archives (store method by
// default, raw deflate when requested) so the real reader is exercised
// end-to-end without binary fixtures.
// ---------------------------------------------------------------------------

interface FixtureEntry {
  name: string;
  data: Uint8Array;
  /** Compress with raw DEFLATE (ZIP method 8) instead of storing. */
  deflate?: boolean;
  /** Override the compression method byte; the payload is then written as-is. */
  methodOverride?: number;
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

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(new Blob([toArrayBuffer(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
  );
}

async function buildZip(entries: FixtureEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const stored = entry.deflate ? await deflateRaw(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const method = entry.methodOverride ?? (entry.deflate ? 8 : 0);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true); // mod time
    localView.setUint16(12, 0, true); // mod date
    localView.setUint32(14, crc, true);
    localView.setUint32(18, stored.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    chunks.push(local, stored);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(4, 20, true); // version made by
    headerView.setUint16(6, 20, true); // version needed
    headerView.setUint16(8, 0, true); // flags
    headerView.setUint16(10, method, true);
    headerView.setUint16(12, 0, true);
    headerView.setUint16(14, 0, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, stored.length, true);
    headerView.setUint32(24, entry.data.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true); // extra length
    headerView.setUint16(32, 0, true); // comment length
    headerView.setUint16(34, 0, true); // disk number
    headerView.setUint16(36, 0, true); // internal attributes
    headerView.setUint32(38, 0, true); // external attributes
    headerView.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);

    offset += local.length + stored.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true); // entries on this disk
  eocdView.setUint16(10, entries.length, true); // entries total
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  const bytes = new Uint8Array(centralOffset + centralSize + eocd.length);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}

function xml(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Plausible PNG bytes: real magic, padded past the 10KB icon floor. */
function fixtureImage(bytes = 12_000): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 8; i < data.length; i++) data[i] = (i * 17) % 256;
  return data;
}

// ---------------------------------------------------------------------------
// Office fixtures
// ---------------------------------------------------------------------------

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly Revenue Plan</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew 12% quarter over quarter &amp; beat plan.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Risks</w:t></w:r></w:p>
<w:p><w:r><w:t>Hiring</w:t></w:r><w:r><w:tab/><w:t>remains the top risk.</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$1.2M</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>South</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$0.9M</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body>
</w:document>`;

const CORE_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Quarterly Revenue Plan</dc:title>
<dc:creator>Ada Lovelace</dc:creator>
</cp:coreProperties>`;

/** document.xml is deflated so tests exercise the inflate path, not just store. */
async function buildDocx(overrides: { documentXml?: string; images?: FixtureEntry[] } = {}): Promise<Uint8Array> {
  return buildZip([
    { name: "[Content_Types].xml", data: xml(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "docProps/core.xml", data: xml(CORE_PROPS) },
    { name: "word/document.xml", data: xml(overrides.documentXml ?? DOCX_DOCUMENT), deflate: true },
    ...(overrides.images ?? []),
  ]);
}

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Revenue" sheetId="1" r:id="rId1"/>
<sheet name="Costs" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`;

const XLSX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;

const XLSX_SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
<si><t>Product</t></si>
<si><t>Region</t></si>
<si><t>Widget</t></si>
<si><r><t>Gad</t></r><r><t>get</t></r></si>
<si><t>Hosting</t></si>
</sst>`;

const XLSX_SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Notes</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>
<row r="3"><c r="C3" t="s"><v>3</v></c></row>
</sheetData>
</worksheet>`;

const XLSX_SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1"><v>1200</v></c></row>
</sheetData>
</worksheet>`;

/** sharedStrings.xml is deflated to keep the inflate path under test. */
async function buildXlsx(): Promise<Uint8Array> {
  return buildZip([
    { name: "xl/workbook.xml", data: xml(XLSX_WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", data: xml(XLSX_RELS) },
    { name: "xl/sharedStrings.xml", data: xml(XLSX_SHARED_STRINGS), deflate: true },
    { name: "xl/worksheets/sheet1.xml", data: xml(XLSX_SHEET1) },
    { name: "xl/worksheets/sheet2.xml", data: xml(XLSX_SHEET2) },
  ]);
}

const PPTX_SLIDE1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>Launch Plan</a:t></a:r></a:p><a:p><a:r><a:t>Phase one ships in September</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`;

const PPTX_SLIDE2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>Phase two adds &quot;enterprise&quot; tiers</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`;

/** slide2.xml is deflated to keep the inflate path under test. */
async function buildPptx(options: { images?: FixtureEntry[] } = {}): Promise<Uint8Array> {
  return buildZip([
    { name: "ppt/presentation.xml", data: xml(`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`) },
    { name: "ppt/slides/slide1.xml", data: xml(PPTX_SLIDE1) },
    { name: "ppt/slides/slide2.xml", data: xml(PPTX_SLIDE2), deflate: true },
    ...(options.images ?? []),
  ]);
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const notFoundFetch: FetchLike = async () => new Response("missing", { status: 404 });

function input(overrides: Partial<ExtractOfficeInput> = {}): ExtractOfficeInput {
  return {
    sourceText: "",
    fetchImpl: notFoundFetch,
    timeoutMs: 5_000,
    maxBytes: 5_000_000,
    maxTextChars: 24_000,
    ...overrides,
  };
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
// DOCX
// ---------------------------------------------------------------------------

describe("office module with DOCX bytes", () => {
  it("extracts paragraphs, headings, and tables from a deflated document.xml", async () => {
    const docx = await buildDocx();
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx), filename: "plan.docx" }));
    expect(result?.title).toBe("Quarterly Revenue Plan");
    expect(result?.author).toBe("Ada Lovelace");
    expect(result?.text).toContain("# Quarterly Revenue Plan");
    expect(result?.text).toContain("# Overview");
    expect(result?.text).toContain("## Risks");
    expect(result?.text).toContain("Revenue grew 12% quarter over quarter & beat plan.");
    expect(result?.text).toContain("Hiring\tremains the top risk.");
    expect(result?.text).toContain("Region\tRevenue");
    expect(result?.text).toContain("North\t$1.2M");
    expect(result?.text).toContain("South\t$0.9M");
    expect(result?.excerpt).toContain("Quarterly Revenue Plan");
    expect(result?.accessLevel).toBe("full");
    expect(result?.depthCap).toBe("light");
    expect(result?.metadata).toMatchObject({
      extraction: "office-docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      paragraphCount: "5",
    });
    expect(result?.assets).toBeUndefined();
    expect(result?.limitations).toEqual([]);
  });

  it("harvests embedded media as image assets and skips icon-sized files", async () => {
    const docx = await buildDocx({
      images: [
        { name: "word/media/image1.png", data: fixtureImage(), deflate: true },
        { name: "word/media/bullet.gif", data: new Uint8Array(400) },
      ],
    });
    const bucket = new FakeR2Bucket();
    const result = await extractOfficeModule(
      input({ url: "https://example.com/plan.docx", bytes: toArrayBuffer(docx), assetStore: new AssetStore(bucket) }),
    );
    expect(result?.assets).toHaveLength(1);
    const image = result?.assets?.[0];
    expect(image?.kind).toBe("image");
    expect(image?.contentType).toBe("image/png");
    expect(image?.caption).toBe("word/media/image1.png");
    expect(image?.sourceURL).toBe("https://example.com/plan.docx");
    expect(image && isAssetPath(image.url)).toBe(true);
    expect(result?.metadata?.harvestedImages).toBe("1");
    expect(result?.canonicalURL).toBe("https://example.com/plan.docx");
    expect(result?.references?.[0]).toMatchObject({ url: "https://example.com/plan.docx", domain: "example.com", label: "source" });
    expect(bucket.objects.size).toBe(1);
    const stored = [...bucket.objects.values()][0];
    expect(stored.httpMetadata?.contentType).toBe("image/png");
    expect(stored.customMetadata).toMatchObject({ kind: "image", sourceURL: "https://example.com/plan.docx" });
    expect(new Uint8Array(stored.bytes)).toEqual(fixtureImage());
  });

  it("skips embedded media when no asset store is configured and says so", async () => {
    const docx = await buildDocx({ images: [{ name: "word/media/image1.png", data: fixtureImage() }] });
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx) }));
    expect(result?.assets).toBeUndefined();
    expect(result?.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });

  it("reports a limitation when the asset store fails mid-harvest", async () => {
    const docx = await buildDocx({ images: [{ name: "word/media/image1.png", data: fixtureImage() }] });
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx), assetStore: new AssetStore(new FailingR2Bucket()) }));
    expect(result?.assets).toBeUndefined();
    expect(result?.extractionNotes?.join(" ")).toMatch(/could not be persisted/i);
  });

  it("combines supplied text with extracted text and counts both toward depth", async () => {
    const docx = await buildDocx();
    const result = await extractOfficeModule(input({ sourceText: "Caller note", bytes: toArrayBuffer(docx) }));
    expect(result?.text).toMatch(/^Caller note\n\n# Quarterly Revenue Plan/);
    expect(result?.depthCap).toBe("light");
  });

  const depthCases: Array<[number, string]> = [
    [31_000, "veryDeep"],
    [4_500, "deep"],
    [700, "medium"],
    [100, "light"],
  ];

  it.each(depthCases)("maps %i chars of document text to depthCap %s", async (textLength, depthCap) => {
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"x".repeat(textLength)}</w:t></w:r></w:p></w:body></w:document>`;
    const docx = await buildDocx({ documentXml });
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx) }));
    expect(result?.depthCap).toBe(depthCap);
    expect(result?.accessLevel).toBe("full");
  });

  it("reports a text-less document honestly as metadata-only", async () => {
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`;
    const docx = await buildDocx({ documentXml });
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx) }));
    expect(result?.title).toBe("Quarterly Revenue Plan");
    expect(result?.text).toBeUndefined();
    expect(result?.excerpt).toBeUndefined();
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.depthCap).toBe("saveOnly");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no extractable text/i);
  });

  it("truncates the handoff text at maxTextChars but keeps depth honest", async () => {
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"x".repeat(50_000)}</w:t></w:r></w:p></w:body></w:document>`;
    const docx = await buildDocx({ documentXml });
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(docx), maxTextChars: 1_000 }));
    expect(result?.text).toHaveLength(1_000);
    expect(result?.depthCap).toBe("veryDeep");
  });
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

describe("office module with XLSX bytes", () => {
  it("extracts shared strings, inline strings, numbers, and booleans as TSV rows", async () => {
    const xlsx = await buildXlsx();
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(xlsx) }));
    expect(result?.metadata).toMatchObject({
      extraction: "office-xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheetCount: "2",
    });
    expect(result?.text).toContain("Sheet: Revenue\nProduct\tRegion\tNotes");
    expect(result?.text).toContain("Widget\t42\tTRUE");
    // Rich-text shared string runs are concatenated; the sparse row keeps column alignment.
    expect(result?.text).toContain("\t\tGadget");
    expect(result?.text).toContain("Sheet: Costs\nHosting\t1200");
    expect(result?.accessLevel).toBe("full");
    expect(result?.limitations).toEqual([]);
  });

  it("resolves sheets numerically when the workbook rels are missing", async () => {
    const xlsx = await buildZip([
      { name: "xl/workbook.xml", data: xml(XLSX_WORKBOOK) },
      { name: "xl/worksheets/sheet2.xml", data: xml(XLSX_SHEET2) },
      { name: "xl/worksheets/sheet1.xml", data: xml(XLSX_SHEET1) },
      { name: "xl/sharedStrings.xml", data: xml(XLSX_SHARED_STRINGS) },
    ]);
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(xlsx) }));
    expect(result?.metadata?.sheetCount).toBe("2");
    expect(result?.text).toContain("Product\tRegion\tNotes");
    expect(result?.text?.indexOf("Widget")).toBeLessThan(result?.text?.indexOf("Hosting") ?? 0);
  });

  it("truncates worksheets at the row cap and says so", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
    const xlsx = await buildZip([
      { name: "xl/workbook.xml", data: xml(XLSX_WORKBOOK.replace(/<sheet name="Costs"[^>]*>/, "")) },
      { name: "xl/_rels/workbook.xml.rels", data: xml(XLSX_RELS.replace(/<Relationship Id="rId2"[^>]*>/, "")) },
      { name: "xl/worksheets/sheet1.xml", data: xml(sheet) },
    ]);
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(xlsx) }));
    // Rows hold values 0..599; the cap keeps the first 500 rows.
    expect(result?.text).toContain("499");
    expect(result?.text).not.toContain("500");
    expect(result?.extractionNotes?.join(" ")).toMatch(/truncated at 500 rows/i);
    expect(result?.metadata?.sheetCount).toBe("1");
  });

  it("truncates workbooks at the sheet cap and says so", async () => {
    const sheetNames = Array.from({ length: 12 }, (_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const rels = Array.from({ length: 12 }, (_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
    const xlsx = await buildZip([
      { name: "xl/workbook.xml", data: xml(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetNames}</sheets></workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", data: xml(`<?xml version="1.0"?><Relationships>${rels}</Relationships>`) },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(sheet) })),
    ]);
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(xlsx) }));
    expect(result?.metadata?.sheetCount).toBe("10");
    expect(result?.extractionNotes?.join(" ")).toMatch(/truncated at 10 sheets/i);
  });
});

// ---------------------------------------------------------------------------
// Upload ladder: the detected office format specializes a generic caller kind
// ---------------------------------------------------------------------------

describe("office uploads through the extractor ladder", () => {
  const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  it("specializes a generic caller kind to spreadsheet for xlsx bytes", async () => {
    const xlsx = await buildXlsx();
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "text",
      uploadBytes: { bytes: toArrayBuffer(xlsx), contentType: XLSX_CONTENT_TYPE, filename: "data.xlsx" },
    });
    expect(source.metadata.extraction).toBe("office-xlsx");
    expect(source.kind).toBe("spreadsheet");
    expect(source.text).toContain("Widget\t42\tTRUE");
    expect(source.accessLevel).toBe("full");
  });

  it("keeps an explicit caller kind for xlsx bytes", async () => {
    const xlsx = await buildXlsx();
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "note",
      uploadBytes: { bytes: toArrayBuffer(xlsx), contentType: XLSX_CONTENT_TYPE, filename: "data.xlsx" },
    });
    expect(source.metadata.extraction).toBe("office-xlsx");
    expect(source.kind).toBe("note");
  });

  it("leaves a generic caller kind alone for docx bytes", async () => {
    const docx = await buildDocx();
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "text",
      uploadBytes: { bytes: toArrayBuffer(docx), contentType: DOCX_CONTENT_TYPE, filename: "memo.docx" },
    });
    expect(source.metadata.extraction).toBe("office-docx");
    expect(source.kind).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

describe("office module with PPTX bytes", () => {
  it("extracts text per slide, including deflated slide XML", async () => {
    const pptx = await buildPptx();
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(pptx), filename: "deck.pptx" }));
    expect(result?.metadata).toMatchObject({
      extraction: "office-pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      slideCount: "2",
    });
    expect(result?.text).toContain("Launch Plan\nPhase one ships in September");
    expect(result?.text).toContain(`Phase two adds "enterprise" tiers`);
    expect(result?.text?.indexOf("Launch Plan")).toBeLessThan(result?.text?.indexOf("Phase two") ?? 0);
    expect(result?.accessLevel).toBe("full");
    expect(result?.limitations).toEqual([]);
  });

  it("harvests slide media as image assets", async () => {
    const pptx = await buildPptx({ images: [{ name: "ppt/media/image1.jpeg", data: fixtureImage(11_000) }] });
    const bucket = new FakeR2Bucket();
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(pptx), assetStore: new AssetStore(bucket) }));
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]).toMatchObject({ kind: "image", contentType: "image/jpeg", caption: "ppt/media/image1.jpeg" });
    expect(result?.metadata?.harvestedImages).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Fetching, detection, and failure modes
// ---------------------------------------------------------------------------

describe("office module byte resolution and failure modes", () => {
  it("fetches the document over the network when only a URL is given", async () => {
    const docx = await buildDocx();
    const fetchImpl: FetchLike = async () =>
      new Response(toArrayBuffer(docx), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      });
    const result = await extractOfficeModule(input({ url: "https://example.com/files/plan.docx", fetchImpl }));
    expect(result?.text).toContain("Revenue grew 12%");
    expect(result?.metadata?.extraction).toBe("office-docx");
    expect(result?.canonicalURL).toBe("https://example.com/files/plan.docx");
  });

  it("detects the format from the content type when the filename is absent", async () => {
    const xlsx = await buildXlsx();
    const result = await extractOfficeModule(
      input({ bytes: toArrayBuffer(xlsx), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
    expect(result?.metadata?.extraction).toBe("office-xlsx");
  });

  it("sniffs the format from archive entries when no hints are given", async () => {
    const pptx = await buildPptx();
    const result = await extractOfficeModule(input({ bytes: toArrayBuffer(pptx) }));
    expect(result?.metadata?.extraction).toBe("office-pptx");
  });

  it("returns undefined when the fetch fails or the URL is unreachable", async () => {
    const failingFetch: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(extractOfficeModule(input({ url: "https://example.com/a.docx" }))).resolves.toBeUndefined();
    await expect(extractOfficeModule(input({ url: "https://example.com/a.docx", fetchImpl: failingFetch }))).resolves.toBeUndefined();
  });

  it("returns undefined for bodies that are not ZIP archives", async () => {
    const html = new TextEncoder().encode("<html><body>not an office file</body></html>");
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(html), filename: "a.docx" }))).resolves.toBeUndefined();
    const fetchImpl: FetchLike = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    await expect(extractOfficeModule(input({ url: "https://example.com/a.docx", fetchImpl }))).resolves.toBeUndefined();
  });

  it("returns undefined for corrupt ZIP bytes instead of throwing", async () => {
    const corrupt = new Uint8Array(64);
    corrupt.set([0x50, 0x4b, 0x03, 0x04]);
    for (let i = 4; i < corrupt.length; i++) corrupt[i] = (i * 13) % 256;
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(corrupt) }))).resolves.toBeUndefined();
  });

  it("returns undefined for valid ZIPs that are not Office documents", async () => {
    const zip = await buildZip([{ name: "hello.txt", data: xml("hello world") }]);
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(zip) }))).resolves.toBeUndefined();
  });

  it("returns undefined when the body exceeds maxBytes", async () => {
    const docx = await buildDocx();
    const fetchImpl: FetchLike = async () => new Response(toArrayBuffer(docx), { status: 200 });
    await expect(extractOfficeModule(input({ url: "https://example.com/big.docx", fetchImpl, maxBytes: docx.length - 1 }))).resolves.toBeUndefined();
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(docx), maxBytes: docx.length - 1 }))).resolves.toBeUndefined();
  });

  it("returns undefined when a deflated entry fails to inflate", async () => {
    // 0xFF as the first deflate byte selects the reserved block type, so
    // inflation always fails; document.xml is then unreadable.
    const docx = await buildDocx({ images: [] });
    const broken = await buildZip([
      { name: "docProps/core.xml", data: xml(CORE_PROPS) },
      { name: "word/document.xml", data: new Uint8Array(64).fill(0xff), methodOverride: 8 },
    ]);
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(docx) }))).resolves.toBeDefined();
    await expect(extractOfficeModule(input({ bytes: toArrayBuffer(broken) }))).resolves.toBeUndefined();
  });
});
