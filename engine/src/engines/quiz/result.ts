/**
 * Grading a finished quiz into the result a player records
 * (`item_results.result_json`; shape documented in schema.ts), and reading
 * such a result back when a later item takes it as an input.
 */
import type { JsonValue } from "../../studio/types";
import { createDefaultQuestionKinds } from "./default-kinds";
import type { QuestionKindRegistry } from "./kinds";
import {
  QUIZ_RESULT_VERSION,
  type QuizPayload,
  type QuizResult,
  type QuestionOutcome,
  type QuestionResult,
  type TopicResult,
} from "./schema";

/** The person's responses, by question id. The shape of each is the question kind's. */
export type QuizResponses = Record<string, unknown>;

const defaultKinds = createDefaultQuestionKinds();

/** Scores every question through its kind. A question with no response is skipped and earns nothing. */
export function gradeQuiz(payload: QuizPayload, responses: QuizResponses, kinds: QuestionKindRegistry = defaultKinds): QuizResult {
  const questions: QuestionResult[] = payload.questions.map((question) => {
    const kind = kinds.get(question.kind);
    const grade = kind ? kind.grade(question, responses[question.id]) : { fraction: 0, answered: false };
    const fraction = Math.min(1, Math.max(0, grade.fraction));
    const outcome: QuestionOutcome = !grade.answered ? "skipped" : fraction === 1 ? "right" : fraction === 0 ? "wrong" : "partial";
    return { id: question.id, topic: question.topic, outcome, earned: round(question.points * fraction), points: question.points };
  });

  const topics = new Map<string, TopicResult>();
  for (const question of questions) {
    const topic = topics.get(question.topic) ?? { topic: question.topic, earned: 0, points: 0 };
    topic.earned = round(topic.earned + question.earned);
    topic.points = round(topic.points + question.points);
    topics.set(question.topic, topic);
  }
  const earned = round(questions.reduce((sum, question) => sum + question.earned, 0));
  const total = round(questions.reduce((sum, question) => sum + question.points, 0));
  const score = total > 0 ? round(earned / total) : 0;
  const topicList = [...topics.values()];

  return {
    format: "quiz",
    version: QUIZ_RESULT_VERSION,
    score,
    earned,
    total,
    correct: questions.filter((question) => question.outcome === "right").length,
    answered: questions.filter((question) => question.outcome !== "skipped").length,
    count: questions.length,
    passMark: payload.passMark,
    passed: score >= payload.passMark,
    questions,
    missed: questions.filter((question) => question.outcome !== "right").map((question) => question.id),
    topicsMissed: topicList
      .filter((topic) => topic.earned < topic.points)
      .sort((a, b) => a.earned / a.points - b.earned / b.points)
      .map((topic) => topic.topic),
    topics: topicList,
  };
}

/** What a later item needs from an earlier quiz's result; undefined when it is not one. */
export interface QuizResultSummary {
  score: number;
  passed?: boolean;
  missed: string[];
  topicsMissed: string[];
}

export function readQuizResult(value: JsonValue | undefined): QuizResultSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) return undefined;
  const strings = (entry: JsonValue | undefined) => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : []);
  return {
    score: value.score,
    ...(typeof value.passed === "boolean" ? { passed: value.passed } : {}),
    missed: strings(value.missed),
    topicsMissed: strings(value.topicsMissed),
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
