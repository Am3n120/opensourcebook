/**
 * The teach-back skill: the person explains an idea from their sources in
 * their own words, and Open Sourcebook answers with what they got right, what they left
 * out and what they got wrong, each cited at the spot in their sources that
 * shows it (a teachback block, blocks.ts). Saying the idea back is how a
 * person finds out what they have not yet understood; the sources are the
 * measure, never what Open Sourcebook happens to know.
 *
 * This is how Open Sourcebook's own model does it; the person's agent is told the same
 * (agent/prompt.ts) and writes the same block with its reply tool.
 */
import { answerFromSources } from "./answer";
import { say } from "./pieces";
import type { ChatSkill } from "./skills";

/** How to answer a teach-back, said once for every writer. */
export const TEACH_BACK_GUIDE = `Judge their explanation against what the sources say about that idea, and nothing else. Reply with one short paragraph first: how close they are, and the one thing most worth fixing. Then one teachback block that sorts their explanation point by point: what they said that the sources bear out (right), what the sources treat as part of the idea that they left out (missing), and what they said that the sources contradict (wrong). One sentence per item, each cited at the spot that shows it; a wrong item says what the sources say instead. Credit what is right in their words, not in yours. Leave out small details the sources do not dwell on. A point the sources neither make nor contradict is not wrong: if it matters, say in the paragraph that the sources do not cover it. Be plain and kind; they are learning.`;

/** What Open Sourcebook says to a teach-back with nothing to check yet. */
export const TEACH_BACK_START =
  "Pick an idea from your sources and explain it here in your own words, as if to a friend who hasn't read them. I'll tell you what you got right, what you left out and what's off, with the spot in your sources for each.";

export function createTeachBackSkill(): ChatSkill {
  return {
    id: "teachBack",
    label: "teach-back",
    command: "teachback",
    title: "Explain it back",
    group: "chat",
    action: "Explain it back",
    chatOnly: true,
    about: "Checks your own explanation of an idea against your sources: what you got right, what you left out and what you got wrong, each with the spot in your sources.",
    whenToUse:
      "the person explains an idea from their sources in their own words to find out whether they have understood it (\"here's how I understand X, is that right?\", \"let me explain it back\"), rather than asking what the sources say.",
    async run(turn) {
      const explanation = turn.text.trim();
      if (!explanation) return { pieces: [say(TEACH_BACK_START)] };
      return answerFromSources({
        text: explanation,
        history: turn.history,
        context: turn.context,
        provider: turn.provider,
        ask: `This message is a teach-back: the person explains an idea from their sources in their own words, to see how well they have it. ${TEACH_BACK_GUIDE}`,
      });
    },
  };
}
