/**
 * The voice that speaks a video's narration. A voice takes the scenes' narration and gives back, per scene, an audio
 * file (or none) and the time of every word in seconds from the scene's start. Four ship here: ElevenLabs
 * (`eleven.ts`), whose word times are real, which a person has by giving a key; `silent`, the estimator alone with no
 * audio, which is what a video gets without a key, its captions carrying the words; and macOS `say`, a robotic voice
 * that only a person's own quick test turns on (`SCENES_VOICE=say`) and nothing chooses by itself. `say` has no word
 * times of its own, so each sentence is spoken and measured and its words share that time by the estimator's
 * weights. Kokoro (`kokoro.ts`) is a voice that runs on this computer with no key, once a person installs it and turns
 * it on (`SCENES_VOICE=kokoro`); it is timed the same way as `say`. Speechify (`speechify.ts`), a hosted voice with a
 * free monthly allowance, gives real word times like ElevenLabs, with its own key. `voices.ts` is the one list of them
 * that everything else reads.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { synthTiming } from "../pipeline/lib/synth-timing.ts";
import { wordsOf } from "./script.ts";
import { chooseVoice, installedFacts, type VoiceFacts } from "./voice-choice.ts";
import { voiceService } from "./voices.ts";
import type { SceneTiming, Word } from "./scene.ts";

const run = promisify(execFile);

export interface Segment {
  id: string;
  text: string;
  /** The narration around it, for a voice that reads with context (not spoken). */
  previous?: string;
  next?: string;
}

export interface Spoken extends SceneTiming {
  id: string;
  /** A WAV file of this scene's voice, or undefined for a silent voice. */
  audio?: string;
}

export interface Voice {
  readonly id: string;
  readonly label: string;
  /** Whether it makes sound. */
  readonly real: boolean;
  /** What a person should know about it, in a line with what to do (no key, so no sound); absent for the voice they want. */
  readonly note?: string;
  /**
   * Fast and free enough to speak every script change while the agent writes, so scenes are built on the real word
   * times from the start. A slow or paid voice says false: scenes are written on estimates and built again at the end.
   */
  readonly quick: boolean;
  /** What the voice sounds like for this style: word times from another sound are spoken again. */
  sound(style: string): string;
  /** Throws `VoiceDown` when the voice cannot speak for a reason trying again will not fix. */
  speak(segments: Segment[], folder: string, signal?: AbortSignal, style?: string): Promise<Spoken[]>;
  /**
   * Whether the voice can speak now, as cheaply as it can tell without speaking (nothing paid for). Absent for a voice
   * that cannot go away. Unsure answers `ok`: speaking is then the check.
   */
  check?(signal?: AbortSignal): Promise<VoiceHealth>;
}

/** The voice, or what gives the voice of the moment (the voice set up in the app can change while the service runs). */
export type VoiceSource = Voice | (() => Voice);

/** The voice to use now. */
export function voiceNow(source: VoiceSource): Voice {
  return typeof source === "function" ? source() : source;
}

/** Why a voice cannot speak, when trying again will not help: no credits left, its key or account refused, or no answer. */
export type VoiceTrouble = "credits" | "refused" | "unreachable";

export type VoiceHealth = { ok: true } | { ok: false; trouble: VoiceTrouble; message: string };

/**
 * The voice cannot speak, for a reason trying again will not fix: the account is out of credits, the key or the
 * account was refused, or the voice service did not answer through every attempt. The message says it in a sentence.
 */
export class VoiceDown extends Error {
  readonly trouble: VoiceTrouble;
  constructor(message: string, trouble: VoiceTrouble) {
    super(message);
    this.name = "VoiceDown";
    this.trouble = trouble;
  }
}

/** The `VoiceDown` in what was thrown, if it is one. */
export function voiceDownOf(error: unknown): VoiceDown | undefined {
  return error instanceof VoiceDown ? error : undefined;
}

/** Time before a scene's first word, and after its last, so scenes do not run into each other. */
export const LEAD = 0.25;
export const TAIL = 0.45;

/** Estimated word times for a scene: the engine's estimator, about 2.4 words a second (146 words a minute: inside what a real voice does, measured at 135 for ElevenLabs). */
export function estimate(text: string): SceneTiming {
  const narration = synthTiming(wordsOf(text).map((w) => ({ text: w, beatId: "s" })), []);
  const words = narration.words.map((w) => ({ text: w.text, start: +(w.start + LEAD - 0.15).toFixed(3), end: +(w.end + LEAD - 0.15).toFixed(3) }));
  return { seconds: +(words.at(-1)!.end + TAIL).toFixed(3), words };
}

export function silentVoice(note?: string): Voice {
  return {
    id: "silent",
    label: "No voice (made without sound)",
    ...(note ? { note } : {}),
    real: false,
    quick: true,
    sound: () => "silent",
    async speak(segments) {
      return segments.map((s) => ({ id: s.id, ...estimate(s.text) }));
    },
  };
}

/** Sentences of a narration, each with its words, in order. */
export function sentences(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const w of wordsOf(text)) {
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Spreads a measured stretch of speech over its words by the estimator's weights (longer words take longer). */
export function spread(words: string[], start: number, seconds: number): Word[] {
  const t = synthTiming(words.map((w) => ({ text: w, beatId: "s" })), []);
  const first = t.words[0]!.start;
  const last = t.words.at(-1)!.end;
  const scale = seconds / Math.max(0.01, last - first);
  return t.words.map((w) => ({ text: w.text, start: +(start + (w.start - first) * scale).toFixed(3), end: +(start + (w.end - first) * scale).toFixed(3) }));
}

async function seconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(stdout.trim());
}

/** The speech in a file, without the silence `say` leaves at its start and end: where it starts and how long it is. */
async function speech(file: string): Promise<{ start: number; seconds: number }> {
  const total = await seconds(file);
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.08", "-f", "null", "-"]);
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const lead = starts[0] !== undefined && starts[0] < 0.02 && ends[0] !== undefined ? ends[0] : 0;
  const lastStart = starts.at(-1);
  const tailFrom = lastStart !== undefined && lastStart > lead && (ends.length < starts.length || (ends.at(-1) ?? 0) >= total - 0.02) ? lastStart : total;
  return { start: lead, seconds: Math.max(0.1, tailFrom - lead) };
}

/** A sentence spoken to its own file, with its words. */
export interface SpokenSentence {
  file: string;
  words: string[];
}

/**
 * One scene from its sentences, each already spoken to its own file: each sentence's speech is measured and cut from
 * the quiet around it, and the scene's WAV is LEAD of silence, the sentences with a short breath between them, then
 * TAIL. A sentence's words share its measured time by the estimator's weights. Used by every voice with no word times
 * of its own.
 */
export async function joinSentences(id: string, spoken: SpokenSentence[], folder: string, signal?: AbortSignal): Promise<Spoken> {
  const breath = 0.18;
  const parts: (SpokenSentence & { start: number; seconds: number })[] = [];
  for (const p of spoken) parts.push({ ...p, ...(await speech(p.file)) });
  const wav = join(folder, `${id}.wav`);
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const chain = parts.map((p, i) => `[${i}:a]atrim=start=${p.start.toFixed(3)}:duration=${p.seconds.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=pad_dur=${i < parts.length - 1 ? breath : 0}[p${i}]`);
  const filter = `${chain.join(";")};${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[speech];[speech]adelay=${Math.round(LEAD * 1000)},apad=pad_dur=${TAIL}[out]`;
  await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-ac", "1", wav], { signal });
  const words: Word[] = [];
  let t = LEAD;
  for (const p of parts) {
    words.push(...spread(p.words, t, p.seconds));
    t += p.seconds + breath;
  }
  return { id, audio: wav, words, seconds: +(await seconds(wav)).toFixed(3) };
}

/** macOS `say`. Each sentence is spoken to its own file, and the scene is joined from them (`joinSentences`). */
export function sayVoice(o: { bin?: string; voice?: string; rate?: number; note?: string } = {}): Voice {
  const bin = o.bin ?? "say";
  return {
    id: "say",
    label: `This computer's voice${o.voice ? ` (${o.voice})` : ""}, robotic`,
    ...(o.note ? { note: o.note } : {}),
    real: true,
    quick: true,
    sound: () => `say:${o.voice ?? ""}:${o.rate ?? ""}`,
    async speak(segments, folder, signal) {
      mkdirSync(folder, { recursive: true });
      const out: Spoken[] = [];
      for (const seg of segments) {
        const parts: SpokenSentence[] = [];
        for (const [k, words] of sentences(seg.text).entries()) {
          const file = join(folder, `${seg.id}-${k}.aiff`);
          await run(bin, [...(o.voice ? ["-v", o.voice] : []), ...(o.rate ? ["-r", String(o.rate)] : []), "-o", file, words.join(" ")], { signal });
          parts.push({ file, words });
        }
        out.push(await joinSentences(seg.id, parts, folder, signal));
      }
      return out;
    },
  };
}

/**
 * The voice for these settings (`voice-choice.ts` decides, from the voice services' list in `voices.ts`): a named
 * service, else the first hosted one whose key is set, else no sound, on every system. `cacheDir` keeps what was
 * spoken so the same words are never paid for, or spoken, twice. `has` says what is installed here (each local
 * service's own check by default).
 */
export function voiceFromEnv(env: Record<string, string | undefined> = process.env, cacheDir?: string, has: VoiceFacts = installedFacts()): Voice {
  const choice = chooseVoice(env, has);
  const service = voiceService(choice.kind);
  if (!service || choice.kind === "silent") return silentVoice(choice.note);
  const voice = service.build(env, { ...(cacheDir ? { cacheDir } : {}) });
  return choice.note ? { ...voice, note: choice.note } : voice;
}
