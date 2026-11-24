/**
 * A source's detail (docs/api.md, "Source (in lists)"): how long it is, from
 * what reading it found, served wherever a source is listed.
 */
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { sourceDetail } from "../src/sources/detail";
import type { SourceEnvelope } from "../src/types";
import { FakeExtractor, authed, bodyOf, createTestEngine } from "./support/engine-harness";

describe("sourceDetail", () => {
  it("is the count a reading kept, in its unit", () => {
    expect(sourceDetail({ extraction: "unpdf-text", pageCount: "24" })).toEqual({ count: 24, unit: "pages" });
    expect(sourceDetail({ pageCount: "1" })).toEqual({ count: 1, unit: "page" });
    expect(sourceDetail({ extraction: "office-pptx", slideCount: "38" })).toEqual({ count: 38, unit: "slides" });
    expect(sourceDetail({ sheetCount: "3" })).toEqual({ count: 3, unit: "sheets" });
  });

  it("is a video's running time in minutes, or seconds when it is short", () => {
    expect(sourceDetail({ durationText: "52:13" })).toEqual({ count: 52, unit: "min" });
    expect(sourceDetail({ durationText: "1:02:40" })).toEqual({ count: 63, unit: "min" });
    expect(sourceDetail({ durationText: "0:45" })).toEqual({ count: 45, unit: "s" });
  });

  it("is absent when the reading counted nothing", () => {
    expect(sourceDetail({ extraction: "audio-transcription", byteLength: "1000" })).toBeUndefined();
    expect(sourceDetail({ pageCount: "0", durationText: "soon" })).toBeUndefined();
    expect(sourceDetail({})).toBeUndefined();
    expect(sourceDetail(undefined)).toBeUndefined();
  });
});

describe("a listed source's detail", () => {
  it("is served in a project's sources, the Inbox and a rename's answer, and absent when unknown", async () => {
    const byURL: Record<string, Partial<SourceEnvelope>> = {
      "https://example.test/chapter.pdf": { metadata: { pageCount: "24" } },
      "https://example.test/lecture": { metadata: { durationText: "52:13" } },
    };
    const engine = createTestEngine({ extractor: new FakeExtractor(byURL) });
    const call = async (path: string, method = "GET", body?: unknown) => bodyOf(await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps));
    const project = (await call("/v1/projects", "POST", { title: "Cells" })).project;
    const pdf = (await call("/v1/sources", "POST", { projectId: project.id, url: "https://example.test/chapter.pdf" })).source;
    const lecture = (await call("/v1/sources", "POST", { projectId: project.id, url: "https://example.test/lecture" })).source;
    const notes = (await call("/v1/sources", "POST", { projectId: project.id, text: "Mitosis lab notes." })).source;
    await call("/v1/sources", "POST", { url: "https://example.test/chapter.pdf" });

    const listed = new Map((await call(`/v1/projects/${project.id}/sources`)).sources.map((source: any) => [source.id, source]));
    expect(listed.get(pdf.id)).toMatchObject({ detail: { count: 24, unit: "pages" } });
    expect(listed.get(lecture.id)).toMatchObject({ detail: { count: 52, unit: "min" } });
    expect(listed.get(notes.id)).not.toHaveProperty("detail");
    expect((await call("/v1/inbox")).sources[0].detail).toEqual({ count: 24, unit: "pages" });
    expect((await call(`/v1/sources/${pdf.id}`, "PATCH", { title: "Chapter 12" })).source).toMatchObject({ title: "Chapter 12", detail: { count: 24, unit: "pages" } });
  });
});
