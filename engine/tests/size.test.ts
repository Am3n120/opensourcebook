/**
 * How big a made output is, said by its own format (`FormatDefinition.size`;
 * docs/api.md, "Outputs").
 */
import { describe, expect, it } from "vitest";
import { createVideoDefinition } from "../src/engines/video/definition";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { FormatRegistry } from "../src/studio/registry";
import { countSize, playingSize } from "../src/studio/size";

const registry = createDefaultRegistry();
const sizeOf = (type: string, payload: unknown) => registry.size({ type, payload });

describe("an output's size", () => {
  it("is a count in each format's own unit, from what was made", () => {
    expect(sizeOf("flashcards", { cards: [{}, {}, {}] })).toEqual({ count: 3, unit: "cards" });
    expect(sizeOf("flashcards", { cards: [{}] })).toEqual({ count: 1, unit: "card" });
    expect(sizeOf("quiz", { questions: Array.from({ length: 10 }, () => ({})) })).toEqual({ count: 10, unit: "questions" });
    expect(sizeOf("audio", { file: { durationMs: 6 * 60_000 + 20_000 } })).toEqual({ count: 6, unit: "min" });
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(sizeOf("guide", { sections: [{ title: "One", points: [{ text: words(899) }] }] })).toEqual({ count: 2, unit: "pages" });
    expect(sizeOf("guide", { sections: [{ title: "One", points: [{ text: words(40) }] }] })).toEqual({ count: 0.5, unit: "page" });
  });

  it("is a video's length once its file is made", () => {
    const video = new FormatRegistry().register(createVideoDefinition({ makers: [] }));
    expect(video.size({ type: "video", payload: { scenes: [], render: { durationMs: 185_000 } } })).toEqual({ count: 3, unit: "min" });
    expect(video.size({ type: "video", payload: { scenes: [] } })).toBeUndefined();
  });

  it("is absent when the payload does not say, or the format cannot read it", () => {
    expect(sizeOf("flashcards", { cards: [] })).toBeUndefined();
    expect(sizeOf("audio", { parts: [] })).toBeUndefined();
    expect(sizeOf("guide", {})).toBeUndefined();
    expect(sizeOf("quiz", null)).toBeUndefined();
    expect(sizeOf("nothing-known", { cards: [{}] })).toBeUndefined();
  });

  it("says a short length in seconds and a longer one in whole minutes", () => {
    expect(playingSize(42_400)).toEqual({ count: 42, unit: "s" });
    expect(playingSize(89_000)).toEqual({ count: 1, unit: "min" });
    expect(playingSize(0)).toBeUndefined();
    expect(playingSize("3")).toBeUndefined();
    expect(countSize(0, "card", "cards")).toBeUndefined();
  });
});
