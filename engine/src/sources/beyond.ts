/**
 * What a piece of writing states that its sources do not contain: numbers
 * and named terms (written in bold, the way a key term is introduced) that
 * appear nowhere in the passages. It cannot judge a claim's meaning, only
 * spot these two kinds of addition cheaply and surely, so a writer is told
 * of them and decides: cite the passage that says it, or show it as their
 * own (a background block, an example said to be one).
 */
const NUMBER = /(?<![\p{L}\d.,])[-−]?(?:\d[\d,]*)?\.?\d+(?:%| ?percent)?/gu;
const BOLD = /\*\*([^*\n]{2,80})\*\*/g;

/** Digits and points only, commas dropped, so 1,000 and 1000 match; a leading zero before a point is optional. */
function numberKey(value: string): string {
  return value.replace(/[−]/g, "-").replace(/,/g, "").replace(/ ?percent|%/g, "").replace(/^(-?)0(?=\.)/, "$1");
}

function words(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The numbers and bold terms in `text` that none of `sources` contains.
 * Whole numbers of one digit are left alone: counts like "two" written as 2 are
 * too common to be a claim.
 */
export function beyondSources(text: string, sources: readonly string[]): { numbers: string[]; terms: string[] } {
  const all = sources.join("\n");
  const known = new Set([...all.matchAll(NUMBER)].map((m) => numberKey(m[0])));
  const plain = words(all);
  const numbers = [...new Set([...text.replace(BOLD, "$1").matchAll(NUMBER)].map((m) => m[0].trim()))].filter((n) => (numberKey(n).includes(".") || numberKey(n).replace(/^-/, "").length > 1) && !known.has(numberKey(n)));
  const terms = [...new Set([...text.matchAll(BOLD)].map((m) => m[1]!.trim()))].filter((term) => !plain.includes(words(term)));
  return { numbers, terms };
}
