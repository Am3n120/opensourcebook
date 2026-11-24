/**
 * A source's `limitations` are what a person reads under "What could not be
 * read": plain sentences about the source, no service names, no account of
 * how the reading worked. The technical lines sit in `extractionNotes`.
 * Extractions stored before that split read back the same way.
 */
import { describe, expect, it } from "vitest";
import { createSourceExtractor, withPlainLimitations } from "../src/extract";
import { ReadingGaps, gaps } from "../src/extract/limits";
import { extractWebModule } from "../src/extract/web";
import type { FetchLike, SourceEnvelope } from "../src/types";

const VIDEO = "https://www.youtube.com/watch?v=abc123";
const OEMBED = `https://www.youtube.com/oembed?url=${encodeURIComponent(VIDEO)}&format=json`;
/** Words a person should never meet in a limitation. */
const TECHNICAL = /gemini|oembed|yt-?dlp|sidecar|headless|reader-mode|asset store|provider|worker|markdown|metadata|extraction|parse|;/i;

function routes(table: Record<string, Response>): FetchLike {
  return async (input) => table[String(input)]?.clone() ?? new Response("missing", { status: 404 });
}

function expectPlain(limitations: string[]): void {
  for (const line of limitations) {
    expect(line, line).not.toMatch(TECHNICAL);
    expect(line, line).toMatch(/^[A-Z].*\.$/);
  }
}

describe("reading gaps", () => {
  it("keep a plain line for the person and every technical line for the logs", () => {
    const collected = new ReadingGaps()
      .note("Page HTML was rendered in a headless browser before parsing")
      .add("Some pictures in this file were left out.", "Oversized embedded images were skipped")
      .add("Some pictures in this file were left out.", "Embedded-image budget exceeded");
    expect(collected.limitations).toEqual(["Some pictures in this file were left out."]);
    expect(collected.extractionNotes).toEqual([
      "Page HTML was rendered in a headless browser before parsing",
      "Oversized embedded images were skipped",
      "Embedded-image budget exceeded",
    ]);
    expect(gaps(false, [undefined, "a note"])).toEqual({ limitations: [], extractionNotes: ["a note"] });
  });
});

describe("a page", () => {
  it("says how it was read only in the notes", async () => {
    const paragraph = "Bread rises because yeast makes gas that the dough holds in small bubbles. ".repeat(12);
    const html = `<html><head><title>Bread</title></head><body><article><h1>Bread</h1><p>${paragraph}</p></article></body></html>`;
    const fetchImpl: FetchLike = async () => new Response(html, { headers: { "content-type": "text/html" } });
    const result = await extractWebModule({ url: "https://example.org/bread", sourceText: "", fetchImpl, timeoutMs: 1000, maxBytes: 1_000_000, maxTextChars: 400_000 });
    expect(result?.accessLevel).toBe("full");
    expect(result?.limitations).toEqual([]);
    expect(result?.extractionNotes).toContain("Reader-mode extraction excludes scripts, styles, and authenticated content");
  });

  it("that cannot be opened says so in plain words", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceURL: "https://example.org/gone",
      sourceKind: "web",
      fetchImpl: async () => new Response("gone", { status: 404 }),
    });
    expect(source.limitations).toEqual(["This page could not be opened."]);
    expect(source.extractionNotes?.join(" ")).toMatch(/could not be fetched/);
  });
});

describe("a video with no way to read what is said in it", () => {
  it("says only its title and channel could be read when only its public card answers", async () => {
    const fetchImpl = routes({
      [OEMBED]: new Response(JSON.stringify({ title: "Video title", author_name: "Channel", type: "video" }), {
        headers: { "content-type": "application/json" },
      }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: VIDEO, sourceKind: "youtube", fetchImpl });
    expect(source.accessLevel).toBe("metadata");
    expect(source.limitations).toEqual(["Only this video's title and channel name could be read, not what is said in it."]);
    expect(source.extractionNotes?.join(" ")).toMatch(/No Gemini YouTube extraction provider configured/);
    expectPlain(source.limitations);
  });

  it("says only its title and description could be read when the video has no captions", async () => {
    const sidecarURL = "https://sidecar.internal";
    const fetchImpl = routes({
      [`${sidecarURL}/extract?url=${encodeURIComponent(VIDEO)}`]: new Response(
        JSON.stringify({ ok: true, title: "Sidecar Video", uploader: "Channel One", description: "What the video covers.", webpage_url: VIDEO }),
        { headers: { "content-type": "application/json" } },
      ),
    });
    const source = await createSourceExtractor({ sidecarURL }).extract({ sourceText: "", sourceURL: VIDEO, sourceKind: "youtube", fetchImpl });
    expect(source.accessLevel).toBe("metadata");
    expect(source.limitations).toEqual(["Only this video's title and description could be read, not what is said in it."]);
    expectPlain(source.limitations);
  });

  it("is a channel link, said as such", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceURL: "https://www.youtube.com/@somechannel",
      sourceKind: "youtube",
      fetchImpl: async () => new Response("missing", { status: 404 }),
    });
    expect(source.limitations).toEqual(["This link is a channel or playlist, not a single video, so only its title and description were read."]);
  });
});

describe("an upload that cannot be read", () => {
  it("names no file type or parser", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "unknown",
      uploadBytes: { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "application/x-thing", filename: "a.thing" },
    });
    expect(source.limitations).toEqual(["This kind of file could not be read."]);
    expect(source.extractionNotes?.join(" ")).toContain("application/x-thing");
  });
});

describe("an extraction stored before the split", () => {
  function stored(limitations: string[]): SourceEnvelope {
    return {
      originalText: "",
      originalURL: VIDEO,
      kind: "youtube",
      text: "Video title",
      references: [],
      metadata: {},
      accessLevel: "metadata",
      depthCap: "tiny",
      limitations,
      fetchedAt: "2026-10-01T00:00:00.000Z",
    };
  }

  it("reads back with plain lines and its old lines kept as notes", () => {
    const cut = "Only the first 23,891 of 81,370 characters of this source are used (about 29%); the rest is not read by anything made from it.";
    const old = [
      "No Gemini YouTube extraction provider configured; used public metadata fallback",
      "YouTube oEmbed provides metadata only; transcript and claims were not available",
      "Page HTML was rendered in a headless browser before parsing",
      "Oversized embedded images were skipped to stay within Worker memory limits",
      "Embedded-image budget exceeded; remaining figures were skipped",
      "Worksheet rows were truncated at 500 rows per sheet",
      cut,
      "A line no reader ever wrote",
    ];
    const read = withPlainLimitations(stored(old));
    expect(read.limitations).toEqual([
      "Only this video's title and channel name could be read, not what is said in it.",
      "Some pictures in this file were left out.",
      "Only the first 500 rows of each sheet were read.",
      cut,
      "A line no reader ever wrote",
    ]);
    expect(read.extractionNotes).toEqual(old.slice(0, 6));
  });

  it("leaves an extraction stored since the split as it is", () => {
    const current = { ...stored(["This page could not be opened."]), extractionNotes: ["Web page could not be fetched"] };
    expect(withPlainLimitations(current)).toBe(current);
  });
});
