/**
 * Google Drive, Docs, Slides and Sheets links shared with anyone who has
 * the link (engine/docs/api.md, "Sources from a folder and from Google
 * Drive"): each link form maps to its public export, the export is read as
 * a file of its type with pages kept, and a link that is not shared or a
 * folder fails with one plain line that names no service.
 */
import { describe, expect, it } from "vitest";
import { createSourceExtractor } from "../src/extract";
import { driveLink, FOLDER_LINK, NOT_SHARED } from "../src/extract/ladders/drive";
import { guardedFetch } from "../src/guard";
import { PAGE_BREAK, type FetchLike } from "../src/types";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A one-page-per-text PDF with a valid cross-reference table. */
function pdfOf(pages: string[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const font = 3 + pages.length * 2;
  const kids: string[] = [];
  pages.forEach((text, index) => {
    const page = 3 + index * 2;
    kids.push(`${page} 0 R`);
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[page - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
    objects[page] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects[font - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/** A fetch that answers each export URL as given and records what was asked. */
function exports(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    return answer ? answer() : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  };
  return { asked, fetchImpl };
}

const read = (url: string, fetchImpl: FetchLike) => createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });

describe("each Drive link form maps to its export", () => {
  it.each([
    [`https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`, "document", `https://docs.google.com/document/d/${DOC_ID}/export?format=pdf`],
    [`https://docs.google.com/document/u/1/d/${DOC_ID}/view`, "document", `https://docs.google.com/document/d/${DOC_ID}/export?format=pdf`],
    [`https://docs.google.com/presentation/d/${DOC_ID}/edit#slide=id.p`, "slides", `https://docs.google.com/presentation/d/${DOC_ID}/export?format=pdf`],
    [`https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0`, "sheet", `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=xlsx`],
    [`https://drive.google.com/file/d/${DOC_ID}/view?usp=drive_link`, "file", `https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download`],
    [`https://drive.google.com/open?id=${DOC_ID}`, "file", `https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download`],
    [`https://drive.google.com/uc?id=${DOC_ID}&export=download`, "file", `https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download`],
  ])("%s", (url, kind, exportURL) => {
    expect(driveLink(url)).toEqual({ kind, id: DOC_ID, exportURL });
  });

  it("knows a folder, and leaves forms, published pages and other hosts alone", () => {
    expect(driveLink(`https://drive.google.com/drive/folders/${DOC_ID}?usp=sharing`)).toEqual({ kind: "folder" });
    expect(driveLink(`https://drive.google.com/drive/u/0/folders/${DOC_ID}`)).toEqual({ kind: "folder" });
    expect(driveLink(`https://docs.google.com/forms/d/${DOC_ID}/viewform`)).toBeUndefined();
    expect(driveLink(`https://docs.google.com/document/d/e/${DOC_ID}/pub`)).toBeUndefined();
    expect(driveLink(`https://example.com/document/d/${DOC_ID}/edit`)).toBeUndefined();
    expect(driveLink("https://drive.google.com/open?id=x")).toBeUndefined();
  });
});

describe("a shared link is read as its file", () => {
  it("reads a document's PDF export with its pages kept, under the link it was given", async () => {
    const link = `https://docs.google.com/document/d/${DOC_ID}/edit`;
    const { asked, fetchImpl } = exports({
      [`https://docs.google.com/document/d/${DOC_ID}/export?format=pdf`]: () => new Response(pdfOf(["The heart has four chambers.", "Blood leaves by the aorta."]) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/pdf" } }),
    });
    const envelope = await read(link, fetchImpl);
    expect(asked).toEqual([`https://docs.google.com/document/d/${DOC_ID}/export?format=pdf`]);
    expect(envelope.kind).toBe("pdf");
    expect(envelope.text).toContain("four chambers");
    expect(envelope.text).toContain(PAGE_BREAK);
    expect(envelope.accessLevel).not.toBe("none");
    expect(envelope).toMatchObject({ originalURL: link, canonicalURL: link, sourceDomain: "docs.google.com", metadata: expect.objectContaining({ drive: "document" }) });
    expect(envelope.limitations).toEqual([]);
  });

  it("hands a sheet's export to the spreadsheet reading, and a Drive file to the reading of its type", async () => {
    const sheet = exports({ [`https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=xlsx`]: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": XLSX } }) });
    const fromSheet = await read(`https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`, sheet.fetchImpl);
    expect(sheet.asked).toEqual([`https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=xlsx`]);
    expect(fromSheet.metadata).toMatchObject({ contentType: XLSX, drive: "sheet" });

    const file = exports({
      [`https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download`]: () =>
        new Response("Notes on the heart.\n\nIt beats about seventy times a minute.", { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="heart notes.md"' } }),
    });
    const fromFile = await read(`https://drive.google.com/file/d/${DOC_ID}/view`, file.fetchImpl);
    expect(fromFile.text).toContain("seventy times a minute");
    expect(fromFile.metadata).toMatchObject({ drive: "file" });
  });
});

describe("a link Open Sourcebook can't read says what to do, in one plain line", () => {
  it("a sign-in page means the file is not shared with anyone who has the link", async () => {
    const { fetchImpl } = exports({
      [`https://docs.google.com/document/d/${DOC_ID}/export?format=pdf`]: () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const envelope = await read(`https://docs.google.com/document/d/${DOC_ID}/edit`, fetchImpl);
    expect(envelope.accessLevel).toBe("none");
    expect(envelope.text).toBe("");
    expect(envelope.limitations).toEqual([NOT_SHARED]);
    // A refusal says the same.
    const refused = await read(`https://drive.google.com/file/d/${DOC_ID}/view`, exports({}).fetchImpl);
    expect(refused.limitations).toEqual([NOT_SHARED]);
  });

  it("a folder link fails with its own line, and nothing is fetched", async () => {
    const { asked, fetchImpl } = exports({});
    const envelope = await read(`https://drive.google.com/drive/folders/${DOC_ID}`, fetchImpl);
    expect(asked).toEqual([]);
    expect(envelope.accessLevel).toBe("none");
    expect(envelope.limitations).toEqual([FOLDER_LINK]);
  });

  it("never names a service in what the person reads", () => {
    for (const line of [NOT_SHARED, FOLDER_LINK]) expect(line).not.toMatch(/google|drive|docs|sheets|slides/i);
  });

  it("goes through the same address checks as every link", async () => {
    const inner: FetchLike = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret.pdf" } });
    const envelope = await read(`https://docs.google.com/document/d/${DOC_ID}/edit`, guardedFetch(inner, { resolve: async () => ["142.250.0.1"] }));
    expect(envelope.accessLevel).toBe("none");
    expect(envelope.limitations[0]).toMatch(/could not be downloaded/);
  });
});
