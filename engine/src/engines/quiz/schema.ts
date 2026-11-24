/**
 * The quiz payload (`outputs.payload_json` for format `quiz`) and the
 * result a player records for it (`item_results.result_json`).
 *
 * Payload, schema version 1:
 *
 *   {
 *     "title": "...",
 *     "passMark": 0.7,                 // 0...1, from the item's settings
 *     "feedback": "afterEach",          // or "atEnd": when the player shows it
 *     "timeLimit": 50,                  // optional, minutes from Start; absent: no limit
 *     "questions": [
 *       {
 *         "id": "q1", "kind": "choice", "topic": "...", "prompt": "...",
 *         "display": "optional LaTeX shown under the prompt",
 *         "points": 1,
 *         "feedback": { "correct": "...", "incorrect": "..." },
 *         "cites": [{ "passageId": "...", "sourceId": "...", "chunkId": "...",
 *                     "locator": { "charStart": 0, "charEnd": 812 }, "quote": "..." }],
 *         ...fields of its kind (kinds.ts)
 *       }
 *     ]
 *   }
 *
 * Every question cites at least one passage, with a quote copied from it;
 * the feedback explains from the same passages. A question's `kind` decides
 * its extra fields, how it is checked and how a response is graded. Kinds
 * live in a `QuestionKindRegistry`: a new kind is one more entry there, not a
 * change to this file.
 *
 * Result (`item_results.result_json`), what a player reports when the person
 * finishes a quiz. `gradeQuiz` in result.ts computes it from the payload
 * and the responses, so web and phone report the same numbers:
 *
 *   {
 *     "format": "quiz", "version": 1,
 *     "score": 0.58,        // earned / total, 0...1; what { "kind": "metric", "metric": "score" } reads
 *     "earned": 3.5, "total": 6, "correct": 3, "answered": 6, "count": 6,
 *     "passMark": 0.7, "passed": false,
 *     "questions": [{ "id": "q1", "topic": "...", "outcome": "right" | "partial" | "wrong" | "skipped",
 *                     "earned": 1, "points": 1 }],
 *     "missed": ["q3", "q5"],          // ids not fully right, in order
 *     "topicsMissed": ["..."],         // topics with a miss, weakest first
 *     "topics": [{ "topic": "...", "earned": 1, "points": 2 }],
 *     "seconds": 2710, "timedOut": false  // a quiz with a time limit only: added by the player
 *   }
 *
 * Every number a branch may read sits at the top level (`score`, `earned`,
 * `correct`), so the existing `metric` condition branches on any of them. A
 * later item receives the whole result as `NodeInput.result`.
 */
import type { SourceLocator } from "../../studio/types";

export const QUIZ_SCHEMA_VERSION = 1;
export const QUIZ_RESULT_VERSION = 1;

export type FeedbackTiming = "afterEach" | "atEnd";
export const FEEDBACK_TIMINGS: readonly FeedbackTiming[] = ["afterEach", "atEnd"];

/** One passage a question tests. `chunkId` is absent when the source had no stored chunks. */
export interface QuestionCite {
  passageId: string;
  sourceId: string;
  chunkId?: string;
  locator?: SourceLocator;
  /** Copied word for word from the passage; validation checks it is there. */
  quote: string;
}

export interface QuestionFeedback {
  /** Shown when the answer is right: why it is right. */
  correct: string;
  /** Shown when it is wrong: what the passage says and where the reasoning goes off. */
  incorrect: string;
}

/** Fields every question has, whatever its kind. */
export interface QuestionBase {
  id: string;
  kind: string;
  /** What the question is about, in a few words; results group misses by it. */
  topic: string;
  prompt: string;
  /** Optional LaTeX shown under the prompt (a matrix, an equation). */
  display?: string;
  points: number;
  feedback: QuestionFeedback;
  cites: QuestionCite[];
}

/** A question of any kind: the base plus its kind's own fields. */
export type QuizQuestion = QuestionBase & Record<string, unknown>;

export interface QuizPayload {
  title: string;
  /** 0...1. */
  passMark: number;
  feedback: FeedbackTiming;
  questions: QuizQuestion[];
  /** The maker's own words on why the quiz has a different number of questions from the one planned. */
  sizeNote?: string;
  /**
   * Minutes the person has from pressing Start, from the item's settings.
   * The player counts down, and when it reaches zero the quiz ends as it
   * stands: what is unanswered is skipped. Absent: no limit.
   */
  timeLimit?: number;
}

export type QuestionOutcome = "right" | "partial" | "wrong" | "skipped";

export interface QuestionResult {
  id: string;
  topic: string;
  outcome: QuestionOutcome;
  earned: number;
  points: number;
}

export interface TopicResult {
  topic: string;
  earned: number;
  points: number;
}

export interface QuizResult {
  format: "quiz";
  version: number;
  score: number;
  earned: number;
  total: number;
  correct: number;
  answered: number;
  count: number;
  passMark: number;
  passed: boolean;
  questions: QuestionResult[];
  missed: string[];
  topicsMissed: string[];
  topics: TopicResult[];
  /** A quiz with a time limit: seconds from Start to the end, and whether the time ran out. Added by the player. */
  seconds?: number;
  timedOut?: boolean;
}

/** Upper bound on a fixed length; a quiz longer than this is better split into several items. */
export const MAX_QUESTIONS = 80;
/** The longest time limit a quiz takes, in minutes: a long exam paper. */
export const MAX_TIME_LIMIT = 300;
/** How long the exam's own format may be, in the person's words. */
export const MAX_LAYOUT = 1_000;
/** Questions written or reviewed per model call. */
export const QUESTIONS_PER_CALL = 5;

/** Bounds every quiz keeps, whatever its settings. */
export const QUESTION_LIMITS = {
  prompt: 2_000,
  display: 2_000,
  topic: 80,
  feedback: 2_000,
  quote: 600,
  cites: 3,
  points: 100,
} as const;
