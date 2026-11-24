import { describe, expect, it } from "vitest";
import cases from "../src/engines/quiz/kind-cases.json";
import { createDefaultQuestionKinds } from "../src/engines/quiz/default-kinds";
import { QuizEngine } from "../src/engines/quiz/engine";
import { seededRandom, type QuestionKind } from "../src/engines/quiz/kinds";
import { lineParts } from "../src/engines/quiz/kind/complete";
import { picturesNote, sourcePictures } from "../src/engines/quiz/pictures";
import type { QuizQuestion } from "../src/engines/quiz/schema";
import type { NodeSource } from "../src/studio/types";
import type { QuizSettings } from "../src/engines/quiz/definition";

const kinds = createDefaultQuestionKinds();
const kind = (id: string): QuestionKind => kinds.get(id)!;

const base = { id: "q1", topic: "t", prompt: "?", points: 1, feedback: { correct: "", incorrect: "" }, cites: [] };
/** A question as a writer sends it: normalized by its kind, then arranged as the engine does. */
function written(id: string, raw: Record<string, unknown>, arrange = true): QuizQuestion {
  const fields = kind(id).normalize(raw);
  const question = { ...base, ...fields, kind: id } as QuizQuestion;
  return arrange ? ({ ...question, ...(kind(id).arrange?.(question, seededRandom("seed")) ?? {}) } as QuizQuestion) : question;
}
const codes = (question: QuizQuestion, context = {}) => kind(question.kind).check(question, context).map((issue) => issue.code);

describe("every kind grades the shared cases as the web player does", () => {
  it.each(cases.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const question = c.question as unknown as QuizQuestion;
    const grade = kind(question.kind).grade(question, c.response);
    expect(grade.answered).toBe(c.answered);
    expect(grade.fraction).toBeCloseTo(c.fraction, 9);
    // Every case is a question its own kind accepts.
    expect(kind(question.kind).check(question)).toEqual([]);
  });
});

describe("kinds offer themselves in their own words", () => {
  it("registers the new kinds after choice and worked", () => {
    expect(kinds.ids()).toEqual(["choice", "worked", "order", "match", "complete", "graph", "label"]);
    for (const each of kinds.all()) {
      expect(each.guidance).toContain(`"kind":"${each.id}"`);
      expect(Object.keys(each.fields ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("keeps each kind's field names its own, so one writing tool can describe them all", () => {
    const owners = new Map<string, string>();
    for (const each of kinds.all()) {
      for (const name of Object.keys(each.fields ?? {})) {
        expect(owners.get(name), `${name} is a field of ${owners.get(name)} and ${each.id}`).toBeUndefined();
        owners.set(name, each.id);
      }
    }
  });
});

describe("put in order", () => {
  it("is shown mixed, never in the right order", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const question = written("order", { items: ["one", "two", "three"] }, false);
      const shown = kind("order").arrange!(question, seededRandom(seed)).shown as number[];
      expect([...shown].sort()).toEqual([0, 1, 2]);
      expect(shown).not.toEqual([0, 1, 2]);
    }
  });

  it("refuses too few or repeated items", () => {
    expect(codes(written("order", { items: ["a", "b"] }))).toEqual(["count"]);
    expect(codes(written("order", { items: ["a", "b", "A "] }))).toEqual(["duplicate"]);
  });

  it("tells the chat what was shown, what was given and what is right", () => {
    const question = written("order", { items: ["egg", "larva", "adult"] });
    expect(kind("order").describeShown!(question)[0]).toMatch(/^To put in order, shown mixed as: /);
    expect(kind("order").describeResponse!(question, { order: [1, 0, 2] })).toBe("the order 1. larva; 2. egg; 3. adult");
    expect(kind("order").describeAnswer(question)).toBe("1. egg; 2. larva; 3. adult");
  });
});

describe("match pairs", () => {
  it("offers the rights in a mixed order and refuses a right that repeats", () => {
    const question = written("match", { pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }, { left: "c", right: "3" }] });
    expect(question.rights).not.toEqual([0, 1, 2]);
    expect(codes(question)).toEqual([]);
    expect(codes(written("match", { pairs: [{ left: "a", right: "1" }, { left: "b", right: "1" }] }))).toEqual(["duplicate"]);
    expect(codes(written("match", { pairs: [{ left: "a", right: "1" }] }))).toEqual(["count"]);
  });

  it("says each pairing given, right or wrong", () => {
    const question = written("match", { pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }] });
    expect(kind("match").describeResponse!(question, { matches: [1, null] })).toBe("a → 2 (wrong); b → (none) (wrong)");
  });
});

describe("label a picture", () => {
  const raw = { picture: { url: "/v1/assets/abc", caption: "A cell" }, marks: [{ mark: "A", answer: "nucleus" }, { mark: "B", answer: "wall" }], extra: ["ribosome"] };

  it("offers every name once, mixed", () => {
    const question = written("label", raw);
    expect([...(question.names as string[])].sort()).toEqual(["nucleus", "ribosome", "wall"]);
    expect(codes(question)).toEqual([]);
  });

  it("takes only a picture the sources hold", () => {
    expect(codes(written("label", { ...raw, picture: { url: "https://example.com/cell.png" } }))).toEqual(["picture"]);
    expect(codes(written("label", raw), { pictures: new Set(["/v1/assets/other"]) })).toEqual(["picture"]);
    expect(codes(written("label", raw), { pictures: new Set(["/v1/assets/abc"]) })).toEqual([]);
  });

  it("refuses a name used twice and a mark that is not a mark", () => {
    expect(codes(written("label", { ...raw, extra: ["Nucleus"] }))).toContain("duplicate");
    expect(codes(written("label", { ...raw, marks: [{ mark: "the round part in the middle", answer: "nucleus" }, { mark: "B", answer: "wall" }] }))).toEqual(["too_long"]);
  });
});

describe("draw a line on a graph", () => {
  const axes = { x: { min: 0, max: 10, step: 1, label: "hours" }, y: { min: 0, max: 50, step: 5 } };

  it("accepts a line through two grid points and says it as y = mx + c", () => {
    const question = written("graph", { axes, line: [[0, 10], [4, 30]] });
    expect(codes(question)).toEqual([]);
    expect(kind("graph").describeAnswer(question)).toBe("the line through (0, 10) and (4, 30), y = 5x + 10");
  });

  it("reads numbers sent as text", () => {
    expect(codes(written("graph", { axes: { x: { min: "0", max: "10", step: "1" }, y: axes.y }, line: [["0", "10"], ["4", "30"]] }))).toEqual([]);
  });

  it("refuses points off the grid, the same point twice and a grid too fine to tap", () => {
    expect(codes(written("graph", { axes, line: [[0, 12], [4, 30]] }))).toEqual(["off_grid"]);
    expect(codes(written("graph", { axes, line: [[1, 10], [1, 10]] }))).toEqual(["line"]);
    expect(codes(written("graph", { axes: { ...axes, x: { min: 0, max: 100, step: 1 } }, line: [[0, 10], [4, 30]] }))).toEqual(["step"]);
    expect(codes(written("graph", { axes: { ...axes, x: { min: 5, max: 0, step: 1 } }, line: [[0, 10], [4, 30]] }))).toEqual(["axis"]);
  });
});

describe("fill in the working", () => {
  it("finds its gaps and the answers each takes", () => {
    expect(lineParts("v = [[30|thirty]] km/h")).toEqual([{ text: "v = " }, { answers: ["30", "thirty"] }, { text: " km/h" }]);
  });

  it("needs at least one gap, none inside maths, none left open", () => {
    expect(codes(written("complete", { lines: ["a", "b"] }))).toEqual(["gaps"]);
    expect(codes(written("complete", { lines: ["a", "$x = [[2]]$"] }))).toEqual(["gap"]);
    expect(codes(written("complete", { lines: ["a", "x = [[2"] }))).toEqual(["gap"]);
    expect(codes(written("complete", { lines: ["$v = d/t$", "v = [[2]]"] }))).toEqual([]);
  });

  it("shows the person blanks and the chat what they typed", () => {
    const question = written("complete", { lines: ["v = d / t", "v = 120 / [[4]] = [[30]]"] });
    expect(kind("complete").describeShown!(question)).toEqual(["The working, with gaps to fill in:", "v = d / t", "v = 120 / ___ = ___"]);
    expect(kind("complete").describeResponse!(question, { gaps: ["4", ""] })).toBe("gap 1: 4 (right); gap 2: (blank) (wrong)");
  });
});

describe("kinds about a picture", () => {
  const settings: QuizSettings = { questions: 0, kinds: kinds.ids(), difficulty: "auto", passMark: 70, feedback: "afterEach" };
  const source = (assets: Array<{ kind: string; url: string; caption?: string }>): NodeSource =>
    ({ sourceId: "s1", title: "Cells", envelope: { title: "Cells", text: "", assets: assets.map((asset, at) => ({ id: `a${at}`, ...asset })) }, chunks: [] }) as unknown as NodeSource;

  it("are left out when the sources hold no picture Open Sourcebook keeps", () => {
    const engine = new QuizEngine({ kinds });
    expect(engine.allowedKinds(settings, [source([{ kind: "image", url: "https://example.com/x.png" }])]).map((each) => each.id)).not.toContain("label");
    expect(engine.allowedKinds(settings, [source([{ kind: "figure", url: "/v1/assets/abc" }])]).map((each) => each.id)).toContain("label");
    expect(() => engine.allowedKinds({ ...settings, kinds: ["label"] }, [source([])])).toThrow(/sources have no pictures/);
  });

  it("show the writer each picture with its caption", () => {
    const pictures = sourcePictures([source([{ kind: "figure", url: "/v1/assets/abc", caption: "Figure 2:  a cell" }, { kind: "audio", url: "/v1/assets/sound" }])]);
    expect(pictures).toEqual([{ url: "/v1/assets/abc", source: "Cells", caption: "Figure 2: a cell" }]);
    expect(picturesNote(pictures)).toContain('- /v1/assets/abc from "Cells": Figure 2: a cell');
    expect(picturesNote([])).toBeUndefined();
  });
});
