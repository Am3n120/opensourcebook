import { describe, expect, test } from "vitest";
import cases from "../src/engines/quiz/answer-cases.json";
import { entryBoxes, sameAnswer, workedKind } from "../src/engines/quiz/kinds";
import type { QuizQuestion } from "../src/engines/quiz/schema";

describe("typed answers", () => {
  test.each(cases.same as Array<[string, string, string?]>)("%s is the same answer as %s", (given, expected, unit) => {
    expect(sameAnswer(given, expected, unit)).toBe(true);
  });
  test.each(cases.different as Array<[string, string, string?]>)("%s is not %s", (given, expected, unit) => {
    expect(sameAnswer(given, expected, unit)).toBe(false);
  });
});

const question = (steps: unknown[]) => ({ id: "q1", kind: "worked", topic: "t", prompt: "p", points: 1, feedback: { correct: "", incorrect: "" }, cites: [], steps }) as unknown as QuizQuestion;

test("a typed step has one box; equivalent forms of its answer are not listed as more boxes", () => {
  expect(workedKind.check(question([{ prompt: "Area?", input: "entries", values: ["52.5", "52.50"] }]))[0]?.code).toBe("values");
  expect(workedKind.check(question([{ prompt: "Area?", input: "entries", values: ["52.5"], unit: "cm²", form: "to one decimal place" }]))).toEqual([]);
});

test("an older step whose boxes are one answer written two ways is one box", () => {
  expect(entryBoxes({ prompt: "", input: "entries", values: ["52.5", "52.50"] })).toEqual([["52.5", "52.50"]]);
  expect(entryBoxes({ prompt: "", input: "entries", values: ["3", "4"] })).toEqual([["3"], ["4"]]);
  const q = question([{ prompt: "", input: "entries", values: ["52.5", "52.50"] }]);
  expect(workedKind.grade(q, { steps: [{ value: ["52,50"] }] })).toEqual({ fraction: 1, answered: true });
});

test("a shown step costs that step only", () => {
  const q = question([
    { prompt: "a", input: "entries", values: ["2"] },
    { prompt: "b", input: "entries", values: ["4"], unit: "cm" },
  ]);
  expect(workedKind.grade(q, { steps: [{ value: [""], revealed: true }, { value: ["4 cm"] }] })).toEqual({ fraction: 0.5, answered: true });
});

test("a step keeps its unit, form and other accepted answers", () => {
  const [step] = workedKind.normalize({ steps: [{ prompt: "p", input: "entries", values: ["7"], unit: "kg", form: "a whole number", accept: ["seven"] }] }).steps as unknown[];
  expect(step).toEqual({ prompt: "p", input: "entries", values: ["7"], unit: "kg", form: "a whole number", accept: ["seven"] });
});
