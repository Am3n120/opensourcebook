/**
 * The quiz result a player records (`item_results.result_json`): grading
 * through each question kind, reading it back as a later item's input, and
 * a new kind added as a registry entry.
 */
import { describe, expect, it } from "vitest";
import { createDefaultQuestionKinds } from "../src/engines/quiz/default-kinds";
import { sameAnswer } from "../src/engines/quiz/kinds";
import { gradeQuiz, readQuizResult } from "../src/engines/quiz/result";
import type { QuizPayload, QuizQuestion } from "../src/engines/quiz/schema";

describe("quiz result", () => {
  const payload = (): QuizPayload => ({
    title: "C",
    passMark: 0.7,
    feedback: "afterEach",
    questions: [
      { id: "q1", kind: "choice", topic: "A", prompt: "?", points: 1, feedback: { correct: "y", incorrect: "n" }, cites: [], options: ["x", "y"], answer: 1 },
      {
        id: "q2",
        kind: "worked",
        topic: "B",
        prompt: "?",
        points: 2,
        feedback: { correct: "y", incorrect: "n" },
        cites: [],
        steps: [
          { prompt: "a", input: "entries", values: ["2", "-1"] },
          { prompt: "b", input: "choice", options: ["yes", "no"], answer: 1 },
        ],
      },
      { id: "q3", kind: "choice", topic: "A", prompt: "?", points: 1, feedback: { correct: "y", incorrect: "n" }, cites: [], options: ["x", "y"], answer: 0 },
    ] as QuizQuestion[],
  });

  it("scores per question through its kind, with partial credit for worked steps", () => {
    const result = gradeQuiz(payload(), {
      q1: { choice: 1 },
      q2: { steps: [{ value: ["2.0", "−1"] }, { value: 1, revealed: true }] },
    });
    expect(result).toEqual({
      format: "quiz",
      version: 1,
      score: 0.5,
      earned: 2,
      total: 4,
      correct: 1,
      answered: 2,
      count: 3,
      passMark: 0.7,
      passed: false,
      questions: [
        { id: "q1", topic: "A", outcome: "right", earned: 1, points: 1 },
        { id: "q2", topic: "B", outcome: "partial", earned: 1, points: 2 },
        { id: "q3", topic: "A", outcome: "skipped", earned: 0, points: 1 },
      ],
      missed: ["q2", "q3"],
      // Equal shares keep the order topics first appear in.
      topicsMissed: ["A", "B"],
      topics: [
        { topic: "A", earned: 1, points: 2 },
        { topic: "B", earned: 1, points: 2 },
      ],
    });
  });

  it("passes at the mark and reads back as a later item's input", () => {
    const result = gradeQuiz(payload(), { q1: { choice: 1 }, q2: { steps: [{ value: ["2", "-1"] }, { value: 1 }] }, q3: { choice: 0 } });
    expect(result).toMatchObject({ score: 1, passed: true, missed: [], topicsMissed: [] });
    expect(readQuizResult(result as never)).toEqual({ score: 1, passed: true, missed: [], topicsMissed: [] });
    expect(readQuizResult({ answer: true })).toBeUndefined();
  });

  it("compares typed answers by value, not by form", () => {
    expect(sameAnswer(" 1/2 ", "0.5")).toBe(true);
    expect(sameAnswer("Falls", "falls")).toBe(true);
    expect(sameAnswer("3", "-3")).toBe(false);
  });

  it("takes a new kind as a registry entry, without touching grading", () => {
    const kinds = createDefaultQuestionKinds().register({
      id: "yesNo",
      label: "Yes or no",
      description: "Say whether a statement is true.",
      guidance: '"kind":"yesNo","answer":true|false',
      normalize: (raw) => ({ answer: raw.answer === true }),
      check: () => [],
      describeAnswer: (question) => String(question.answer),
      grade: (question, response) => ({ fraction: (response as { answer?: boolean })?.answer === question.answer ? 1 : 0, answered: response !== undefined }),
    });
    const check = { ...payload(), questions: [{ id: "q1", kind: "yesNo", topic: "A", prompt: "?", points: 1, feedback: { correct: "", incorrect: "" }, cites: [], answer: true }] };
    expect(gradeQuiz(check, { q1: { answer: true } }, kinds).score).toBe(1);
  });
});
