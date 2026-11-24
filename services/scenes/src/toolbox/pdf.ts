/**
 * Reading a PDF: the words of the pages asked for, the pictures embedded in them, and any page drawn as a picture (a
 * diagram, a table, a figure with its caption), with pdf.js through unpdf and its Node canvas. A PDF is downloaded once
 * per video and kept in the job's folder.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { extractImages, extractText, getDocumentProxy, renderPageAsImage } from "unpdf";

const run = promisify(execFile);

export async function pageCount(bytes: Buffer): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  return pdf.numPages;
}

/** The words of each page, 1-based. */
export async function pagesText(bytes: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t) => t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
}

/** One page drawn as a PNG, about 1600 pixels wide. */
export async function pagePicture(bytes: Buffer, page: number, out: string): Promise<void> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const p = await pdf.getPage(page);
  const width = p.getViewport({ scale: 1 }).width;
  const png = await renderPageAsImage(pdf, page, { canvasImport: () => import("@napi-rs/canvas"), scale: Math.min(4, 1600 / Math.max(1, width)) });
  writeFileSync(out, Buffer.from(png));
}

/** The pictures embedded in a page that are large enough to show, each written as a PNG; returns their files and sizes. */
export async function pageFigures(bytes: Buffer, page: number, outBase: string): Promise<{ file: string; width: number; height: number }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const images = await extractImages(pdf, page);
  const out: { file: string; width: number; height: number }[] = [];
  for (const [i, img] of images.entries()) {
    if (img.width < 200 || img.height < 200 || img.width * img.height * img.channels > 48e6) continue;
    const file = `${outBase}-${i + 1}.png`;
    const format = img.channels === 4 ? "rgba" : img.channels === 3 ? "rgb24" : "gray";
    const raw = `${file}.raw`;
    writeFileSync(raw, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    await run("ffmpeg", ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", format, "-s", `${img.width}x${img.height}`, "-i", raw, "-frames:v", "1", "-update", "1", file], { timeout: 60_000 });
    out.push({ file, width: img.width, height: img.height });
    if (out.length >= 8) break;
  }
  return out;
}

/** Pages from words like "3", "2-5", "1,4,7-9", inside 1..total, at most `max`. */
export function parsePages(spec: unknown, total: number, max: number): number[] {
  const words = typeof spec === "number" ? String(spec) : typeof spec === "string" && spec.trim() ? spec : "1-3";
  const pages: number[] = [];
  for (const part of words.split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    if (!Number.isInteger(a)) continue;
    const end = Number.isInteger(b) ? b! : a!;
    for (let p = a!; p <= end && pages.length < max; p++) if (p >= 1 && p <= total && !pages.includes(p)) pages.push(p);
  }
  return pages;
}
