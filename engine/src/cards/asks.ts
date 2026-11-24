/**
 * Card blocks that ask the way a kind of quiz question does: a picture to
 * label by its own marks (`labelPicture`, the quiz's label kind) and a line
 * to draw on a grid (`drawLine`, the quiz's graph kind). A card reads the
 * block as that kind's question, so what makes it valid and how an answer is
 * graded are the kind's own, never a second copy: a card and a quiz question
 * built from the same picture or line agree on what is right. The web
 * player grades them with the same graders the quiz player uses
 * (web/src/player/quizGrade.ts), which are tested on the same cases.
 */
import { graphKind } from "../engines/quiz/kind/graph";
import { labelKind } from "../engines/quiz/kind/label";
import type { Grade, KindIssue, QuestionKind } from "../engines/quiz/kinds";
import type { QuizQuestion } from "../engines/quiz/schema";
import { isRecord } from "../net";

interface AskedAs {
  kind: QuestionKind;
  /** The kind's own fields, from the block's. */
  fields(block: Record<string, unknown>): Record<string, unknown>;
  /** A path in the kind's question, as a path in the block. */
  path(path: string): string;
}

/** Each block that asks as a quiz kind does, and which kind. */
export const ASKED_AS: Readonly<Record<string, AskedAs>> = {
  labelPicture: {
    kind: labelKind,
    fields: (block) => ({
      picture: { url: block.url, ...(block.caption !== undefined ? { caption: block.caption } : {}) },
      marks: block.marks,
      ...(block.extra !== undefined ? { extra: block.extra } : {}),
    }),
    path: (path) => path.replace(/^\.picture\./, ".").replace(/^\.names$/, ".marks"),
  },
  drawLine: {
    kind: graphKind,
    fields: (block) => ({ axes: block.axes, line: block.line }),
    path: (path) => path,
  },
};

const asked = (block: unknown): AskedAs | undefined =>
  isRecord(block) && typeof block.type === "string" && Object.hasOwn(ASKED_AS, block.type) ? ASKED_AS[block.type] : undefined;

/** The block as its kind's question, its fields cleaned as the kind cleans them; undefined for any other block. */
export function askedQuestion(block: unknown): QuizQuestion | undefined {
  const as = asked(block);
  if (!as || !isRecord(block)) return undefined;
  return {
    id: "card",
    kind: as.kind.id,
    topic: "",
    prompt: typeof block.prompt === "string" ? block.prompt : "",
    points: 1,
    feedback: { correct: "", incorrect: "" },
    cites: [],
    ...as.kind.normalize(as.fields(block)),
  } as QuizQuestion;
}

/** What the kind finds wrong with the block, paths relative to the block. */
export function askedIssues(block: unknown, context?: { pictures?: ReadonlySet<string> }): KindIssue[] {
  const as = asked(block);
  const question = askedQuestion(block);
  if (!as || !question) return [];
  return as.kind.check(question, context).map((issue) => ({ ...issue, path: as.path(issue.path) }));
}

/**
 * A response graded as the kind grades it. Label: `{ labels: [<index into
 * names> | null, ...] }` with `names` the order offered; draw a line:
 * `{ points: [[x, y], [x, y]] }`.
 */
export function gradeAsked(block: unknown, response: unknown, names?: readonly string[]): Grade {
  const as = asked(block);
  const question = askedQuestion(block);
  if (!as || !question) return { fraction: 0, answered: false };
  return as.kind.grade(names ? ({ ...question, names: [...names] } as QuizQuestion) : question, response);
}

/** The right answer in words ("A: the aorta; B: ..." or "the line through ..."). */
export function askedAnswer(block: unknown): string {
  const as = asked(block);
  const question = askedQuestion(block);
  return as && question ? as.kind.describeAnswer(question) : "";
}
