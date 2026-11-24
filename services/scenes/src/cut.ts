/**
 * The real video, made while the agent works: the voice for every beat, every scene built on its real word times, the
 * sound mixed under it, and the mp4 rendered, exactly as the person will get it. The agent asks for one with `render`
 * and sees it with `watch`, as frames of the file with what the voice says at each. A cut remembers what it was made
 * from, so the job can tell whether the last one is the video as it stands and give the person that one.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { finalBuild, renderVideo } from "./produce.ts";
import { voiceAll } from "./produce.ts";
import { styleOf, type ToolContext } from "./tools.ts";
import { piecesIn } from "./making.ts";
import { sampleScenes } from "./report.ts";
import { shelf } from "./shelf.ts";

const run = promisify(execFile);

export interface Cut {
  /** What the video was made from, as a hash: the same video as it stands has the same key. */
  key: string;
  /** The mp4, relative to the job's folder. */
  file: string;
  bytes: number;
  durationMs: number;
  /** Where each beat is in the video, in milliseconds. */
  spans: { id: string; startMs: number; endMs: number }[];
  /** Every spoken word, with its beat and its time in seconds of the video. */
  words: { text: string; start: number; end: number; beat: string }[];
  /** The pauses, in seconds of the video. */
  holds: { beat: string; id: string; start: number; seconds: number }[];
  voice: { id: string; label: string; real: boolean; note?: string };
  sound?: { music: string[]; effects: string[]; lufs: number; truePeak: number };
  /** The scenes as sampled for the viewer report, relative to the job's folder; missing when sampling failed. */
  facts?: string;
  /** How many cuts this job has made, this one included. */
  number: number;
  renderMs: number;
  at: string;
}

/** What makes the video as it stands: style, script, every scene's source, the voice's times, the sound, the pictures. */
export function cutKey(ctx: ToolContext): string {
  const d = ctx.draft;
  const scenes = (d.script?.scenes ?? []).map((s) => ({ s, source: d.scenes[s.id]?.source ?? "", t: d.timings[s.id] ? { n: d.timings[s.id]!.narration, e: d.timings[s.id]!.estimated, a: d.timings[s.id]!.audio ?? "", v: d.timings[s.id]!.sound ?? "" } : undefined }));
  const what = { style: styleOf(ctx), title: d.script?.title, scenes, sound: d.sound ?? null, pictures: d.pictures?.assets ?? {}, voice: ctx.voice.id, frame: ctx.request.frame };
  return createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 24);
}

/** The last cut, when it is of the video as it stands and still on disk. */
export function currentCut(ctx: ToolContext): Cut | undefined {
  const cut = ctx.draft.cut;
  return cut && cut.key === cutKey(ctx) ? cut : undefined;
}

export type CutResult = { cut: Cut } | { broken: Record<string, string[]> };

/**
 * Voices what needs it, builds every scene on its real times, and renders the video. Scenes that no longer build on
 * the real times come back with their problems, and no video is made.
 */
export async function makeCut(ctx: ToolContext, onProgress: (p: number) => void = () => undefined): Promise<CutResult> {
  const spoken = await voiceAll(ctx);
  // The key is taken once the voice is in, from what this cut is made of; a change while it renders makes it stale.
  const key = cutKey(ctx);
  const { placed, broken } = await finalBuild(ctx, spoken);
  if (Object.keys(broken).length) return { broken };
  const out = await renderVideo(ctx, placed, spoken, onProgress);
  const words: Cut["words"] = [];
  const holds: Cut["holds"] = [];
  placed.forEach((p, i) => {
    const offset = out.laid.offsets[i]!;
    for (const w of p.spoken.words) words.push({ text: w.text, start: offset + w.start, end: offset + w.end, beat: p.id });
    for (const h of p.spoken.holds ?? []) holds.push({ beat: p.id, id: h.id, start: offset + h.start, seconds: h.seconds });
  });
  // What every scene shows over the video, sampled while the built scenes are at hand, for the viewer report.
  let facts: string | undefined;
  try {
    const shelfNames = shelf().map((p) => p.name);
    const pieces = Object.fromEntries(placed.map((p) => [p.id, piecesIn([ctx.draft.scenes[p.id]?.source ?? ""], shelfNames)]));
    writeFileSync(join(ctx.folder, "report-facts.json"), JSON.stringify({ ...sampleScenes(placed.map((p, i) => ({ id: p.id, scene: p.scene, offset: out.laid.offsets[i]! }))), pieces }));
    facts = "report-facts.json";
  } catch {
    facts = undefined;
  }
  const cut: Cut = {
    key,
    file: "video.mp4",
    bytes: out.bytes,
    durationMs: out.durationMs,
    spans: out.laid.spans,
    words,
    holds,
    voice: { id: ctx.voice.id, label: ctx.voice.label, real: ctx.voice.real, ...(ctx.voice.note ? { note: ctx.voice.note } : {}) },
    ...(out.sound ? { sound: out.sound } : {}),
    ...(facts ? { facts } : {}),
    number: (ctx.draft.cut?.number ?? 0) + 1,
    renderMs: out.renderMs,
    at: new Date().toISOString(),
  };
  ctx.draft.cut = cut;
  ctx.save();
  return { cut };
}

/** Where in the video a moment is: its beat and the seconds into it, and what the voice says then. */
export function momentOf(cut: Cut, t: number): { beat: string; into: number; said: string } {
  const ms = t * 1000;
  const span = cut.spans.find((s) => ms >= s.startMs && ms < s.endMs);
  const hold = cut.holds.find((h) => t >= h.start && t < h.start + h.seconds);
  const said = cut.words.map((w, i) => ({ ...w, i })).filter((w) => w.start <= t + 0.15 && w.end >= t - 0.6);
  const text = hold ? `pause ${hold.beat} @${hold.id}` : said.length ? `"${said.map((w) => w.text).join(" ")}"` : "no words";
  return span ? { beat: span.id, into: (ms - span.startMs) / 1000, said: text } : { beat: "end card", into: (ms - (cut.spans.at(-1)?.endMs ?? 0)) / 1000, said: text };
}

/** Times to see over a stretch of the video: about every `step` seconds, at most `most` frames. */
export function timesOver(from: number, to: number, step: number, most: number): number[] {
  const count = Math.max(2, Math.min(most, Math.round((to - from) / step) + 1));
  return Array.from({ length: count }, (_, i) => Math.round((from + ((to - from) * i) / (count - 1)) * 100) / 100);
}

/** A phone held upright shows the video this many pixels wide (report.ts's VIEWER.phoneWidth, in points). */
export const PHONE_TILE = 360;

/**
 * Frames of the rendered file at the given seconds, tiled into one JPEG in `folder`: by default six a row, each 180
 * pixels wide and as tall as the video's shape makes it; `tile` and `cols` set the size and the row.
 */
export async function sheetOf(video: string, times: number[], frame: { width: number; height: number }, folder: string, look: { tile?: number; cols?: number } = {}): Promise<string> {
  mkdirSync(folder, { recursive: true });
  const tw = look.tile ?? 180;
  const th = Math.round((tw * frame.height) / frame.width / 2) * 2;
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    const file = join(folder, `f${i}.jpg`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", `scale=${tw}:${th}:flags=area`, "-q:v", "4", "-update", "1", file]);
    files.push(file);
  }
  const [cw, ch] = [tw + 6, th + 6];
  const cols = Math.min(look.cols ?? 6, files.length);
  const rows = Math.ceil(files.length / cols);
  const fill = rows * cols - files.length;
  const tiles = files.map((_, i) => `[${i}:v]pad=${cw}:${ch}:3:3:color=gray[t${i}]`);
  const blanks = Array.from({ length: fill }, (_, i) => `color=c=black:s=${cw}x${ch}:d=1[b${i}]`);
  const inputs = [...files.map((_, i) => `[t${i}]`), ...Array.from({ length: fill }, (_, i) => `[b${i}]`)];
  const layout = inputs.map((_, i) => `${(i % cols) * cw}_${Math.floor(i / cols) * ch}`).join("|");
  const out = join(folder, "sheet.jpg");
  const graph = inputs.length === 1 ? `[0:v]pad=${cw}:${ch}:3:3:color=gray[out]` : [...tiles, ...blanks, `${inputs.join("")}xstack=inputs=${inputs.length}:layout=${layout}[out]`].join(";");
  await run("ffmpeg", ["-y", "-v", "error", ...files.flatMap((x) => ["-i", x]), "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "4", out]);
  return out;
}

/**
 * The video at the size a phone shows it: frames of the rendered file at the given seconds, each `PHONE_TILE` pixels
 * wide, two a row and two rows a sheet (so a sheet is shown whole, not scaled down), as many sheets as it takes.
 */
export async function phoneSheets(video: string, times: number[], frame: { width: number; height: number }, folder: string): Promise<string[]> {
  const sheets: string[] = [];
  for (let i = 0; i < times.length; i += 4) sheets.push(await sheetOf(video, times.slice(i, i + 4), frame, join(folder, `phone-${i / 4 + 1}`), { tile: PHONE_TILE, cols: 2 }));
  return sheets;
}
