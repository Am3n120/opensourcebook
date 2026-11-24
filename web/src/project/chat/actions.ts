import { createContext, useContext, type ReactNode } from "react";
import type { MakePiece, Message } from "../../api/types";

/**
 * What a reply's pieces can ask of the chat they are in: put words in the
 * box, open a make sheet a reply proposed, draw the thing it made. A reply
 * drawn elsewhere (a thing's thread) has none of these, and its pieces leave
 * those controls out.
 */
export interface ChatActions {
  /** Puts words in the box for the person to finish, and moves to it. */
  fill: (text: string) => void;
  /** Whether the chat command that led to a reply can be started again from the box. */
  canAgain: (reply: Message) => boolean;
  /** Starts the chat command that led to a reply again, in the box, for the person to finish. */
  again: (reply: Message) => void;
  /** Opens the make sheet a reply proposed, filled in from it. */
  openMake: (piece: MakePiece, messageId: string, index: number) => void;
  /** The card of the thing a proposal made, once its plan is known. */
  madeCard: (planId: string) => ReactNode;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions | null {
  return useContext(ChatActionsContext);
}
