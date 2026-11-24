/**
 * Whether words a person reads or hears point at material only the writer saw: the labelled passages a maker is handed
 * ("as passage 2 says", "source s1", "P3", "the excerpt above"). The one check the engine's makers (video, flashcards,
 * quiz, audio) and the scenes service's write_beat use, so what Open Sourcebook would refuse at the end is what the agent is told
 * while it writes.
 *
 * It asks the real question, not whether a word appears: a label word ("passage", "excerpt", "chunk", "snippet",
 * "source text", "source") counts only when it is used as a pointer at the material:
 *
 * - with an id or a number after it: "passage 2", "passage P2", "excerpts #3", "source s1";
 * - with a word that places it in what the writer was given: "the passage above", "the provided source", "the excerpt
 *   below", "the passages given";
 * - as what something says: "the passage says", "this excerpt explains", "according to the passage", "using the
 *   passages", "as the source text puts it".
 *
 * Used as ordinary vocabulary it is never flagged: "final passage of the bill", "a passage through the mountains", "the
 * source of the river", "a quote from Lincoln". "source" alone is the person's own word for what they added (the video
 * names its sources by title), so it counts only with an id or a word placing it in the writer's material.
 *
 * The labels the writer was handed (P1, a passage id, a beat id like s2) count wherever they stand.
 *
 * Nothing counts that the person's own sources use in the same sense: a label that appears in them (a "P4" visa, the
 * "S1" heart sound), or a pointer phrase they contain themselves (an exam paper's "passage 2"). This file needs nothing
 * from Node or the engine, so both import it as it is.
 */

/** Words a maker's prompts use for the material it is handed; a person meets them only when a writer points at it. */
const WRITER_NOUNS = "passages?|excerpts?|chunks?|snippets?|source[ -]texts?";
/** The person's own word for what they added: a pointer only with an id, or a word placing it in the writer's material. */
const SOURCE_NOUN = "sources?";
/** Words that place the material in what the writer was given, before the noun ("the above passage"). */
const PLACED_BEFORE = "above|below|following|preceding|given|provided|supplied|attached|accompanying|included|quoted|excerpted";
/** The same after the noun ("the passage above", "the passages provided", "the source you were given"). */
const PLACED_AFTER = "above|below|provided|given|supplied|attached|here|you (?:were|are|have been) given|i (?:was|were|have been) given";
/** Saying what the material says: the noun as the one that speaks. */
const SAYS =
  "says|said|say|states?|stated|notes?|noted|mentions?|mentioned|explains?|explained|describes?|described|tells?|told|shows?|showed|reads|lists?|listed|puts? it|claims?|argues?|argued|writes?|wrote|suggests?|suggested|indicates?|indicated|adds?|added|teaches|taught|defines?|defined|gives?|gave|talks? about|refers? to|makes? clear|points? out";
const DEICTIC = "the|this|that|these|those";

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** An id or a number after a label word: "2", "#2", "no. 2", "P2", "s1", "2b". */
const ID = "(?:#\\s?|no\\.?\\s?|number\\s)?[a-z]{0,2}-?\\d+[a-z]?";

const POINTERS: RegExp[] = [
  // A label word with an id: "passage 2", "source s1", "excerpts #3".
  new RegExp(`${B}(?:${WRITER_NOUNS}|${SOURCE_NOUN})\\s+${ID}${E}`, "giu"),
  // Placed by a word before it: "the above passage", "the provided source".
  new RegExp(`${B}(?:${DEICTIC})\\s+(?:${PLACED_BEFORE})\\s+(?:${WRITER_NOUNS}|${SOURCE_NOUN})${E}`, "giu"),
  // Placed by a word after it: "the passage above", "the sources provided".
  new RegExp(`${B}(?:${DEICTIC})\\s+(?:${WRITER_NOUNS}|${SOURCE_NOUN})\\s+(?:${PLACED_AFTER})${E}`, "giu"),
  // The material as the one that speaks: "the passage says", "this excerpt explains".
  new RegExp(`${B}(?:${DEICTIC})\\s+(?:${WRITER_NOUNS})\\s+(?:${SAYS})${E}`, "giu"),
  // Read from the material: "according to the passage", "using the passages", "based on this excerpt".
  new RegExp(`${B}(?:according to|using|based on|from reading|reread|re-read|see|per)\\s+(?:${DEICTIC})\\s+(?:${WRITER_NOUNS})${E}(?!\\s+(?:of|through|to|across|between|into|from|over|under|along|past|by)${E})`, "giu"),
];

const squash = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Every pointer at the writer's material in the text, as written there, in order. */
export function pointersIn(text: string): string[] {
  const found: Array<{ at: number; said: string }> = [];
  for (const pattern of POINTERS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) found.push({ at: match.index ?? 0, said: match[0].replace(/\s+/g, " ").trim() });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.said);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A reader of one item's text: the labels its writer was handed and its sources' own text, read once. It returns
 * what in a text points at the writer's material (the label or the pointer as written), each once; empty when nothing
 * does.
 */
export function labelReader(labels: readonly string[], sourceText: string): (text: string) => string[] {
  const own = new Set(pointersIn(sourceText).map(squash));
  const known = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  const patterns = known
    .map((label) => ({ label, pattern: new RegExp(`${B}${escapeRegExp(label)}${E}`, "iu") }))
    // A label the sources use themselves is their word, not the writer's.
    .filter(({ pattern }) => !pattern.test(sourceText));
  return (text: string) => {
    if (!text) return [];
    const leaks: string[] = [];
    const seen = new Set<string>();
    const add = (said: string) => {
      const key = squash(said);
      if (seen.has(key)) return;
      seen.add(key);
      leaks.push(said);
    };
    for (const { label, pattern } of patterns) if (pattern.test(text)) add(label);
    for (const said of pointersIn(text)) if (!own.has(squash(said))) add(said);
    return leaks;
  };
}

/** One text read once: what in it points at the writer's material. */
export function labelLeaks(text: string, labels: readonly string[], sourceText: string): string[] {
  return labelReader(labels, sourceText)(text);
}
