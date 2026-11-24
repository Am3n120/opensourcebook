/**
 * How fast this computer draws a video in each style, kept on this computer, and what that says about a video.
 *
 * Every render of a video adds what it measured (frames a second in that style and how long it took to start); the
 * newest few are kept per style, in a small file in the data folder. A style that has no render yet is measured once,
 * in the background when the service starts, by drawing a short stretch of a sample scene (`measureStyles`). A speed
 * is tied to the number of frames drawn at once it was measured with, so changing that measures again. Nothing is
 * guessed: a style with no measurement has no estimate, and says nothing about time.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Placed } from "./timeline.ts";
import { layOut } from "./timeline.ts";
import { buildScene, type SceneContext } from "./scene.ts";
import { NARRATION, SAMPLE } from "./preview.ts";
import { estimate } from "./voice.ts";
import { timeSpans } from "../pipeline/stages/render.ts";

export interface Sample {
  /** Frames drawn a second, from the first frame being asked for to the last being drawn. */
  fps: number;
  frames: number;
  /** How many frames were drawn at once. */
  concurrency: number;
  /** Whether a real video gave it (`render`) or the short measure did (`measured`). */
  by: "render" | "measured";
  /** Seconds from asking to the first frame (building the page, starting the browser); absent when not known. */
  setupSeconds?: number;
  at: string;
}

/** How long one whole video took to make here: the agent's writing (its own cuts included), the voice, the build and the last render. */
export interface Made {
  /** Seconds of making, waits for the person or the agent's plan limit left out. */
  seconds: number;
  /** Seconds of the video made. */
  videoSeconds: number;
  /** Which agent, model, and effort made it, when recorded. */
  agent?: string;
  model?: string;
  effort?: string;
  at: string;
}

type Book = { version: 1; styles: Record<string, Sample[]>; made?: Made[] };

const KEEP = 5;
/** A render shorter than this says too little about the speed to keep. */
export const LEAST_FRAMES = 60;

export interface Speed {
  fps: number;
  setupSeconds: number;
  by: Sample["by"];
}

export class SpeedBook {
  private book: Book = { version: 1, styles: {} };
  private readonly file: string | undefined;

  /** `file`: where it is kept; none keeps it in memory only. */
  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        const read = JSON.parse(readFileSync(file, "utf8")) as Book;
        if (read?.version === 1 && read.styles && typeof read.styles === "object") this.book = read;
      } catch {
        // A file that cannot be read is measured again.
      }
    }
  }

  record(style: string, sample: Omit<Sample, "at"> & { at?: string }): void {
    if (!(sample.fps > 0) || !Number.isFinite(sample.fps)) return;
    const list = [...(this.book.styles[style] ?? []), { ...sample, at: sample.at ?? new Date().toISOString() }];
    // The newest measure, and the newest few real renders, which `speed` prefers once there is one.
    this.book.styles[style] = [...list.filter((s) => s.by === "measured").slice(-1), ...list.filter((s) => s.by === "render").slice(-KEEP)];
    this.save();
  }

  /**
   * The speed in a style at this many frames at once: the middle of the last renders, else the short measure. A
   * speed measured at fewer is what a computer that had to draw fewer really does, so the most frames at once not
   * above this count are the ones taken; one measured at more is out of date.
   */
  speed(style: string, concurrency: number): Speed | undefined {
    const fit = (this.book.styles[style] ?? []).filter((s) => s.concurrency <= concurrency);
    const most = Math.max(0, ...fit.map((s) => s.concurrency));
    const list = fit.filter((s) => s.concurrency === most);
    const renders = list.filter((s) => s.by === "render");
    const use = renders.length ? renders : list.slice(-1);
    if (!use.length) return undefined;
    const middle = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor((numbers.length - 1) / 2)]!;
    const setups = use.flatMap((s) => (s.setupSeconds !== undefined ? [s.setupSeconds] : []));
    return { fps: middle(use.map((s) => s.fps)), setupSeconds: setups.length ? middle(setups) : 0, by: use[0]!.by };
  }

  /** Adds one whole video's making time, keeping the newest few per (agent, model, effort). A video too short to say anything is not kept. */
  recordMade(made: Omit<Made, "at"> & { at?: string }): void {
    if (!(made.seconds > 0) || !(made.videoSeconds >= 5) || !Number.isFinite(made.seconds) || !Number.isFinite(made.videoSeconds)) return;
    const clean = (value: string | undefined) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const agent = clean(made.agent);
    const model = clean(made.model);
    const effort = clean(made.effort);
    const entry: Made = {
      seconds: Math.round(made.seconds),
      videoSeconds: Math.round(made.videoSeconds),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      at: made.at ?? new Date().toISOString(),
    };
    const key = (m: Made) => `${m.agent ?? ""}\0${m.model ?? ""}\0${m.effort ?? ""}`;
    const bucketKey = key(entry);
    const prior = this.book.made ?? [];
    const others = prior.filter((m) => key(m) !== bucketKey);
    const same = prior.filter((m) => key(m) === bucketKey);
    this.book.made = [...others, ...same.slice(-(KEEP - 1)), entry];
    this.save();
  }

  /** The newest whole videos made here, oldest first: what an estimate of a whole video is made from. */
  made(): Made[] {
    return [...(this.book.made ?? [])];
  }

  /** Seconds a video of this many frames takes in this style, or undefined when nothing has been measured. */
  seconds(style: string, frames: number, concurrency: number): number | undefined {
    const speed = this.speed(style, concurrency);
    return speed ? frames / speed.fps + speed.setupSeconds : undefined;
  }

  /** What the status says: each measured style's frames a second and its start-up. */
  view(styles: string[], concurrency: number): Record<string, { framesPerSecond: number; setupSeconds: number; measuredBy: Sample["by"] }> {
    const out: Record<string, { framesPerSecond: number; setupSeconds: number; measuredBy: Sample["by"] }> = {};
    for (const id of styles) {
      const speed = this.speed(id, concurrency);
      if (speed) out[id] = { framesPerSecond: Math.round(speed.fps * 10) / 10, setupSeconds: Math.round(speed.setupSeconds), measuredBy: speed.by };
    }
    return out;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.book));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Kept in memory for this run.
    }
  }
}

let current: SpeedBook | undefined;
/** The book this service keeps (main.ts sets it); renders read and add to it. None: nothing is kept or said about time. */
export const speedBook = (): SpeedBook | undefined => current;
export const useSpeedBook = (book: SpeedBook | undefined): void => {
  current = book;
};

/** A length of time as a person says it: "under a minute", "about 4 minutes", "about 2 hours". */
export function howLong(seconds: number): string {
  if (seconds < 50) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return "about a minute";
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 6) / 10;
  return `about ${hours === 1 ? "an hour" : `${hours} hours`}`;
}

const FRAMES = [20, 60];

/**
 * Draws a short stretch of a sample scene in each style that has no speed yet at this many frames at once, and records
 * it. Two stretches of different lengths are timed and the difference taken, so the start of the browser, which every
 * render pays once, does not count against the frames. Returns the styles it measured; one that cannot be drawn is
 * left out and logged. Never throws: a failed measure only leaves a style without an estimate.
 */
export async function measureStyles(book: SpeedBook, styles: string[], o: { folder: string; concurrency: number; log?: (line: string) => void }): Promise<string[]> {
  const todo = styles.filter((id) => !book.speed(id, o.concurrency));
  if (!todo.length) return [];
  const log = o.log ?? (() => undefined);
  try {
    mkdirSync(o.folder, { recursive: true });
    const placed: Placed[] = [];
    const timing = estimate(NARRATION);
    for (const style of todo) {
      const c: SceneContext = { title: "Sample", idea: "", brief: "", style, frame: { width: 1080, height: 1920 }, scene: { id: "s1", narration: NARRATION, onScreenText: [], visual: "A sample", cites: [] }, timing };
      const built = await buildScene(c, SAMPLE, join(o.folder, `.build-${style}`));
      if (!built.scene) throw new Error(`the sample scene does not build in ${style}: ${built.problems.join("; ")}`);
      placed.push({ id: style, scene: built.scene, theme: built.theme, spoken: { id: style, seconds: timing.seconds, words: timing.words } });
    }
    const laid = layOut(placed, todo[0]!, { width: 1080, height: 1920 }, [], [], undefined, true);
    laid.timeline.audio = "";
    // Frames from the middle of each scene, where it is drawing.
    const spans = todo.flatMap((_, i) => {
      const clip = laid.timeline.clips[i]!;
      const from = clip.from + Math.max(0, Math.floor((clip.frames - FRAMES[1]!) / 2));
      return FRAMES.map((n) => ({ from, to: from + n - 1 }));
    });
    const times = await timeSpans(laid.timeline, o.folder, spans, o.log ? { log: o.log } : {});
    const done: string[] = [];
    todo.forEach((style, i) => {
      const [short, long] = [times.seconds[i * 2]!, times.seconds[i * 2 + 1]!];
      const extra = FRAMES[1]! - FRAMES[0]!;
      // The difference of the two is the pace; a difference too small to trust falls back to the longer one alone.
      const fps = long - short > 0.2 ? extra / (long - short) : FRAMES[1]! / long;
      book.record(style, { fps, frames: FRAMES[1]!, concurrency: times.concurrency, by: "measured", setupSeconds: Math.max(0, short - FRAMES[0]! / fps) });
      done.push(style);
      log(`speed: ${style} draws ${fps.toFixed(1)} frames a second here`);
    });
    return done;
  } catch (error) {
    log(`speed: could not measure (${(error as Error).message.split("\n")[0]})`);
    return [];
  }
}
