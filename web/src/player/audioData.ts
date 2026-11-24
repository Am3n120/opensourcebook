import type { Json, JsonObject } from "../api/types";
import type { Cite } from "./blockData";

/** One spoken word and when it is said in the file (engine/docs/audio.md, "Part"). */
export interface AudioWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** A run of words ending with . ! or ?, for the player: where it starts and which words it holds (`from` up to, not including, `to`). */
export interface AudioSentence {
  startMs: number;
  from: number;
  to: number;
}

export interface AudioPart {
  id: string;
  title: string;
  text: string;
  /** The maker's own explanation, not the sources: never cited. */
  background: boolean;
  cites: Cite[];
  startMs: number;
  endMs: number;
  words: AudioWord[];
  sentences: AudioSentence[];
}

export interface AudioFile {
  url: string;
  durationMs: number;
}

export interface Audio {
  title: string;
  about: string;
  lengthNote: string;
  parts: AudioPart[];
  file?: AudioFile;
}

const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const isObj = (v: Json | undefined): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const num = (v: Json | undefined): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** An audio payload read defensively; it never throws. A part without words gets its text's words spread over its span. */
export function asAudio(payload: JsonObject | undefined): Audio {
  const p = isObj(payload) ? payload : {};
  const parts: AudioPart[] = arr(p.parts)
    .filter(isObj)
    .map((x, i) => {
      const text = str(x.text);
      const startMs = num(x.startMs);
      const endMs = Math.max(startMs, num(x.endMs));
      let words: AudioWord[] = arr(x.words)
        .filter(isObj)
        .filter((w) => typeof w.text === "string" && w.text !== "")
        .map((w) => ({ text: str(w.text), startMs: num(w.startMs), endMs: Math.max(num(w.startMs), num(w.endMs)) }));
      if (words.length === 0) words = spread(text, startMs, endMs);
      const background = x.background === true;
      return {
        id: str(x.id) || `p${i + 1}`,
        title: str(x.title),
        text: text || words.map((w) => w.text).join(" "),
        background,
        // A background part is never cited, whatever the payload says.
        cites: background ? [] : (arr(x.cites).filter(isObj).filter((c) => typeof c.sourceId === "string") as unknown as Cite[]),
        startMs,
        endMs,
        words,
        sentences: sentencesOf(words),
      };
    });
  const f = isObj(p.file) ? p.file : undefined;
  const file = f && typeof f.url === "string" && f.url ? { url: f.url, durationMs: num(f.durationMs) } : undefined;
  return { title: str(p.title), about: str(p.about), lengthNote: str(p.lengthNote), parts, ...(file ? { file } : {}) };
}

// Closing quotes and brackets that may follow a sentence's last mark.
const CLOSERS = /["'”’»)\]}]+$/;

/** The sentences in some words: each ends with a word whose last character, before closing quotes or brackets, is . ! or ?; the last run ends one even without. */
export function sentencesOf(words: readonly AudioWord[]): AudioSentence[] {
  const out: AudioSentence[] = [];
  let from = 0;
  words.forEach((w, i) => {
    if (/[.!?]$/.test(w.text.replace(CLOSERS, "")) || i === words.length - 1) {
      out.push({ startMs: words[from]!.startMs, from, to: i + 1 });
      from = i + 1;
    }
  });
  return out;
}

/** Words for a part that came without times: its text split on spaces, spread evenly over the part, so a tap still lands near the spot. */
function spread(text: string, startMs: number, endMs: number): AudioWord[] {
  const bits = text.split(/\s+/).filter(Boolean);
  const each = bits.length ? (endMs - startMs) / bits.length : 0;
  return bits.map((t, i) => ({ text: t, startMs: Math.round(startMs + i * each), endMs: Math.round(startMs + (i + 1) * each) }));
}

/** The index into `flat` of the word said at `ms`: the last one started, unless more than a second has passed since it ended; -1 for none. */
export function wordAt(flat: ReadonlyArray<{ startMs: number; endMs: number }>, ms: number): number {
  let lo = 0;
  let hi = flat.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && ms <= flat[found]!.endMs + 1000 ? found : -1;
}

/** Seconds as m:ss, or h:mm:ss past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
