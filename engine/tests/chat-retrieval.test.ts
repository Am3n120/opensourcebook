/** Which passages a chat reply reads (src/chat/retrieval.ts). */
import { describe, expect, it } from "vitest";
import { pickPassages, words } from "../src/chat/retrieval";
import type { NodeSource } from "../src/studio/types";

function source(id: string, texts: string[]): NodeSource {
  let at = 0;
  return {
    sourceId: id,
    envelope: { kind: "text", text: texts.join("\n\n"), references: [], metadata: {}, accessLevel: "full", depthCap: "medium", limitations: [], fetchedAt: "" } as never,
    chunks: texts.map((text, ord) => {
      const chunk = { id: `${id}-${ord}`, ord, text, locator: { charStart: at, charEnd: at + text.length } };
      at += text.length + 2;
      return chunk;
    }),
  };
}

describe("pickPassages", () => {
  const sources = [
    source("a", ["Photosynthesis turns light into sugar in the chloroplast.", "Cells divide by mitosis into two identical cells."]),
    source("b", ["The chloroplast holds chlorophyll, which absorbs light.", "Rivers carry sediment to the sea."]),
  ];

  it("reads everything, in source order, when it fits", () => {
    const pick = pickPassages(sources, "anything", 10_000);
    expect(pick.passages.map((passage) => passage.chunkId)).toEqual(["a-0", "a-1", "b-0", "b-1"]);
    expect(pick.total).toBe(4);
  });

  it("reads the best matches within the budget, still in source order, labelled afresh", () => {
    const pick = pickPassages(sources, "How does the chloroplast use light?", 120);
    expect(pick.passages.map((passage) => passage.chunkId)).toEqual(["a-0", "b-0"]);
    expect(pick.passages.map((passage) => passage.label)).toEqual(["P1", "P2"]);
  });

  it("splits words in scripts without spaces too", () => {
    expect(words("Hello, World")).toEqual(["hello", "world"]);
    expect(words("光合作用は葉緑体で起こる").length).toBeGreaterThan(1);
  });
});
