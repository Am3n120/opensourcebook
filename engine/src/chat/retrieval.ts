/**
 * Picks the passages a reply reads. When every passage of the turn's
 * sources fits the budget, all are read, in source order. Otherwise they
 * are ranked against the question (and the recent turns, which carry what
 * "it" and "that" refer to) with BM25 over words, and the best are read,
 * still in source order.
 *
 * Words come from `Intl.Segmenter`, so text in any script splits into words
 * the way that language does, with no word list or language assumed.
 */
import { buildPassages, type Passage } from "../sources/passages";
import type { NodeSource } from "../studio/types";

export interface PassagePick {
  passages: Passage[];
  /** How many passages the sources hold in all. */
  total: number;
}

const K1 = 1.2;
const B = 0.75;

export function pickPassages(sources: NodeSource[], query: string, budgetChars: number, context = ""): PassagePick {
  const all = buildPassages(sources);
  const size = all.reduce((sum, passage) => sum + passage.text.length, 0);
  if (size <= budgetChars) return { passages: all, total: all.length };

  const scored = rankPassages(all, query, context);
  const chosen: typeof scored = [];
  let used = 0;
  for (const entry of scored) {
    if (used + entry.passage.text.length > budgetChars) continue;
    chosen.push(entry);
    used += entry.passage.text.length;
  }
  chosen.sort((a, b) => a.index - b.index);
  return { passages: chosen.map((entry, position) => ({ ...entry.passage, label: `P${position + 1}` })), total: all.length };
}

/**
 * Passages ranked against a query (and, weighted less, the turns around
 * it) with BM25 over words, best first; ties keep source order. `index`
 * is each passage's place in `all`.
 */
export function rankPassages(all: Passage[], query: string, context = ""): Array<{ index: number; score: number; passage: Passage }> {
  // The question counts more than the turns around it.
  const terms = new Map<string, number>();
  for (const word of words(query)) terms.set(word, (terms.get(word) ?? 0) + 2);
  for (const word of words(context)) terms.set(word, (terms.get(word) ?? 0) + 1);

  const docs = all.map((passage) => counts(words(passage.text)));
  const lengths = docs.map((doc) => [...doc.values()].reduce((sum, n) => sum + n, 0));
  const average = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, lengths.length);
  const frequency = new Map<string, number>();
  for (const doc of docs) for (const word of doc.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1);

  const scored = all.map((passage, index) => {
    let score = 0;
    for (const [term, weight] of terms) {
      const tf = docs[index].get(term);
      if (!tf) continue;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (all.length - df + 0.5) / (df + 0.5));
      score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * lengths[index]) / (average || 1))));
    }
    return { index, score, passage };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Lower-cased words of `text`, in any script. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const segment of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    if (segment.isWordLike) out.push(segment.segment);
  }
  return out;
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const word of list) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}
