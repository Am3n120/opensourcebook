/**
 * What a source holds after it is read: nothing read is a failed source, not
 * a ready one; an uploaded text file is read as text; pasted text without a
 * title is named from its own first line; a page that is not there, or a
 * host that does not answer, is never stored as the browser's error page;
 * notes beside a page's text are not part of it.
 */
import { describe, expect, it } from "vitest";
import { extractUpload } from "../src/extract/ladders/upload";
import { titleFromText } from "../src/extract/context";
import { createSourceExtractor } from "../src/extract";
import { ABOUT_ONLY_READ, PART_READ, withAccessExplained } from "../src/extract/limits";
import { isMissingPage, renderPageHTML } from "../src/extract/render";
import { extractWebModule } from "../src/extract/web";
import { isTextFile } from "../src/extract/kinds";
import type { BrowserBindingLike, BrowserPageLike, FetchLike } from "../src/types";
import { FakeExtractor, createTestEngine } from "./support/engine-harness";

const NOW = () => "2026-11-13T09:00:00.000Z";
const ladder = { options: { timeoutMs: 1000, maxTextChars: 400_000, maxBytes: 1_000_000, pdfMaxBytes: 1_000_000 } } as never;

describe("a source with nothing read", () => {
  it("fails with the reason in words instead of showing as ready", async () => {
    const extractor = new FakeExtractor({
      "https://example.com/gone": { text: "", accessLevel: "none", limitations: ["Web page could not be fetched; only caller-supplied text is available"] },
    });
    const engine = createTestEngine({ extractor });
    const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/gone" });
    await expect(engine.deps.sources.ensureExtracted(source)).rejects.toThrow("Nothing could be read from this source. Web page could not be fetched.");
    expect(await engine.deps.repos.sources.getExtraction(source.contentHash)).toMatchObject({
      status: "failed",
      errorMessage: "Nothing could be read from this source. Web page could not be fetched.",
    });
  });

  it("keeps a source whose page gave only its title as ready", async () => {
    const extractor = new FakeExtractor({ "https://example.com/thin": { text: "A title only", accessLevel: "metadata" } });
    const engine = createTestEngine({ extractor });
    const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/thin" });
    expect((await engine.deps.sources.ensureExtracted(source)).envelope.text).toBe("A title only");
  });
});

describe("uploaded text files", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it("are read as they are, by type or, when sent untyped, by name", async () => {
    for (const [contentType, filename] of [["text/markdown", "cells.md"], ["text/plain", "plates.txt"], ["application/octet-stream", "notes.md"], ["", "notes.txt"]]) {
      const envelope = await extractUpload(ladder, "", "text", { bytes: bytes("# Cells\n\nGlycolysis splits glucose."), contentType: contentType!, filename: filename! }, undefined, undefined, NOW);
      expect(envelope.text).toContain("Glycolysis splits glucose.");
      expect(envelope.accessLevel).not.toBe("none");
    }
    expect(isTextFile("application/octet-stream", "photo.png")).toBe(false);
    expect(isTextFile("text/csv; charset=utf-8", undefined)).toBe(true);
  });

  it("become text sources named by their file", async () => {
    const engine = createTestEngine();
    const upload = await engine.deps.uploads.putUpload(new TextEncoder().encode("Plate tectonics\n\nPlates move.").buffer as ArrayBuffer, "text/markdown", "plates.md");
    const { source } = await engine.deps.sources.add({ ownerId: "owner", uploadId: upload!.id });
    expect(source.kind).toBe("text");
    // Before it is read, the file's own name; never "Text file".
    expect(source.title).toBe("plates");
  });

  it("are titled by their first heading, or a clear first line", async () => {
    const read = (text: string, filename: string, contentType = "text/markdown") =>
      extractUpload(ladder, "", "text", { bytes: bytes(text), contentType, filename }, undefined, undefined, NOW);
    expect((await read("Some intro words before it all.\n\n## Spaced *practice*\n\nSpread it out.", "notes.md")).title).toBe("Spaced practice");
    expect((await read("Retrieval practice\n\nTesting yourself helps you remember.", "notes.txt", "text/plain")).title).toBe("Retrieval practice");
    expect((await read(`${"word ".repeat(40)}and no stop at all`, "notes.txt", "text/plain")).title).toBeUndefined();
  });
});

describe("how much of a source was read", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const extractor = createSourceExtractor();

  it("is full for a short text file read whole, with nothing to explain", async () => {
    const note = "# Spacing\n\nSpread study over days. ".padEnd(441, "Review what you learned. ");
    for (const [contentType, filename] of [["text/markdown", "spacing.md"], ["text/plain", "spacing.txt"]]) {
      const envelope = await extractor.extract({ sourceText: "", sourceKind: "text", uploadBytes: { bytes: bytes(note), contentType: contentType!, filename: filename! } });
      expect(envelope).toMatchObject({ accessLevel: "full", limitations: [] });
    }
  });

  it("is partial for a text file cut short, and says so", async () => {
    const long = "Spread study over days. ".repeat(50);
    const read = await extractUpload({ options: { ...(ladder as { options: object }).options, maxTextChars: 200 } } as never, "", "text", { bytes: bytes(long), contentType: "text/plain", filename: "long.txt" }, undefined, undefined, NOW);
    expect(read.accessLevel).toBe("partial");
    expect(read.limitations).toEqual(["Only the start of this file was read; it is too long to read whole."]);
  });

  it("is never partial or title-only with nothing saying why", () => {
    const base = { originalText: "", kind: "web" as const, text: "x", references: [], metadata: {}, depthCap: "light" as const, extractionNotes: [], fetchedAt: "" };
    expect(withAccessExplained({ ...base, accessLevel: "partial", limitations: [] }).limitations).toEqual([PART_READ]);
    expect(withAccessExplained({ ...base, accessLevel: "metadata", limitations: [] }).limitations).toEqual([ABOUT_ONLY_READ]);
    expect(withAccessExplained({ ...base, accessLevel: "partial", limitations: ["Only the first page was read."] }).limitations).toEqual(["Only the first page was read."]);
    expect(withAccessExplained({ ...base, accessLevel: "full", limitations: [] }).limitations).toEqual([]);
  });

  it("explains a stored partial reading that said nothing", async () => {
    const extractor = new FakeExtractor({ "https://example.com/some": { text: "Some of it.", accessLevel: "partial", limitations: [] } });
    const engine = createTestEngine({ extractor });
    const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/some" });
    await engine.deps.sources.ensureExtracted(source);
    expect((await engine.deps.repos.sources.getExtraction(source.contentHash))?.envelope?.limitations).toEqual([PART_READ]);
  });
});

describe("pasted text without a title", () => {
  it("is named from its first line, or its first sentence, or the first part of that sentence", async () => {
    expect(titleFromText("Plate tectonics\n\nThe outer shell of the Earth is split into plates.")).toBe("Plate tectonics");
    expect(titleFromText("# Cell respiration\n\nCells break down glucose.")).toBe("Cell respiration");
    expect(titleFromText("Ohm's law. The current is proportional to the voltage, and the line goes on for a long while after that.")).toBe("Ohm's law");
    expect(
      titleFromText("In the vapour-compression cycle, the refrigerant takes heat in when it evaporates at low pressure and gives heat out when it condenses at high pressure, which is why the back of a fridge feels warm."),
    ).toBe("In the vapour-compression cycle");
  });

  it("with no short line, sentence or part to use, is named by its opening words rather than a placeholder", () => {
    expect(titleFromText(`${"word ".repeat(40)}and no stop at all`, { opening: true })).toBe("word word word word word word word word…");
    expect(titleFromText(`${"word ".repeat(40)}and no stop at all`)).toBeUndefined();
    expect(titleFromText("Photosynthesis turns light water and carbon dioxide into sugar and oxygen inside the chloroplasts of plant cells and algae over many steps", { opening: true })).toBe(
      "Photosynthesis turns light water and carbon dioxide into…",
    );
    expect(titleFromText("12 34 56", { opening: true })).toBeUndefined();
  });

  it("keeps a title the person gave, and names text by its first line when added", async () => {
    const engine = createTestEngine();
    const added = await engine.deps.sources.add({ ownerId: "owner", text: "Plate tectonics\n\nPlates move over the mantle." });
    expect(added.source.title).toBe("Plate tectonics");
    const titled = await engine.deps.sources.add({ ownerId: "owner", text: "Another note\n\nWith text.", title: "Mine" });
    expect(titled.source.title).toBe("Mine");
    const run = await engine.deps.sources.add({ ownerId: "owner", text: `Notes from today ${"and then more words ".repeat(20)}with no stop` });
    expect(run.source.title).toBe("Notes from today and then more words and…");
  });
});

class Page implements BrowserPageLike {
  constructor(private readonly goto_: () => Promise<unknown>) {}
  async setUserAgent(): Promise<void> {}
  async setViewport(): Promise<void> {}
  goto(): Promise<unknown> {
    return this.goto_();
  }
  async content(): Promise<string> {
    return "<html><body><h1>Check your Internet connection</h1></body></html>";
  }
  async close(): Promise<void> {}
}
const browser = (goto: () => Promise<unknown>): BrowserBindingLike => ({
  launch: async () => ({ newPage: async () => new Page(goto), close: async () => undefined }),
});

describe("the browser tier", () => {
  it("reads nothing from a page that is not there or a host that does not answer", async () => {
    expect(await renderPageHTML(browser(async () => ({ status: () => 404 })), "https://example.com/nope", 1000)).toBeUndefined();
    expect(await renderPageHTML(browser(async () => ({ status: () => 500 })), "https://example.com/err", 1000)).toBeUndefined();
    expect(await renderPageHTML(browser(() => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED at https://x.invalid"))), "https://x.invalid", 1000)).toBeUndefined();
  });

  it("still reads a wall in front of a page, and a page that was slow to load", async () => {
    expect(await renderPageHTML(browser(async () => ({ status: () => 403 })), "https://example.com/walled", 1000)).toContain("<h1>");
    const slow = Object.assign(new Error("Navigation timeout of 1000 ms exceeded"), { name: "TimeoutError" });
    expect(await renderPageHTML(browser(() => Promise.reject(slow)), "https://example.com/slow", 1000)).toContain("<h1>");
    expect([401, 403, 429, 503].some(isMissingPage)).toBe(false);
    expect([400, 404, 410, 500, 502].every(isMissingPage)).toBe(true);
  });
});

describe("reader mode", () => {
  it("leaves out notes beside the text", async () => {
    const paragraph = "A linear map is a function between vector spaces that keeps addition and scaling. ".repeat(10);
    const html = `<html><head><title>Linear map</title></head><body><article><h1>Linear map</h1>
<div role="note" class="hatnote">"Linear transformation" redirects here.</div><p>${paragraph}</p><p>${paragraph}</p></article></body></html>`;
    const fetchImpl: FetchLike = async () => new Response(html, { headers: { "content-type": "text/html" } });
    const result = await extractWebModule({ url: "https://example.org/linear-map", sourceText: "", fetchImpl, timeoutMs: 1000, maxBytes: 1_000_000, maxTextChars: 400_000 });
    expect(result?.text).toContain("A linear map is a function");
    expect(result?.text).not.toContain("redirects here");
  });
});

describe("passages", () => {
  it("carry the source's title as the person sees it, else the one read from it", async () => {
    const { buildPassages } = await import("../src/sources/passages");
    const envelope = { originalText: "", kind: "text" as const, text: "Some notes.", references: [], metadata: {}, accessLevel: "full" as const, depthCap: "light" as const, limitations: [], fetchedAt: NOW() };
    expect(buildPassages([{ sourceId: "s1", title: "My notes", envelope: { ...envelope, title: "Read title" }, chunks: [] }])[0]!.sourceTitle).toBe("My notes");
    expect(buildPassages([{ sourceId: "s1", envelope: { ...envelope, title: "Read title" }, chunks: [] }])[0]!.sourceTitle).toBe("Read title");
  });
});
