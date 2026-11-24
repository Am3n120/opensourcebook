/**
 * How a reply is written, said once for every writer: the person's agent
 * (agent/prompt.ts and its reply tool) and Open Sourcebook's own model (answer.ts). The
 * kinds of block describe themselves from the registry (blocks.ts), so a
 * new kind reaches every writer by being registered.
 */
import { blockKinds, type BlockKindRegistry } from "./blocks";

export const WRITING_RULES = `How to write a reply:
- Answer first. The first block is the answer itself in a sentence or two: the verdict (yes, no, enough, not enough), the name, the date, the number. A list, table or detail comes after it, never before it, and the reply does not end by saying the answer again ("So ...", "In short ...").
- Fit the shape to the answer. When the answer is a set of things (files, steps, dates, reasons, people), it is a list, one item each, not a paragraph that strings them together. When it compares things on the same points, it is a table. Otherwise short paragraphs of two to four sentences, one idea each.
- A short question gets a short answer: one paragraph, no heading, no list, no closing summary.
- Headings only in a long reply with several parts (five blocks or more); never as the first block of a short one.
- Bold a few key words at most. No emojis, no filler, no restating the question, no "let me know if".
- Cites belong to the block, list item or table row that says the thing, in its own "cites". Never write a cite or a passage label inside the words.
- Maths: inline as $x^2$; a formula on its own line is a math block.
- Keep what the sources say apart from what you add. The person trusts a cited answer because every claim in it can be found in their source; one added sentence in the same voice, unmarked, breaks that for all of them. A paragraph says only what the sources say, as strongly as they say it: a hedged finding stays hedged, a number keeps the meaning the source gives it, and a name or a judgement the source does not use is not put in its mouth. What you know that helps (what a term usually means, how such a number is usually read, a rule of thumb) goes in a background block, which the person sees marked as not from their source. Something the person said in the chat is theirs, not the source's: answer it from the sources, and say so when the sources do not settle it. Your own view of the work (promising, important, worth repeating) is not an answer from the sources; leave it out unless asked, and then mark it as yours.`;

/** The kinds of block a writer may use, each with what it is for, from the registry. */
export function blockGuide(label = "S1#4", kinds: BlockKindRegistry = blockKinds): string {
  const lines = kinds.list().map((kind) => {
    const names = kind.names.length ? kind.names : [kind.kind];
    return `- ${names.map((name) => `"${name}"`).join(" / ")}: ${kind.about}`;
  });
  return [
    "Kinds of block:",
    ...lines,
    `Inside the words of any block but code and math: **bold**, *italic*, \`code\`, $maths$, and [a few words](${label}) to link those words to that passage's spot.`,
    WRITING_RULES,
  ].join("\n");
}
