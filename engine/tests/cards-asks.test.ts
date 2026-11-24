/**
 * Cards that label a picture or draw a line (cards/asks.ts): they are the
 * quiz's label and graph kinds on a card, so they are checked by those kinds
 * and graded on the same shared cases the quiz kinds and the web player are.
 */
import { describe, expect, it } from "vitest";
import type { ByteBlock } from "../src/cards/blocks";
import { askedAnswer, askedQuestion, gradeAsked } from "../src/cards/asks";
import { markOf, type CardSet } from "../src/cards/contract";
import { cardKinds } from "../src/cards/kinds";
import { withoutRemotePictures } from "../src/cards/pictures";
import { validateCardSet } from "../src/cards/validate";
import cases from "../src/engines/quiz/kind-cases.json";

const label = {
  type: "labelPicture",
  prompt: "Name the chambers of the heart.",
  url: "/v1/assets/heart",
  caption: "Figure 2: a section through the heart",
  marks: [
    { mark: "A", answer: "right atrium" },
    { mark: "B", answer: "left ventricle" },
  ],
  extra: ["aorta"],
  explanation: "The key under Figure 2 names each mark.",
} as unknown as ByteBlock;

const line = {
  type: "drawLine",
  prompt: "The tank fills at 5 litres a minute from 5 litres. Draw its volume over time.",
  axes: { x: { min: 0, max: 10, step: 1, label: "minutes" }, y: { min: 0, max: 60, step: 5, label: "litres" } },
  line: [[0, 5], [8, 45]],
} as unknown as ByteBlock;

function setOf(...fronts: ByteBlock[][]): CardSet {
  return {
    schemaVersion: 3,
    id: "0f6f2a3e-5a43-4a51-9d1c-3c2b9e1f7a10",
    title: "Asks",
    subtitle: "Notes",
    sourceKind: "note",
    tags: [],
    cards: fronts.map((front, i) => ({ id: `c${i + 1}`, kind: "ask", front, cites: [{ sourceId: "s1", spot: "passage" }] })),
  };
}

const errors = (block: Record<string, unknown>) => validateCardSet(setOf([block as unknown as ByteBlock])).errors.map((error) => `${error.path} ${error.code}`);

describe("a card that labels a picture or draws a line", () => {
  it("is a question card, marked by its answer", () => {
    const set = setOf([label], [line]);
    expect(validateCardSet(set).errors).toEqual([]);
    for (const card of set.cards) {
      expect(markOf(card)).toBe("answer");
      expect(cardKinds.get("ask")!.check(card)).toEqual([]);
    }
  });

  it("does not sit on a card that turns over", () => {
    expect(cardKinds.get("recall")!.check({ front: [{ type: "text", text: "?" }, label], back: [{ type: "text", text: "!" }] })).toContain(
      "A card that turns over does not also ask a question with options; make that its own card of kind ask.",
    );
  });

  it("is held to the label kind's own rules", () => {
    const at = "$.cards[0].front[0]";
    expect(errors({ ...label, marks: [{ mark: "A", answer: "right atrium" }] })).toContain(`${at}.marks count`);
    expect(errors({ ...label, url: "https://example.com/heart.png" })).toContain(`${at}.url picture`);
    expect(errors({ ...label, marks: [{ mark: "A", answer: "aorta" }, { mark: "B", answer: "left ventricle" }] }).some((e) => e.startsWith(`${at}.`))).toBe(true);
    expect(errors({ ...label, marks: [{ mark: "the top left chamber", answer: "x" }, { mark: "B", answer: "y" }] })).toContain(`${at}.marks[0].mark too_long`);
    expect(errors({ ...label, marks: "A, B" })).toContain(`${at}.marks type`);
  });

  it("is held to the graph kind's own rules, with numbers that are numbers", () => {
    const at = "$.cards[0].front[0]";
    expect(errors({ ...line, line: [[0, 5], [0, 5]] })).toContain(`${at}.line line`);
    expect(errors({ ...line, line: [[0, 5], [8, 44]] })).toContain(`${at}.line[1] off_grid`);
    expect(errors({ ...line, axes: { x: { min: 0, max: 100, step: 1 }, y: { min: 0, max: 60, step: 5 } } })).toContain(`${at}.axes.x.step step`);
    expect(errors({ ...line, line: [["0", "5"], [8, 45]] })).toContain(`${at}.line type`);
    expect(errors({ ...line, axes: { x: { min: 0, max: 10, step: 1 } } })).toContain(`${at}.axes.y type`);
  });

  it("keeps only a picture Open Sourcebook keeps", () => {
    const stored = withoutRemotePictures({ ...label, url: "https://example.com/heart.png" }) as Record<string, unknown>;
    expect(stored.url).toBe("");
  });

  it("says its answer in words", () => {
    expect(askedAnswer(label)).toBe("A: right atrium; B: left ventricle");
    expect(askedAnswer(line)).toContain("y = 5x + 5");
    expect(askedQuestion({ type: "figure", url: "/v1/assets/x" })).toBeUndefined();
  });
});

describe("grades as the quiz kinds do, on their shared cases", () => {
  const asBlock = (question: Record<string, unknown>): Record<string, unknown> => {
    if (question.kind === "label") {
      const picture = question.picture as { url: string; caption?: string };
      return { type: "labelPicture", prompt: question.prompt, url: picture.url, ...(picture.caption ? { caption: picture.caption } : {}), marks: question.marks, ...(question.extra ? { extra: question.extra } : {}) };
    }
    return { type: "drawLine", prompt: question.prompt, axes: question.axes, line: question.line };
  };
  const shared = cases.cases.filter((c) => c.question.kind === "label" || c.question.kind === "graph");

  it("has cases for both", () => {
    expect(new Set(shared.map((c) => c.question.kind))).toEqual(new Set(["label", "graph"]));
  });

  it.each(shared.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const question = c.question as unknown as Record<string, unknown>;
    const block = asBlock(question);
    const grade = gradeAsked(block, c.response, question.names as string[] | undefined);
    expect(grade.answered).toBe(c.answered);
    expect(grade.fraction).toBeCloseTo(c.fraction, 9);
  });
});
