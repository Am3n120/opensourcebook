/**
 * The audio payload (engine/docs/audio.md is the contract): a spoken
 * walk-through in parts, each what one voice says with the passages it draws
 * on, or background said aloud as the maker's own; and the voiced file with a
 * time for every word.
 */
import type { SourceLocator } from "../../studio/types";

export const AUDIO_SCHEMA_VERSION = 1;

export const AUDIO_LIMITS = {
  title: 200,
  about: 400,
  partTitle: 80,
  /** What one part may say: the scenes service takes up to this many characters a part. */
  partText: 2_500,
  parts: 60,
  cites: 6,
  quote: 300,
  lengthNote: 300,
  /** The longest an audio may be asked to run. */
  maxMinutes: 60,
} as const;

/**
 * Words a minute a listener hears, for telling a writer how long its words
 * will run before they are voiced: the voice measured about 135 to 146 a
 * minute on narration. Only ever said as "about".
 */
export const SPOKEN_WORDS_PER_MINUTE = 140;

export interface AudioCite {
  sourceId: string;
  chunkId?: string;
  locator?: SourceLocator;
  quote: string;
}

export interface AudioWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface AudioPart {
  id: string;
  title: string;
  text: string;
  background: boolean;
  cites: AudioCite[];
  /** Set once voiced. */
  startMs?: number;
  endMs?: number;
  words?: AudioWord[];
}

export interface AudioFile {
  assetId: string;
  url: string;
  contentType: string;
  bytes: number;
  durationMs: number;
  voice: { id: string; label: string };
  loudness?: { lufs: number; truePeak: number };
  madeAt: string;
  by: { maker: string; agent?: string; model?: string };
}

export interface AudioPayload {
  schemaVersion: number;
  title: string;
  about: string;
  parts: AudioPart[];
  lengthNote?: string;
  /** Absent only before it is voiced (between the writing and the voicing of one job). */
  file?: AudioFile;
}

/** A part's words as the voice says them: split on spaces, punctuation kept on its word. */
export function spokenWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** About how long words take to say, in seconds. */
export function spokenSeconds(text: string): number {
  return (spokenWords(text).length / SPOKEN_WORDS_PER_MINUTE) * 60;
}

/** 0:42, 6:05, 1:02:09. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "about 6 min", "about 45 s", "1 h 10 min". */
export function minutesWords(minutes: number): string {
  if (minutes < 1) return `${Math.max(5, Math.round((minutes * 60) / 5) * 5)} s`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return hours > 0 ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${Math.round(minutes)} min`;
}
