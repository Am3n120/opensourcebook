/**
 * The sound under the voice: the kit, its placements and the mix. The kit is music beds and short effects made once with ElevenLabs and kept in
 * `audio/kit/src` (`audio/kit.json` says what each is). No model places them from the compiled moments:
 * the agent that wrote the scenes places them with the `sound` tool, on its scenes' word numbers. The mix ducks
 * the music and effects under the voice and masters the whole to -14 LUFS, -1.2 dBTP in a two-pass loudnorm.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ffmpeg } from "./ffmpeg.ts";

const ROOT = join(import.meta.dirname, "..", "audio");

export interface Kit {
  sfx: Record<string, { text: string; seconds: number; gainDb: number }>;
  music: Record<string, { prompt: string; seconds: number }>;
}

export const KIT = JSON.parse(readFileSync(join(ROOT, "kit.json"), "utf8")) as Kit;

/** What the agent chose: beds that change at a scene's word, and effects on a scene's word. Levels in dB. */
export interface SoundPlan {
  music: { scene: string; at: number; name: string; level: number; why: string }[];
  effects: { scene: string; at: number; name: string; level: number; why: string }[];
}

export type Hit = { name: string; at: number; level: number; why: string };
export type Cue = { name: string; at: number; level: number; why: string };

/** Effects sit well under the voice; music levels are offsets from a -26 LUFS bed, -80 is silence, 0 the most. */
export const EFFECT_LEVELS = [-40, -18] as const;
export const MUSIC_LEVELS = [-80, 0] as const;
/** Effects at least this far apart, and never over the one before while it still sounds. */
export const EFFECT_GAP = 1.5;
/** The video's last seconds: the music fades out over the sources card instead of stopping. */
export const FADE_OUT = 2;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * The plan in seconds of the video, given where each scene starts and its words' times. A cue on a scene, word or sound
 * that does not exist is dropped: one bad cue never costs the video its sound. Music always starts at 0 (in silence
 * until the first cue, when that is later).
 */
export function placements(plan: SoundPlan, scenes: { id: string; offset: number; words: { start: number }[] }[], seconds: number): { hits: Hit[]; music: Cue[] } {
  const time = (scene: string, at: number) => {
    const s = scenes.find((x) => x.id === scene);
    if (!s || !Number.isInteger(at) || at < 0 || at >= Math.max(1, s.words.length)) return NaN;
    return s.offset + (at === 0 ? 0 : s.words[at]!.start);
  };
  const hits: Hit[] = [];
  for (const e of plan.effects.map((e) => ({ ...e, t: time(e.scene, e.at) })).filter((e) => Number.isFinite(e.t) && KIT.sfx[e.name] && Number.isFinite(e.level)).sort((a, b) => a.t - b.t)) {
    const last = hits.at(-1);
    if (e.t < 0 || e.t >= seconds || (last && e.t < last.at + Math.max(EFFECT_GAP, KIT.sfx[last.name]!.seconds))) continue;
    hits.push({ name: e.name, at: +e.t.toFixed(3), level: clamp(e.level, EFFECT_LEVELS), why: e.why });
  }
  const music: Cue[] = plan.music
    .map((m) => ({ name: m.name, at: time(m.scene, m.at), level: clamp(m.level, MUSIC_LEVELS), why: m.why, ok: !!KIT.music[m.name] && Number.isFinite(m.level) }))
    .filter((m) => m.ok && Number.isFinite(m.at) && m.at >= 0 && m.at < seconds)
    .sort((a, b) => a.at - b.at)
    .filter((m, i, all) => i === 0 || m.at !== all[i - 1]!.at)
    .map(({ ok: _ok, ...m }) => ({ ...m, at: +m.at.toFixed(3) }));
  if (music.length && music[0]!.at !== 0) music.unshift({ name: music[0]!.name, at: 0, level: -80, why: "silence until the first cue" });
  return { hits, music };
}

/**
 * A kit sound ready to mix, made once from its source into the cache: beds at -26 LUFS, effects peaked at -3 dBFS. It is
 * written beside its place and moved there when whole, so a mix running at the same time never reads half a file.
 */
export async function kitFile(kind: "music" | "sfx", name: string, cacheDir: string, signal?: AbortSignal): Promise<string> {
  const out = join(cacheDir, kind, `${name}.wav`);
  if (existsSync(out)) return out;
  if (!(kind === "music" ? KIT.music[name] : KIT.sfx[name])) throw new Error(`no ${kind} "${name}" in audio/kit.json`);
  const src = join(ROOT, "kit", "src", `${name}.mp3`);
  mkdirSync(dirname(out), { recursive: true });
  const part = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.wav`;
  try {
    if (kind === "music") {
      // Beds sit at -26 LUFS: about 10 dB under the narration before ducking takes them lower during speech.
      await ffmpeg(["-y", "-v", "error", "-i", src, "-af", "loudnorm=I=-26:TP=-2:LRA=11", "-ar", "48000", "-ac", "2", part], { signal });
    } else {
      // Short effects are too short for loudnorm; peak-normalize them to -3 dBFS and set the level at mix time.
      const { stderr } = await ffmpeg(["-i", src, "-af", "volumedetect", "-f", "null", "-"], { signal });
      const max = Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1] ?? 0);
      await ffmpeg(["-y", "-v", "error", "-i", src, "-af", `volume=${(-3 - max).toFixed(2)}dB`, "-ar", "48000", "-ac", "2", part], { signal });
    }
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, out);
  return out;
}

/**
 * The mix graph. Input 0 is the voice; then one input per music cue (looped), then one per effect. Each cue
 * plays until the next with a short crossfade; the beds are ducked under the voice, and so are the effects (more
 * gently). Here the whole also fades out over the last FADE_OUT seconds, so the end card is not cut off in silence.
 */
export function graph(hits: Hit[], cues: Cue[], seconds: number, master: string): string {
  const fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const parts = [`[0:a]${fmt},apad=whole_dur=${seconds},asplit=3[vox][sc][fxsc]`];
  cues.forEach((cue, i) => {
    const end = cues[i + 1]?.at ?? seconds;
    const fade = Math.min(0.25, (end - cue.at) / 2);
    const duration = Math.min(seconds - cue.at, end - cue.at + fade);
    const ms = Math.round(cue.at * 1000);
    parts.push(`[${i + 1}:a]${fmt},atrim=0:${duration},asetpts=PTS-STARTPTS,volume=${cue.level}dB,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade},adelay=${ms}|${ms}[b${i}]`);
  });
  if (cues.length) {
    parts.push(`${cues.map((_, i) => `[b${i}]`).join("")}amix=inputs=${cues.length}:normalize=0[bed]`);
    parts.push("[bed][sc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=500[duck]");
  } else parts.push("[sc]anullsink");
  hits.forEach((h, i) => {
    const ms = Math.round(h.at * 1000);
    parts.push(`[${i + 1 + cues.length}:a]${fmt},atrim=0:${KIT.sfx[h.name]!.seconds},volume=${h.level}dB,adelay=${ms}|${ms}[s${i}]`);
  });
  if (hits.length) {
    parts.push(`${hits.map((_, i) => `[s${i}]`).join("")}amix=inputs=${hits.length}:normalize=0[fx]`);
    parts.push("[fx][fxsc]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=150[quietfx]");
  } else parts.push("[fxsc]anullsink");
  const ins = ["[vox]", ...(cues.length ? ["[duck]"] : []), ...(hits.length ? ["[quietfx]"] : [])];
  const fade = Math.min(FADE_OUT, seconds / 4);
  parts.push(`${ins.join("")}amix=inputs=${ins.length}:normalize=0:duration=longest,atrim=0:${seconds},afade=t=out:st=${(seconds - fade).toFixed(3)}:d=${fade.toFixed(3)},${master}[out]`);
  return parts.join(";");
}

const loudness = (log: string) => JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1)) as Record<string, string>;

/**
 * Mixes the voice (a WAV) with the placed music and effects and masters it to -14 LUFS: measure the mix, then apply
 * with the measured values (linear) for an exact level. Writes `mix.wav` in the folder and returns what it measured.
 * ffmpeg runs without blocking, so the service answers other requests while a long sound is mastered.
 */
export async function mix(o: { voice: string; hits: Hit[]; music: Cue[]; seconds: number; folder: string; kitDir: string; signal?: AbortSignal }): Promise<{ file: string; lufs: number; truePeak: number }> {
  const made = new Map<string, Promise<string>>();
  const kit = (kind: "music" | "sfx", name: string) => {
    if (!made.has(`${kind}/${name}`)) made.set(`${kind}/${name}`, kitFile(kind, name, o.kitDir, o.signal));
    return made.get(`${kind}/${name}`)!;
  };
  const beds = await Promise.all(o.music.map((c) => kit("music", c.name)));
  const effects = await Promise.all(o.hits.map((h) => kit("sfx", h.name)));
  const run = async (args: string[]) => (await ffmpeg(args, o.signal ? { signal: o.signal } : {})).stderr;
  const inputs = ["-i", o.voice, ...beds.flatMap((b) => ["-stream_loop", "-1", "-i", b]), ...effects.flatMap((f) => ["-i", f])];
  const target = "I=-14:TP=-1.2:LRA=11";
  const m = loudness(await run(["-v", "info", ...inputs, "-filter_complex", graph(o.hits, o.music, o.seconds, `loudnorm=${target}:print_format=json`), "-map", "[out]", "-f", "null", "-"]));
  const master = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const file = join(o.folder, "mix.wav");
  await run(["-y", "-v", "error", ...inputs, "-filter_complex", graph(o.hits, o.music, o.seconds, master), "-map", "[out]", "-ar", "48000", "-t", o.seconds.toFixed(3), file]);
  const c = loudness(await run(["-v", "info", "-i", file, "-af", "loudnorm=I=-14:TP=-1.2:print_format=json", "-f", "null", "-"]));
  return { file, lufs: Number(c.input_i), truePeak: Number(c.input_tp) };
}

/** The kit as the agent reads it: each sound's name and what it sounds like. */
export function kitText(): string {
  return [
    "Music beds (loop under the whole video until the next cue):",
    ...Object.entries(KIT.music).map(([name, m]) => `- ${name}: ${m.prompt}`),
    "Effects (short, one at a time):",
    ...Object.entries(KIT.sfx).map(([name, s]) => `- ${name} (${s.seconds} s): ${s.text}`),
  ].join("\n");
}
