/**
 * The mind map skill: the main ideas of the person's sources, or of one
 * topic in them, laid out as a map of how they connect, each idea cited at
 * the spot that says it (a mindmap block, blocks.ts). The map is part of
 * the chat's reply: it is drawn where the person asked for it and tapping
 * an idea opens its passages, as any cite does.
 *
 * This is how Open Sourcebook's own model does it; the person's agent is told the same
 * (agent/prompt.ts) and writes the same block with its reply tool.
 */
import { answerFromSources } from "./answer";
import type { ChatSkill } from "./skills";

/** How to draw a mind map, said once for every writer. */
export const MIND_MAP_GUIDE = `Reply with one short paragraph first: what the map shows and the one connection most worth seeing. Then one mind-map block of the main ideas the sources treat and how they connect: the central idea first, then the ideas that matter most around it (usually 6 to 12, never a node for a small detail), each named in a few words with one sentence of detail and a cite at the spot that says it. Link ideas the sources connect, with the connection in a few words read from one to the other ("causes", "is part of", "is measured by"); a connection the sources do not make is not drawn. Every idea links to the map, through others if need be.`;

export function createMindMapSkill(): ChatSkill {
  return {
    id: "mindMap",
    label: "mind map",
    command: "mindmap",
    title: "Map the ideas",
    group: "chat",
    action: "Map the ideas",
    chatOnly: true,
    about: "Lays out the main ideas in your sources and how they connect, as a map you can tap: each idea opens the spot in your sources that says it.",
    whenToUse:
      'the person asks to see the main ideas laid out and how they connect: a mind map, a concept map, "how does it all fit together", "map out chapter 3".',
    async run(turn) {
      const topic = turn.text.trim();
      return answerFromSources({
        text: topic,
        history: turn.history,
        context: turn.context,
        provider: turn.provider,
        ask: `The person asked for a mind map of ${topic ? "what the message names, from the sources" : "the main ideas across the sources; the message is empty because they named no topic"}. ${MIND_MAP_GUIDE}`,
      });
    },
  };
}
