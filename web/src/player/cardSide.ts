import { createContext } from "react";

/**
 * What the card around the blocks says: whether its hidden parts (a cloze's
 * gaps) show yet, and what to do when a question on it is answered, so the
 * answer marks the card. Outside a card, gaps show and answers mark nothing.
 */
export interface CardSide {
  revealed: boolean;
  answered?: (right: boolean) => void;
}
export const CardSideContext = createContext<CardSide>({ revealed: true });
