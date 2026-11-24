// Word times without a voice: `synthTiming`, `RATE` and the word normaliser it uses.
import type { Project, Word } from "../../schemas/project.ts";

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}%$.]/gu, "").replace(/\.$/, "");

// Word times without a voice: about 2.4 words a second, each word given time by its length, a little more after a
// comma and a sentence, and each hold as a silence after its word. Good enough for scenes to be built and judged; a
// recorded voice replaces it with `--voice`.
export const RATE = 2.4;
export function synthTiming(texts: { text: string; beatId: string }[], holds: { id: string; afterWord: number; seconds: number }[]): Pick<Project, "narration">["narration"] & {} {
  const weight = (w: string) => 0.55 + 0.08 * norm(w).length;
  const after = (w: string) => (/[.!?]["')\]]*$/.test(w) ? 0.32 : /[,;:]["')\]]*$/.test(w) ? 0.16 : 0.03);
  const total = texts.reduce((s, w) => s + weight(w.text), 0);
  const pauses = texts.reduce((s, w) => s + after(w.text), 0);
  const scale = (texts.length / RATE - pauses) / total;
  const byWord = new Map<number, typeof holds>();
  for (const h of holds) byWord.set(h.afterWord, [...(byWord.get(h.afterWord) ?? []), h]);
  const words: Word[] = [];
  const timed: { id: string; afterWord: number; start: number; seconds: number }[] = [];
  let t = 0.15;
  texts.forEach((w, i) => {
    const d = weight(w.text) * scale;
    words.push({ text: w.text, start: +t.toFixed(3), end: +(t + d * 0.9).toFixed(3), beatId: w.beatId });
    t += d + after(w.text);
    for (const h of byWord.get(i) ?? []) {
      timed.push({ id: h.id, afterWord: i, start: +(words[i]!.end + 0.05).toFixed(3), seconds: h.seconds });
      t = Math.max(t, words[i]!.end + 0.05 + h.seconds + 0.1);
    }
  });
  const seconds = Math.max(words.at(-1)!.end + 0.4, ...timed.map((h) => h.start + h.seconds + 0.2));
  return { audio: "", voiceId: "", model: "synthetic", seconds: +seconds.toFixed(3), words, holds: timed };
}
