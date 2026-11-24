import { isApiError } from "../api/errors";

/**
 * Several of the person's agents are ready and none is picked for this, so
 * the engine asks who (`409 pick_needed`) and keeps nothing. The app then
 * opens the picker with one of these lines and tries again with the pick.
 */
export function isPickNeeded(error: unknown): boolean {
  return isApiError(error, "pick_needed");
}

/** The line in the picker opened for a thing to make or a plan to start. */
export const PICK_MAKER = "Pick who makes this";
/** The line in the picker opened for a chat message. */
export const PICK_CHAT = "Pick who answers the chat";
