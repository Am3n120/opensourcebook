import { describe, expect, it } from "vitest";
import { dedupeMediaURLs } from "../src/dedupe-media";
import type { ByteBlock } from "../src/types";

const hero = (url: string, title?: string): ByteBlock =>
  ({ type: "hero", url, ...(title ? { title } : {}) }) as ByteBlock;
const figure = (url: string): ByteBlock => ({ type: "figure", url }) as ByteBlock;
const text = (body: string): ByteBlock => ({ type: "text", text: body }) as ByteBlock;

describe("dedupeMediaURLs", () => {
  it("drops a hero that repeats an earlier hero's asset (observed Instagram byte)", () => {
    const blocks = [
      hero("/v1/assets/thumb1", "Lunar landers, assemble."),
      text("Supported explanation"),
      hero("/v1/assets/thumb1", "Repeated visual"),
    ];
    expect(dedupeMediaURLs(blocks)).toEqual([
      hero("/v1/assets/thumb1", "Lunar landers, assemble."),
      text("Supported explanation"),
    ]);
  });

  it("drops repeats across block types (figure repeating a hero)", () => {
    const blocks = [hero("/v1/assets/a"), figure("/v1/assets/a"), figure("/v1/assets/b")];
    expect(dedupeMediaURLs(blocks)).toEqual([hero("/v1/assets/a"), figure("/v1/assets/b")]);
  });

  it("strips a repeated linkPreview.imageURL but keeps the link card", () => {
    const preview = {
      type: "linkPreview",
      url: "https://example.com/story",
      title: "Story",
      domain: "example.com",
      imageURL: "/v1/assets/a",
    } as ByteBlock;
    const result = dedupeMediaURLs([hero("/v1/assets/a"), preview]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ type: "linkPreview", url: "https://example.com/story" });
    expect(result[1]).not.toHaveProperty("imageURL");
  });

  it("strips a repeated clip.posterURL but keeps the clip; clip.url never dedupes", () => {
    const clip = (startSeconds: number, posterURL?: string) =>
      ({ type: "clip", url: "https://www.youtube.com/watch?v=abc123", startSeconds, ...(posterURL ? { posterURL } : {}) }) as ByteBlock;
    const blocks = [figure("/v1/assets/frame1"), clip(12, "/v1/assets/frame1"), clip(48), clip(12)];
    const result = dedupeMediaURLs(blocks);
    expect(result).toHaveLength(4);
    expect(result[1]).not.toHaveProperty("posterURL");
    // Same video URL at the same timestamp is still kept — clip.url is exempt.
    expect(result[3]).toMatchObject({ type: "clip", startSeconds: 12 });
  });

  it("filters repeated gallery items and drops a gallery that falls below two items", () => {
    const gallery = (urls: string[]) => ({ type: "gallery", images: urls.map((url) => ({ url })) }) as ByteBlock;
    // First occurrence wins: the hero keeps the asset, the gallery loses it.
    expect(dedupeMediaURLs([hero("/v1/assets/a"), gallery(["/v1/assets/a", "/v1/assets/b"])])).toEqual([hero("/v1/assets/a")]);
    // Filtering that leaves a valid 2-item gallery keeps the block.
    const threeItem = dedupeMediaURLs([hero("/v1/assets/a"), gallery(["/v1/assets/a", "/v1/assets/b", "/v1/assets/c"])]);
    expect(threeItem).toHaveLength(2);
    expect(threeItem[1]).toMatchObject({ type: "gallery", images: [{ url: "/v1/assets/b" }, { url: "/v1/assets/c" }] });
    // A gallery seen before the hero keeps its items; the hero is the repeat.
    expect(dedupeMediaURLs([gallery(["/v1/assets/a", "/v1/assets/b"]), hero("/v1/assets/a")])).toEqual([
      gallery(["/v1/assets/a", "/v1/assets/b"]),
    ]);
  });

  it("filters carousel items the same way as gallery items", () => {
    const carousel = (urls: string[]) => ({ type: "carousel", items: urls.map((url) => ({ url })) }) as ByteBlock;
    const result = dedupeMediaURLs([hero("/v1/assets/a"), carousel(["/v1/assets/a", "/v1/assets/b"])]);
    expect(result).toEqual([hero("/v1/assets/a")]);
  });

  it("dedupes across reveal boundaries with the shared seen set", () => {
    const reveal = {
      type: "reveal",
      title: "More",
      blocks: [hero("/v1/assets/a")],
    } as ByteBlock;
    const result = dedupeMediaURLs([reveal, hero("/v1/assets/a")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "reveal" });
  });

  it("leaves distinct assets and non-media blocks untouched", () => {
    const blocks = [
      hero("/v1/assets/a"),
      figure("/v1/assets/b"),
      text("Body"),
      { type: "gallery", images: [{ url: "/v1/assets/c" }, { url: "/v1/assets/d" }] } as ByteBlock,
    ];
    expect(dedupeMediaURLs(blocks)).toEqual(blocks);
  });

  it("normalizes absolute URLs (hash, trailing slash) before comparing", () => {
    const blocks = [hero("https://cdn.example.com/img.png"), figure("https://cdn.example.com/img.png#frag"), figure("https://cdn.example.com/img.png/")];
    expect(dedupeMediaURLs(blocks)).toEqual([hero("https://cdn.example.com/img.png")]);
  });

  it("passes invalid entries through for the validator", () => {
    const brokenHero = { type: "hero" } as ByteBlock; // missing url: schema error, not a dedup decision
    const blocks = [brokenHero, hero("/v1/assets/a")];
    expect(dedupeMediaURLs(blocks)).toEqual(blocks);
  });
});

describe("destination-card dedupe", () => {
  const lp = (url: string, imageURL?: string): ByteBlock =>
    ({ type: "linkPreview", url, title: "t", domain: "d", ...(imageURL ? { imageURL } : {}) }) as ByteBlock;

  it("drops a repeated linkPreview to the same URL, first occurrence wins", () => {
    const blocks = [lp("https://x.com/a"), text("Body"), lp("https://x.com/a")];
    expect(dedupeMediaURLs(blocks)).toEqual([lp("https://x.com/a"), text("Body")]);
  });

  it("drops a linkCard when a linkPreview to the same URL exists", () => {
    const card = { type: "linkCard", url: "https://x.com/a", title: "t", domain: "d" } as ByteBlock;
    const blocks = [lp("https://x.com/a"), card];
    expect(dedupeMediaURLs(blocks)).toEqual([lp("https://x.com/a")]);
  });

  it("keeps distinct destinations and still strips a repeated imageURL", () => {
    const blocks = [
      hero("/v1/assets/h"),
      lp("https://x.com/a", "/v1/assets/h"),
      lp("https://x.com/b"),
    ];
    expect(dedupeMediaURLs(blocks)).toEqual([
      hero("/v1/assets/h"),
      lp("https://x.com/a"),
      lp("https://x.com/b"),
    ]);
  });

  it("keeps repeated clip urls (different timestamps are a feature)", () => {
    const clip = (start: number): ByteBlock =>
      ({ type: "clip", url: "https://youtube.com/watch?v=x", startSeconds: start }) as ByteBlock;
    const blocks = [clip(0), clip(30)];
    expect(dedupeMediaURLs(blocks)).toEqual(blocks);
  });
});
