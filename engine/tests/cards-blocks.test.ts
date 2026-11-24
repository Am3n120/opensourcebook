import { describe, expect, it } from "vitest";
import { validatePage } from "../src/cards/schema";
import type { PagePayload } from "../src/types";

const baseByte: PagePayload = {
  id: "8f4c0b7e-2a3d-4e5f-9a1b-7c6d5e4f3a2b",
  type: "note",
  title: "A valid note",
  subtitle: "Caller source",
  timeAgo: "just now",
  tags: ["test"],
  status: { type: "ready" },
  blocks: [
    { type: "heading", text: "Heading" },
    { type: "text", text: "Evidence-backed text" },
  ],
  byteDepth: "light",
};

describe("validatePage", () => {
  it("accepts the Swift-shaped DTO and nested reveals", () => {
    const result = validatePage({
      ...baseByte,
      blocks: [
        { type: "reveal", title: "More", blocks: [{ type: "text", text: "Nested" }] },
        { type: "orderExercise", prompt: "Order", items: ["B", "A", "C"], correctOrder: [1, 0, 2] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects unknown keys, malformed UUIDs, quiz bounds, and timers", () => {
    const result = validatePage({
      ...baseByte,
      id: "not-a-uuid",
      unexpected: true,
      blocks: [
        { type: "quiz", question: "Q", options: ["A", "B"], correctIndex: 2 },
        { type: "timer", label: "Wait", seconds: 0 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.repairPromptSummary).toMatch(/corrected JSON/i);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["uuid", "unknown_key", "bounds", "positive"]));
  });

  it("names the valid block types when a model invents a type", () => {
    const result = validatePage({
      ...baseByte,
      blocks: [{ type: "slide", text: "Invented by a deck-shaped source" }],
    });
    expect(result.valid).toBe(false);
    const enumError = result.errors.find((error) => error.path === "$.blocks[0].type" && error.code === "enum");
    expect(enumError).toBeDefined();
    expect(enumError?.message).toContain("'slide'");
    expect(enumError?.actual).toBe("slide");
    // The repair prompt relays `expected` verbatim; it must carry the real type list.
    expect(enumError?.expected).toContain("heading");
    expect(enumError?.expected).toContain("audioClip");
  });

  it("rejects non-finite and inconsistent chart data", () => {
    const result = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "lineChart",
          xLabels: ["a", "b"],
          series: [{ name: "Series", values: [1, Number.NaN, 3], color: "primary" }],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["finite_number", "consistent_length"]));
  });

  it("rejects repeated order indices but accepts a scrambled correct order", () => {
    const invalid = validatePage({
      ...baseByte,
      blocks: [{ type: "orderExercise", prompt: "Order", items: ["A", "B"], correctOrder: [0, 0] }],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.code === "permutation")).toBe(true);

    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "orderExercise", prompt: "Order", items: ["B", "A"], correctOrder: [1, 0] }],
    });
    expect(valid.valid).toBe(true);
  });

  it("accepts figure, gallery, and clip blocks with pictures Open Sourcebook keeps or embeds", () => {
    const result = validatePage({
      ...baseByte,
      blocks: [
        { type: "figure", url: "/v1/assets/9f2cAb.-_~", caption: "Architecture", credit: "Figure 3, page 12" },
        { type: "figure", url: "data:image/png;base64,iVBORw0KGgo=", systemIcon: "photo" },
        {
          type: "gallery",
          images: [
            { url: "/v1/assets/abc123", caption: "First" },
            { url: "/v1/assets/def456" },
          ],
          columns: 3,
        },
        {
          type: "clip",
          url: "https://www.youtube.com/watch?v=abc",
          startSeconds: 83,
          endSeconds: 140,
          title: "Key moment",
          posterURL: "/v1/assets/poster1",
          platform: "youtube",
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects non-asset relative URLs and unknown keys on the asset blocks", () => {
    const result = validatePage({
      ...baseByte,
      blocks: [
        { type: "figure", url: "/images/fig.png" },
        { type: "figure", url: "ftp://example.com/fig.png" },
        { type: "clip", url: "https://example.com/v", startSeconds: 0, src: "extra" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["kept_picture", "kept_picture", "unknown_key"]));
  });

  it("enforces gallery size, columns, and per-image URLs", () => {
    const tooFew = validatePage({
      ...baseByte,
      blocks: [{ type: "gallery", images: [{ url: "/v1/assets/a" }] }],
    });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range")).toBe(true);

    const tooMany = validatePage({
      ...baseByte,
      blocks: [{ type: "gallery", images: Array.from({ length: 13 }, (_, index) => ({ url: `/v1/assets/a${index}` })) }],
    });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.some((error) => error.code === "range")).toBe(true);

    const badColumns = validatePage({
      ...baseByte,
      blocks: [{ type: "gallery", images: [{ url: "/v1/assets/a" }, { url: "/v1/assets/b" }], columns: 4 }],
    });
    expect(badColumns.valid).toBe(false);
    expect(badColumns.errors.some((error) => error.path.endsWith(".columns") && error.code === "enum")).toBe(true);

    const missingURL = validatePage({
      ...baseByte,
      blocks: [{ type: "gallery", images: [{ url: "/v1/assets/a" }, { caption: "no url" }] }],
    });
    expect(missingURL.valid).toBe(false);
    expect(missingURL.errors.some((error) => error.path.includes("images[1].url") && error.code === "kept_picture")).toBe(true);
  });

  it("enforces clip timing and platform constraints", () => {
    const negative = validatePage({
      ...baseByte,
      blocks: [{ type: "clip", url: "https://example.com/v", startSeconds: -1 }],
    });
    expect(negative.valid).toBe(false);
    expect(negative.errors.some((error) => error.code === "non_negative")).toBe(true);

    const nonInteger = validatePage({
      ...baseByte,
      blocks: [{ type: "clip", url: "https://example.com/v", startSeconds: 1.5 }],
    });
    expect(nonInteger.valid).toBe(false);
    expect(nonInteger.errors.some((error) => error.code === "non_negative")).toBe(true);

    const inverted = validatePage({
      ...baseByte,
      blocks: [{ type: "clip", url: "https://example.com/v", startSeconds: 140, endSeconds: 83 }],
    });
    expect(inverted.valid).toBe(false);
    expect(inverted.errors.some((error) => error.path.endsWith(".endSeconds") && error.code === "range")).toBe(true);

    const badPlatform = validatePage({
      ...baseByte,
      blocks: [{ type: "clip", url: "https://example.com/v", startSeconds: 0, platform: "vimeo2" }],
    });
    expect(badPlatform.valid).toBe(false);
    expect(badPlatform.errors.some((error) => error.path.endsWith(".platform") && error.code === "enum")).toBe(true);
  });
});

describe("validatePage expanded blocks", () => {
  it("validates heatmap shape and row lengths", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "heatmap",
          title: "Activity",
          xLabels: ["Mon", "Tue"],
          yLabels: ["Morning", "Evening"],
          values: [
            [1, 2],
            [3, 4],
          ],
          minLabel: "Low",
          maxLabel: "High",
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const rowCountMismatch = validatePage({
      ...baseByte,
      blocks: [{ type: "heatmap", xLabels: ["Mon", "Tue"], yLabels: ["Morning", "Evening"], values: [[1, 2]] }],
    });
    expect(rowCountMismatch.valid).toBe(false);
    expect(rowCountMismatch.errors.some((error) => error.code === "consistent_length" && error.path.endsWith(".values"))).toBe(true);

    const rowLengthMismatch = validatePage({
      ...baseByte,
      blocks: [{ type: "heatmap", xLabels: ["Mon", "Tue"], yLabels: ["Morning"], values: [[1, 2, 3]] }],
    });
    expect(rowLengthMismatch.valid).toBe(false);
    expect(rowLengthMismatch.errors.some((error) => error.code === "consistent_length" && error.path.includes("values[0]"))).toBe(true);

    const tooManyLabels = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "heatmap",
          xLabels: Array.from({ length: 13 }, (_, index) => `x${index}`),
          yLabels: ["Morning"],
          values: [Array.from({ length: 13 }, () => 1)],
        },
      ],
    });
    expect(tooManyLabels.valid).toBe(false);
    expect(tooManyLabels.errors.some((error) => error.code === "range" && error.path.endsWith(".xLabels"))).toBe(true);
  });

  it("validates scatter points and bounds", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "scatter",
          title: "Samples",
          xLabel: "Height",
          yLabel: "Weight",
          points: [
            { x: 1, y: 2, label: "A" },
            { x: 3, y: 4 },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const empty = validatePage({ ...baseByte, blocks: [{ type: "scatter", points: [] }] });
    expect(empty.valid).toBe(false);
    expect(empty.errors.some((error) => error.code === "range" && error.path.endsWith(".points"))).toBe(true);

    const badPoint = validatePage({ ...baseByte, blocks: [{ type: "scatter", points: [{ x: Number.NaN, y: 2 }] }] });
    expect(badPoint.valid).toBe(false);
    expect(badPoint.errors.some((error) => error.code === "finite_number")).toBe(true);
  });

  it("validates pie item count and positive values", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "pie",
          title: "Share",
          items: [
            { label: "A", value: 60, displayValue: "60%" },
            { label: "B", value: 40 },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({ ...baseByte, blocks: [{ type: "pie", items: [{ label: "A", value: 1 }] }] });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".items"))).toBe(true);

    const notPositive = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "pie",
          items: [
            { label: "A", value: 1 },
            { label: "B", value: 0 },
          ],
        },
      ],
    });
    expect(notPositive.valid).toBe(false);
    expect(notPositive.errors.some((error) => error.code === "range" && error.path.endsWith(".value"))).toBe(true);
  });

  it("applies lineChart rules to areaChart", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "areaChart",
          title: "Growth",
          xLabels: ["Q1", "Q2"],
          series: [{ name: "Revenue", values: [1, 2], color: "accent" }],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const mismatch = validatePage({
      ...baseByte,
      blocks: [{ type: "areaChart", xLabels: ["Q1", "Q2"], series: [{ name: "Revenue", values: [1], color: "accent" }] }],
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.some((error) => error.code === "consistent_length")).toBe(true);
  });

  it("validates stackedBar series length and count", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "stackedBar", categories: ["Q1", "Q2"], series: [{ name: "A", values: [1, 2], color: "primary" }] }],
    });
    expect(valid.valid).toBe(true);

    const mismatch = validatePage({
      ...baseByte,
      blocks: [{ type: "stackedBar", categories: ["Q1", "Q2"], series: [{ name: "A", values: [1], color: "primary" }] }],
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.some((error) => error.code === "consistent_length")).toBe(true);

    const tooMany = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "stackedBar",
          categories: ["Q1"],
          series: Array.from({ length: 5 }, (_, index) => ({ name: `S${index}`, values: [1], color: "info" })),
        },
      ],
    });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.some((error) => error.code === "range" && error.path.endsWith(".series"))).toBe(true);
  });

  it("enforces the gauge 0-100 range", () => {
    const valid = validatePage({ ...baseByte, blocks: [{ type: "gauge", value: 72, label: "Score", detail: "Up" }] });
    expect(valid.valid).toBe(true);

    const over = validatePage({ ...baseByte, blocks: [{ type: "gauge", value: 101, label: "Score" }] });
    expect(over.valid).toBe(false);
    expect(over.errors.some((error) => error.code === "range" && error.path.endsWith(".value"))).toBe(true);

    const under = validatePage({ ...baseByte, blocks: [{ type: "gauge", value: -1, label: "Score" }] });
    expect(under.valid).toBe(false);
    expect(under.errors.some((error) => error.code === "range" && error.path.endsWith(".value"))).toBe(true);
  });

  it("validates histogram bins", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "histogram",
          bins: [
            { label: "0-9", count: 4 },
            { label: "10-19", count: 0 },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({ ...baseByte, blocks: [{ type: "histogram", bins: [{ label: "0-9", count: 4 }] }] });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".bins"))).toBe(true);

    const negative = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "histogram",
          bins: [
            { label: "0-9", count: 4 },
            { label: "10-19", count: -1 },
          ],
        },
      ],
    });
    expect(negative.valid).toBe(false);
    expect(negative.errors.some((error) => error.code === "range" && error.path.endsWith(".count"))).toBe(true);
  });

  it("validates radar axes and series", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "radar", axes: ["Speed", "Power", "Range"], series: [{ name: "A", values: [1, 2, 3], color: "success" }] }],
    });
    expect(valid.valid).toBe(true);

    const tooFewAxes = validatePage({
      ...baseByte,
      blocks: [{ type: "radar", axes: ["A", "B"], series: [{ name: "S", values: [1, 2], color: "info" }] }],
    });
    expect(tooFewAxes.valid).toBe(false);
    expect(tooFewAxes.errors.some((error) => error.code === "range" && error.path.endsWith(".axes"))).toBe(true);

    const mismatch = validatePage({
      ...baseByte,
      blocks: [{ type: "radar", axes: ["A", "B", "C"], series: [{ name: "S", values: [1, 2], color: "info" }] }],
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.some((error) => error.code === "consistent_length")).toBe(true);

    const negative = validatePage({
      ...baseByte,
      blocks: [{ type: "radar", axes: ["A", "B", "C"], series: [{ name: "S", values: [1, -2, 3], color: "info" }] }],
    });
    expect(negative.valid).toBe(false);
    expect(negative.errors.some((error) => error.code === "range" && error.path.includes("values[1]"))).toBe(true);

    const tooManySeries = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "radar",
          axes: ["A", "B", "C"],
          series: Array.from({ length: 4 }, (_, index) => ({ name: `S${index}`, values: [1, 2, 3], color: "primary" })),
        },
      ],
    });
    expect(tooManySeries.valid).toBe(false);
    expect(tooManySeries.errors.some((error) => error.code === "range" && error.path.endsWith(".series"))).toBe(true);
  });

  it("validates flashcards count", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "flashcards",
          cards: [
            { front: "Q1", back: "A1" },
            { front: "Q2", back: "A2" },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({ ...baseByte, blocks: [{ type: "flashcards", cards: [{ front: "Q1", back: "A1" }] }] });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".cards"))).toBe(true);
  });

  it("requires the fillInBlank blank marker and bounded options", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "fillInBlank", prompt: "The ___ absorbs CO2.", answer: "ocean", options: ["ocean", "desert"], explanation: "It does." }],
    });
    expect(valid.valid).toBe(true);

    const noBlank = validatePage({ ...baseByte, blocks: [{ type: "fillInBlank", prompt: "The ocean absorbs CO2.", answer: "ocean" }] });
    expect(noBlank.valid).toBe(false);
    expect(noBlank.errors.some((error) => error.code === "format" && error.path.endsWith(".prompt"))).toBe(true);

    const oneOption = validatePage({
      ...baseByte,
      blocks: [{ type: "fillInBlank", prompt: "The ___ absorbs CO2.", answer: "ocean", options: ["ocean"] }],
    });
    expect(oneOption.valid).toBe(false);
    expect(oneOption.errors.some((error) => error.code === "range" && error.path.endsWith(".options"))).toBe(true);
  });

  it("validates matching pairs count", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "matching",
          prompt: "Match",
          pairs: [
            { left: "A", right: "1" },
            { left: "B", right: "2" },
            { left: "C", right: "3" },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "matching",
          pairs: [
            { left: "A", right: "1" },
            { left: "B", right: "2" },
          ],
        },
      ],
    });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".pairs"))).toBe(true);
  });

  it("validates prosCons sides", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "prosCons", pros: { title: "Pros", items: ["Fast"] }, cons: { items: ["Costly"] } }],
    });
    expect(valid.valid).toBe(true);

    const empty = validatePage({ ...baseByte, blocks: [{ type: "prosCons", pros: { items: [] }, cons: { items: ["Costly"] } }] });
    expect(empty.valid).toBe(false);
    expect(empty.errors.some((error) => error.code === "range" && error.path.includes(".pros.items"))).toBe(true);
  });

  it("validates definition fields", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "definition", term: "Byte", definition: "A structured document.", source: "Docs" }],
    });
    expect(valid.valid).toBe(true);

    const missing = validatePage({ ...baseByte, blocks: [{ type: "definition", term: "Byte" }] });
    expect(missing.valid).toBe(false);
    expect(missing.errors.some((error) => error.code === "string" && error.path.endsWith(".definition"))).toBe(true);
  });

  it("validates embed platform enum and absolute url", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        { type: "embed", platform: "tiktok", url: "https://www.tiktok.com/@user/video/123", title: "Clip" },
        { type: "embed", platform: "spotify", url: "https://open.spotify.com/track/abc" },
        { type: "embed", platform: "web", url: "https://embed.example/item/42", title: "Widget" },
      ],
    });
    expect(valid.valid).toBe(true);

    const badPlatform = validatePage({ ...baseByte, blocks: [{ type: "embed", platform: "vimeo", url: "https://vimeo.com/123" }] });
    expect(badPlatform.valid).toBe(false);
    expect(badPlatform.errors.some((error) => error.code === "enum" && error.path.endsWith(".platform"))).toBe(true);

    const relative = validatePage({ ...baseByte, blocks: [{ type: "embed", platform: "x", url: "/v1/assets/abc" }] });
    expect(relative.valid).toBe(false);
    expect(relative.errors.some((error) => error.code === "url" && error.path.endsWith(".url"))).toBe(true);
  });

  it("validates linkPreview and its asset-aware imageURL", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "linkPreview",
          url: "https://example.com/story",
          title: "Story",
          domain: "example.com",
          description: "A story.",
          imageURL: "/v1/assets/img1",
        },
        { type: "linkPreview", url: "https://example.com/other", title: "Other", domain: "example.com" },
      ],
    });
    expect(valid.valid).toBe(true);

    const badImage = validatePage({
      ...baseByte,
      blocks: [{ type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com", imageURL: "/images/og.png" }],
    });
    expect(badImage.valid).toBe(false);
    expect(badImage.errors.some((error) => error.code === "kept_picture" && error.path.endsWith(".imageURL"))).toBe(true);

    const relativeURL = validatePage({
      ...baseByte,
      blocks: [{ type: "linkPreview", url: "/v1/assets/abc", title: "Story", domain: "example.com" }],
    });
    expect(relativeURL.valid).toBe(false);
    expect(relativeURL.errors.some((error) => error.code === "url" && error.path.endsWith(".url"))).toBe(true);
  });

  it("validates carousel bounds and asset-path urls", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        {
          type: "carousel",
          items: [
            { url: "/v1/assets/a", caption: "One" },
            { url: "/v1/assets/b" },
          ],
        },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({ ...baseByte, blocks: [{ type: "carousel", items: [{ url: "/v1/assets/a" }] }] });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".items"))).toBe(true);

    const tooMany = validatePage({
      ...baseByte,
      blocks: [{ type: "carousel", items: Array.from({ length: 11 }, (_, index) => ({ url: `/v1/assets/a${index}` })) }],
    });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.some((error) => error.code === "range" && error.path.endsWith(".items"))).toBe(true);

    const badURL = validatePage({
      ...baseByte,
      blocks: [{ type: "carousel", items: [{ url: "/v1/assets/a" }, { url: "/images/b.png" }] }],
    });
    expect(badURL.valid).toBe(false);
    expect(badURL.errors.some((error) => error.code === "kept_picture" && error.path.includes("items[1].url"))).toBe(true);
  });

  it("validates map place coordinates", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [{ type: "map", title: "Trip", places: [{ name: "Paris", latitude: 48.8566, longitude: 2.3522, note: "Start" }] }],
    });
    expect(valid.valid).toBe(true);

    const badLat = validatePage({ ...baseByte, blocks: [{ type: "map", places: [{ name: "Nowhere", latitude: 91, longitude: 0 }] }] });
    expect(badLat.valid).toBe(false);
    expect(badLat.errors.some((error) => error.code === "range" && error.path.endsWith(".latitude"))).toBe(true);

    const badLon = validatePage({ ...baseByte, blocks: [{ type: "map", places: [{ name: "Nowhere", latitude: 0, longitude: -181 }] }] });
    expect(badLon.valid).toBe(false);
    expect(badLon.errors.some((error) => error.code === "range" && error.path.endsWith(".longitude"))).toBe(true);

    const empty = validatePage({ ...baseByte, blocks: [{ type: "map", places: [] }] });
    expect(empty.valid).toBe(false);
    expect(empty.errors.some((error) => error.code === "range" && error.path.endsWith(".places"))).toBe(true);
  });

  it("validates hero asset-path urls", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        { type: "hero", url: "/v1/assets/hero1", title: "Title", subtitle: "Sub" },
      ],
    });
    expect(valid.valid).toBe(true);

    const relative = validatePage({ ...baseByte, blocks: [{ type: "hero", url: "/images/hero.png" }] });
    expect(relative.valid).toBe(false);
    expect(relative.errors.some((error) => error.code === "kept_picture" && error.path.endsWith(".url"))).toBe(true);

    const unknownKey = validatePage({ ...baseByte, blocks: [{ type: "hero", url: "/v1/assets/a", credit: "x" }] });
    expect(unknownKey.valid).toBe(false);
    expect(unknownKey.errors.some((error) => error.code === "unknown_key")).toBe(true);
  });

  it("validates toc bounds", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        { type: "heading", text: "Intro" },
        { type: "heading", text: "Body" },
        { type: "toc", title: "Contents", items: ["Intro", "Body"] },
      ],
    });
    expect(valid.valid).toBe(true);

    const tooFew = validatePage({ ...baseByte, blocks: [{ type: "toc", items: ["Intro"] }] });
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((error) => error.code === "range" && error.path.endsWith(".items"))).toBe(true);

    const tooMany = validatePage({ ...baseByte, blocks: [{ type: "toc", items: Array.from({ length: 21 }, (_, index) => `H${index}`) }] });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.some((error) => error.code === "range" && error.path.endsWith(".items"))).toBe(true);
  });

  it("validates math latex", () => {
    const valid = validatePage({ ...baseByte, blocks: [{ type: "math", latex: "E = mc^2", caption: "Einstein" }] });
    expect(valid.valid).toBe(true);

    const empty = validatePage({ ...baseByte, blocks: [{ type: "math", latex: "  " }] });
    expect(empty.valid).toBe(false);
    expect(empty.errors.some((error) => error.code === "string" && error.path.endsWith(".latex"))).toBe(true);
  });

  it("validates audioClip url and timing", () => {
    const valid = validatePage({
      ...baseByte,
      blocks: [
        { type: "audioClip", url: "https://example.com/ep.mp3" },
        { type: "audioClip", url: "https://example.com/ep.mp3", startSeconds: 12, endSeconds: 34, title: "Part" },
      ],
    });
    expect(valid.valid).toBe(true);

    const inverted = validatePage({
      ...baseByte,
      blocks: [{ type: "audioClip", url: "https://example.com/ep.mp3", startSeconds: 34, endSeconds: 12 }],
    });
    expect(inverted.valid).toBe(false);
    expect(inverted.errors.some((error) => error.code === "range" && error.path.endsWith(".endSeconds"))).toBe(true);

    const negative = validatePage({ ...baseByte, blocks: [{ type: "audioClip", url: "https://example.com/ep.mp3", startSeconds: -1 }] });
    expect(negative.valid).toBe(false);
    expect(negative.errors.some((error) => error.code === "non_negative" && error.path.endsWith(".startSeconds"))).toBe(true);

    const relative = validatePage({ ...baseByte, blocks: [{ type: "audioClip", url: "/v1/assets/abc" }] });
    expect(relative.valid).toBe(false);
    expect(relative.errors.some((error) => error.code === "url" && error.path.endsWith(".url"))).toBe(true);
  });
});
