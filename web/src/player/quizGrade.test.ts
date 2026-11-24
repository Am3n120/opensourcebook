import cases from "../../../engine/src/engines/quiz/answer-cases.json";
import kindCases from "../../../engine/src/engines/quiz/kind-cases.json";
import { asQuiz, gradeQuiz, sameAnswer } from "./quizGrade";

const quiz = asQuiz({
  title: "Limits",
  passMark: 0.7,
  feedback: "afterEach",
  questions: [
    { id: "q1", kind: "choice", topic: "limits", prompt: "?", points: 1, options: ["a", "b"], answer: 1, feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q2", kind: "worked", topic: "algebra", prompt: "?", points: 2, steps: [{ prompt: "x", input: "entries", values: ["1/2"] }, { prompt: "y", input: "choice", options: ["u", "v"], answer: 0 }], feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q3", kind: "drawing", topic: "limits", prompt: "?", points: 1, feedback: { correct: "", incorrect: "" }, cites: [] },
  ],
});

test("grades like the engine: points, outcomes, topics missed hardest first", () => {
  const r = gradeQuiz(quiz, { q1: { choice: 1 }, q2: { steps: [{ value: ["0.5"] }, { value: 1 }] } }) as Record<string, unknown>;
  expect(r).toMatchObject({ format: "quiz", version: 1, earned: 2, total: 4, score: 0.5, correct: 1, answered: 2, count: 3, passed: false, missed: ["q2", "q3"] });
  expect((r.questions as Array<{ outcome: string }>).map((q) => q.outcome)).toEqual(["right", "partial", "skipped"]);
  expect(r.topicsMissed).toEqual(["limits", "algebra"]);
});

test("a revealed step earns nothing", () => {
  const r = gradeQuiz(quiz, { q2: { steps: [{ value: ["1/2"], revealed: true }, { value: 0 }] } }) as { questions: Array<{ earned: number }> };
  expect(r.questions[1]!.earned).toBe(1);
});

test("typed answers ignore case, spacing, minus signs and number forms", () => {
  expect(sameAnswer(" −3 ", "-3")).toBe(true);
  expect(sameAnswer("1/4", "0.25")).toBe(true);
  expect(sameAnswer("Rank", "rank")).toBe(true);
  expect(sameAnswer("2", "3")).toBe(false);
});


test.each(cases.same as Array<[string, string, string?]>)("as the engine: %s is the same answer as %s", (given, expected, unit) => {
  expect(sameAnswer(given, expected, unit)).toBe(true);
});
test.each(cases.different as Array<[string, string, string?]>)("as the engine: %s is not %s", (given, expected, unit) => {
  expect(sameAnswer(given, expected, unit)).toBe(false);
});

test.each(kindCases.cases.map((c) => [c.name, c] as const))("grades as the engine does: %s", (_name, c) => {
  const quiz = asQuiz({ title: "t", passMark: 0.5, feedback: "afterEach", questions: [c.question as never] });
  const r = gradeQuiz(quiz, c.response === null ? {} : { q1: c.response as never }) as { questions: Array<{ earned: number; outcome: string }> };
  expect(r.questions[0]!.earned).toBeCloseTo(c.fraction, 3);
  expect(r.questions[0]!.outcome === "skipped").toBe(!c.answered);
});
