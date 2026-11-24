/**
 * A question's verdict is said once, by the player, in one voice. Feedback a
 * maker wrote may still open with its own ("Right.", "Wrong:", "Not quite,"),
 * from an older quiz or a writer that did not know; that opening is taken
 * off, so the explanation follows the player's verdict without a second one.
 */
const OWN_VERDICT =
  /^(?:(?:that's|that is|this is)\s+)?(?:right|correct|yes|exactly|indeed|spot on|well done|not quite(?: right)?|not this one|partly right|partly correct|partially correct|incorrect|wrong|no|nope)\s*[.:!,;—–-]+\s*/i;

/** The explanation without a verdict of its own at its start; it opens with a capital, as a sentence. */
export function withoutVerdict(text: string | undefined): string {
  const said = (text ?? "").trim();
  const rest = said.replace(OWN_VERDICT, "");
  if (rest === said) return said;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The player's own verdict for an answer. */
export function verdictWord(outcome: "right" | "partial" | "wrong" | "skipped"): string {
  return outcome === "right" ? "Right." : outcome === "partial" ? "Partly right." : "Not quite.";
}
