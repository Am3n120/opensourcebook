/**
 * The quiz player's pieces, one per kind of question the engine registers
 * (engine/src/engines/quiz/default-kinds.ts). A new kind is one file here
 * and one entry below, beside its grading in quizGrade.ts.
 */
import { Choice } from "./Choice";
import { Complete } from "./Complete";
import { Graph } from "./Graph";
import { Label } from "./Label";
import { Match } from "./Match";
import { Order } from "./Order";
import type { QuizPiece } from "./piece";
import { choiceKey, choiceSaid, orderVerdict, stepsDone, workedVerdict } from "./rules";
import { Worked } from "./Worked";

export const QUIZ_PIECES: Readonly<Record<string, QuizPiece>> = {
  choice: { View: Choice, said: choiceSaid, key: choiceKey, keys: "A–D answer" },
  worked: { View: Worked, done: stepsDone, verdict: workedVerdict },
  order: { View: Order, verdict: orderVerdict },
  match: { View: Match },
  complete: { View: Complete },
  graph: { View: Graph },
  label: { View: Label },
};

export function pieceOf(kind: string): QuizPiece | undefined {
  return Object.hasOwn(QUIZ_PIECES, kind) ? QUIZ_PIECES[kind] : undefined;
}
