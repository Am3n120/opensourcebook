/**
 * A source's kind as people write it, keyed by the engine's kind ("pdf" is
 * "PDF"). A kind not listed shows as the engine sends it.
 */
const WORDS: Record<string, string> = {
  pdf: "PDF",
  youtube: "YouTube",
};

export function kindWord(kind: string): string {
  return WORDS[kind] ?? kind;
}
