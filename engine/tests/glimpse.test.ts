import { describe, expect, it } from "vitest";
import { flashcardsGlimpse } from "../src/engines/flashcards/definition";
import { quizGlimpse } from "../src/engines/quiz/definition";
import { videoGlimpse } from "../src/engines/video/definition";
import { plainLine } from "../src/studio/glimpse";

describe("glimpses", () => {
  it("a set of flashcards shows the first words its first card's front says, marks dropped and gaps hidden", () => {
    const set = { cards: [{ id: "c1", kind: "recall", front: [{ type: "kicker", text: "START" }, { type: "heading", text: "Why **pivots** decide `Ax = b`" }], back: [{ type: "text", text: "..." }], cites: [] }] };
    expect(flashcardsGlimpse(set as never)).toEqual({ text: "Why pivots decide Ax = b" });
    const cloze = { cards: [{ id: "c1", kind: "cloze", front: [{ type: "cloze", text: "Water boils at [[100 °C]] at sea level" }], cites: [] }] };
    expect(flashcardsGlimpse(cloze as never)).toEqual({ text: "Water boils at … at sea level" });
    expect(flashcardsGlimpse({ cards: [] } as never)).toBeUndefined();
    expect(flashcardsGlimpse({} as never)).toBeUndefined();
  });

  it("a quiz shows its first question", () => {
    expect(quizGlimpse({ questions: [{ prompt: "What does glycolysis make?" }] } as never)).toEqual({ text: "What does glycolysis make?" });
    expect(quizGlimpse({ questions: [] } as never)).toBeUndefined();
  });

  it("a video shows its idea and offers its file for a frame", () => {
    expect(videoGlimpse({ idea: "The gradient drives ATP synthase.", render: { url: "/v1/assets/v.mp4" } } as never)).toEqual({
      text: "The gradient drives ATP synthase.",
      media: { kind: "video", url: "/v1/assets/v.mp4" },
    });
    expect(videoGlimpse({ idea: "Not made yet." } as never)).toEqual({ text: "Not made yet." });
  });

  it("a long line is cut at a word", () => {
    const line = plainLine("word ".repeat(60), 40)!;
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("word…")).toBe(true);
    expect(plainLine("  ")).toBeUndefined();
  });
});
