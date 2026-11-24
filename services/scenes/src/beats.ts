/**
 * Speaking the beats of a video as the agent writes them. A beat is one scene: its words and its picture, written
 * together. Its narration may carry pauses where the voice waits for the picture; the voice speaks the words, and the
 * pauses are put into its time and its audio afterwards, so every word after a pause starts that much later and the
 * scene language reaches each pause as a hold (`@h1`, `@h1.end`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Hold, SceneTiming } from "./scene.ts";
import { withPauses, type Pause, type Script } from "./script.ts";
import type { Segment, Spoken, Voice } from "./voice.ts";
import { estimate } from "./voice.ts";

const run = promisify(execFile);

/** What a beat's voice is keyed by: its words with their pauses, so a changed pause is spoken again. */
export const spokenAs = (scene: Script["scenes"][number]) => withPauses(scene);

/** The scenes to speak, each with the narration around it for a voice that reads with context. */
export function segmentsOf(script: Script, ids: string[]): Segment[] {
  return ids.map((id) => {
    const i = script.scenes.findIndex((s) => s.id === id);
    const previous = script.scenes[i - 1]?.narration;
    const next = script.scenes[i + 1]?.narration;
    return { id, text: script.scenes[i]!.narration, ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
  });
}

/** Word times with the pauses in them: each silence starts as its word ends, and what follows moves on by its length. */
export function paused(timing: SceneTiming, pauses: Pause[]): SceneTiming {
  if (!pauses.length) return timing;
  const sorted = [...pauses].filter((p) => timing.words[p.afterWord]).sort((a, b) => a.afterWord - b.afterWord);
  const words = timing.words.map((w) => ({ ...w }));
  const holds: Hold[] = [];
  for (const [k, p] of sorted.entries()) {
    holds.push({ id: `h${k + 1}`, afterWord: p.afterWord, start: words[p.afterWord]!.end, seconds: p.seconds });
    for (const w of words.slice(p.afterWord + 1)) {
      w.start += p.seconds;
      w.end += p.seconds;
    }
  }
  return { seconds: timing.seconds + sorted.reduce((s, p) => s + p.seconds, 0), words, holds };
}

/** The voice's file with silence put in at each hold, as a new WAV beside it. */
export async function pausedAudio(audio: string, holds: Hold[], signal?: AbortSignal): Promise<string> {
  if (!holds.length) return audio;
  const out = audio.replace(/(\.\w+)?$/, "-paused.wav");
  // Where each hold starts on the voice's own clock, before the holds ahead of it were added.
  let added = 0;
  const cuts = holds.map((h) => {
    const at = h.start - added;
    added += h.seconds;
    return { at, seconds: h.seconds };
  });
  const n = cuts.length + 1;
  const graph = [`[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=${n}${Array.from({ length: n }, (_, i) => `[a${i}]`).join("")}`];
  const order: string[] = [];
  let from = 0;
  for (const [i, c] of cuts.entries()) {
    graph.push(`[a${i}]atrim=${from.toFixed(3)}:${c.at.toFixed(3)},asetpts=PTS-STARTPTS[v${i}]`, `anullsrc=r=48000:cl=stereo,atrim=0:${c.seconds.toFixed(3)}[s${i}]`);
    order.push(`[v${i}]`, `[s${i}]`);
    from = c.at;
  }
  graph.push(`[a${cuts.length}]atrim=${from.toFixed(3)},asetpts=PTS-STARTPTS[v${cuts.length}]`);
  order.push(`[v${cuts.length}]`);
  graph.push(`${order.join("")}concat=n=${order.length}:v=0:a=1[out]`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", audio, "-filter_complex", graph.join(";"), "-map", "[out]", "-ar", "48000", "-ac", "2", out], { signal });
  return out;
}

export interface Timed {
  narration: string;
  timing: SceneTiming;
  audio?: string;
  estimated: boolean;
  sound?: string;
}

/**
 * Speaks the given beats with the voice when it is quick (else estimates their times), puts their pauses in, and
 * returns their timings keyed by id. `force` speaks with the voice even when it is slow (the final voicing).
 */
export async function speakBeats(script: Script, ids: string[], voice: Voice, o: { folder: string; style: string; force?: boolean; signal?: AbortSignal }): Promise<Record<string, Timed>> {
  const out: Record<string, Timed> = {};
  if (!ids.length) return out;
  const sound = voice.sound(o.style);
  const scenes = ids.map((id) => script.scenes.find((s) => s.id === id)!);
  if (voice.quick || o.force) {
    const spoken: Spoken[] = await voice.speak(segmentsOf(script, ids), join(o.folder, "voice"), o.signal, o.style);
    for (const [i, s] of scenes.entries()) {
      const timing = paused({ seconds: spoken[i]!.seconds, words: spoken[i]!.words }, s.pauses ?? []);
      const audio = spoken[i]!.audio && existsSync(spoken[i]!.audio!) ? await pausedAudio(spoken[i]!.audio!, timing.holds ?? [], o.signal) : spoken[i]!.audio;
      out[s.id] = { narration: spokenAs(s), timing, ...(audio ? { audio } : {}), estimated: false, sound };
    }
  } else {
    for (const s of scenes) out[s.id] = { narration: spokenAs(s), timing: paused(estimate(s.narration), s.pauses ?? []), estimated: true };
  }
  return out;
}
