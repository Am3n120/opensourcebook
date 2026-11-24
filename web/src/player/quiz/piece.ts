import type { ReactNode } from "react";
import type { Outcome, Question, Response } from "../quizGrade";

export interface PieceProps {
  q: Question;
  /** What the person answered, once they have. */
  response: Response | undefined;
  /** The quiz gives feedback after each question: once answered, show what is right and wrong. */
  reveal: boolean;
  onAnswer: (r: Response) => void;
}

/**
 * How the quiz player draws one kind of question: what is under its prompt,
 * and the few things the player asks a kind. The player itself names no
 * kind; it reads `QUIZ_PIECES` (pieces.tsx).
 */
export interface QuizPiece {
  View: (props: PieceProps) => ReactNode;
  /** Whether the question is answered far enough to go on and show feedback. When absent, any response is. */
  done?: (q: Question, r: Response | undefined) => boolean;
  /** The verdict in the player's voice, when the kind says more than right or wrong. */
  verdict?: (q: Question, r: Response | undefined, outcome: Outcome) => string | undefined;
  /** The explanation tied to what was picked (an option's own line), said before the question's feedback. */
  said?: (q: Question, r: Response | undefined) => string | undefined;
  /** A key pressed while the question is open, as a response; undefined when the key means nothing here. */
  key?: (q: Question, key: string) => Response | undefined;
  /** The keys it takes, for the hint under the quiz. */
  keys?: string;
}

export const LETTERS = "ABCDEFGH";
