/**
 * An Open Sourcebook video as one timeline: each scene of the script is an engine clip of its own, back to back on the voice's
 * clock, then a short end card naming the sources; caption pages come from every word's real time (the pipeline's
 * `captions`), lighting the key words the agent picked for each scene, and the audio is the scenes' voice joined in
 * order, mixed with its sound in `sound.ts`.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Scene, Theme } from "../engine/core/types.ts";
import type { Clip, Project, Timeline } from "../schemas/project.ts";
import { captions } from "../pipeline/stages/timeline.ts";
import { styleFile } from "./styles.ts";
import { cardSeconds } from "../video/end-card.ts";
import type { Spoken } from "./voice.ts";

const run = promisify(execFile);
const FPS = 30;

/** A source on the end card: its name, and how many quotes the video took from it. */
export interface CardSource {
  title: string;
  quotes: number;
}

/** Each source once, its quotes added up. */
function merged(sources: CardSource[]): CardSource[] {
  const by = new Map<string, CardSource>();
  for (const s of sources) {
    const was = by.get(s.title);
    if (was) was.quotes += s.quotes;
    else by.set(s.title, { ...s });
  }
  return [...by.values()];
}

export interface Placed {
  id: string;
  scene: Scene;
  theme: Theme;
  spoken: Spoken;
  /** The scene's caption key words, lit in the accent color as they are said. */
  emphasis?: string[];
}

/**
 * Words on a caption page when the style sets none and the video has no sound: the captions are then the only way to
 * follow it, so a page stays long enough to read (viewers read about three words a second and the pace is about two
 * and a half), not the three that flicker under a voice.
 */
export const SILENT_CAPTION_WORDS = 5;

export interface Laid {
  timeline: Timeline;
  /** Where each scene is in the video, in milliseconds. */
  spans: { id: string; startMs: number; endMs: number }[];
  /** Where each scene's voice starts, in seconds of the video. */
  offsets: number[];
}

export function layOut(placed: Placed[], style: string, frame: { width: number; height: number }, sources: CardSource[], images: string[] = [], title?: string, silent = false): Laid {
  const clips: Clip[] = [];
  const spans: Laid["spans"] = [];
  const offsets: number[] = [];
  const words: NonNullable<Project["narration"]>["words"] = [];
  const holds: NonNullable<NonNullable<Project["narration"]>["holds"]> = [];
  let from = 0;
  for (const p of placed) {
    offsets.push(from / FPS);
    clips.push({ shotId: p.id, type: "engine", from, frames: p.scene.frames, scene: p.scene, theme: p.theme });
    spans.push({ id: p.id, startMs: Math.round((from / FPS) * 1000), endMs: Math.round(((from + p.scene.frames) / FPS) * 1000) });
    // A pause in the voice is a hold on the video's clock: no caption page runs across it.
    for (const h of p.spoken.holds ?? []) holds.push({ id: `${p.id}.${h.id}`, afterWord: words.length + h.afterWord, start: from / FPS + h.start, seconds: h.seconds });
    for (const w of p.spoken.words) words.push({ text: w.text, start: from / FPS + w.start, end: from / FPS + w.end, beatId: p.id });
    from += p.scene.frames;
  }
  const story = from;
  const theme = placed.at(-1)?.theme ?? placed[0]!.theme;
  // The end card stays as long as its words take to read (video/end-card.ts). The idea is not on it: the video has
  // said it, and a paragraph left on screen with no voice read to viewers as a wall of small words.
  const credits = sources.length ? { sources: merged(sources), images: [...new Set(images)], ...(title ? { title } : {}) } : undefined;
  const cardFrames = credits ? Math.round(cardSeconds(credits) * FPS) : 0;
  if (credits) clips.push({ shotId: "credits", type: "credits", from, frames: cardFrames, credits, theme });
  const file = styleFile(style);
  // A style file may ask for a grain and a paper texture laid over the video; the pictures for them are not made
  // here, so the overlay is off and the scene's own surface shows as the engine draws it.
  const { surface: _surface, ...rest } = file;
  const p = { narration: { audio: "", voiceId: "", model: "", seconds: story / FPS, words, holds }, script: { title: "", takeaway: "", beats: placed.map((x) => ({ id: x.id, role: "explain" as const, text: "", claimIds: [], visual: "", emphasis: x.emphasis ?? [] })) } } as unknown as Project;
  const timeline: Timeline = {
    fps: FPS,
    width: frame.width,
    height: frame.height,
    frames: story + cardFrames,
    audio: "",
    style: { ...rest, grain: 0 },
    clips,
    captions: captions(p, [], theme.style?.caption?.words ?? (silent ? SILENT_CAPTION_WORDS : undefined)),
  };
  return { timeline, spans, offsets };
}

/**
 * The scenes' voice files placed at their scene's start, as one WAV in the video's folder, for the mix to level with
 * the music and effects. Undefined when the voice made no audio.
 */
export async function joinVoice(laid: Laid, spoken: Spoken[], folder: string, signal?: AbortSignal): Promise<string | undefined> {
  const files = spoken.map((s) => s.audio);
  if (!files.every(Boolean)) return undefined;
  const seconds = laid.timeline.frames / laid.timeline.fps;
  const inputs = files.flatMap((f) => ["-i", f!]);
  const placed = files.map((_, i) => `[${i}:a]adelay=${Math.round(laid.offsets[i]! * 1000)}:all=1[a${i}]`);
  const filter = `${placed.join(";")};${files.map((_, i) => `[a${i}]`).join("")}amix=inputs=${files.length}:normalize=0:duration=longest,apad=whole_dur=${seconds.toFixed(3)},atrim=0:${seconds.toFixed(3)}[out]`;
  const name = "voice.wav";
  await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-ac", "2", join(folder, name)], { signal });
  return name;
}
