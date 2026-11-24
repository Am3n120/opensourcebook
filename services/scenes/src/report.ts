/**
 * The viewer report: what a person watching the finished video on a phone would notice, in plain words, for the agent
 * that made it. It is information, never a gate: nothing here blocks, scores or orders anything, and what to do with it
 * is the agent's call.
 *
 * It reads two things. The scenes' own data, sampled over the whole video when a cut is rendered (`sampleScenes`):
 * where every piece of writing and every drawn thing is, how big, for how long. And the rendered mp4 itself: how much of
 * the picture changes from one moment to the next, and where the sound is silent. With the cut's word times these give
 * facts a viewer would feel, each with when, what and the numbers measured.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Scene } from "../engine/core/types.ts";
import { inventory, type Rect, type Thing } from "../pipeline/lib/look.ts";

const run = promisify(execFile);

/**
 * Every threshold the report uses, in one place, each with where it comes from. None depends on the topic.
 */
export const VIEWER = {
  /** Width of a phone held upright, in points: phones are 360 to 430 points wide (most Android phones 360 to 412, iPhones 375 to 440); measured at the narrowest, where writing is smallest. */
  phoneWidth: 360,
  /** Smallest text a phone uses, in points: Apple's Human Interface Guidelines set 11 pt as the smallest text size. */
  smallestPoints: 11,
  /** Reading speed for words on screen: the BBC's subtitle guidelines put viewers' reading at 160 to 180 words a minute. */
  readWordsPerSecond: 3,
  /** Time to find new words on screen before reading starts. Our setting (a glance and a fixation, about half a second). */
  noticeSeconds: 0.5,
  /** Writing on screen for less than this share of its reading time is reported. Our setting, to leave a margin. */
  briefShare: 0.75,
  /** Writing is readable once it is at least this opaque. Our setting. */
  readOpacity: 0.6,
  /** A layout fault (cut by the edge, on other writing, under a shape) is reported when it lasts this long. Our setting: shorter is a thing passing by. */
  steadySeconds: 0.5,
  /** Share of a piece of writing outside the frame before it counts as cut. Our setting, above the error of the width estimate. */
  cutShare: 0.08,
  /** Share of the smaller piece two pieces of writing must share to count as on top of each other. Our setting. */
  overlapShare: 0.25,
  /** Share of a piece of writing a filled shape in front of it must cover. Our setting. */
  coveredShare: 0.4,
  /** A picture that does not change for this long while the voice speaks is reported. Our setting. */
  stillSeconds: 3,
  /** A pixel counts as changed when its brightness moves this much (of 255): above the video's compression noise. */
  pixelStep: 10,
  /** The picture counts as changing when this share of its pixels changed. Our setting. */
  changedShare: 0.0015,
  /** Frames a second the report reads from the mp4 to see change. */
  motionFps: 5,
  /** A gap between two spoken words this long is reported. Our setting: longer than a breath between sentences. */
  gapSeconds: 1.5,
  /** Sound below this level, for at least `silenceSeconds`, counts as silence. */
  silenceDb: -50,
  silenceSeconds: 1,
  /** Pace: conversational English runs at about 150 words a minute (National Center for Voice and Speech); audiobooks at 150 to 160. */
  fastWordsPerMinute: 190,
  slowWordsPerMinute: 100,
  /** A scene's first frames with nothing on screen for this long read as an empty board. Our setting. */
  emptyOpenSeconds: 0.4,
  /** A thing that first shows this close to the cut is barely seen. Our setting. */
  lateSeconds: 0.6,
  /** Writing that arrives this long after the voice says its words reads as out of step. Our setting. */
  laggingSeconds: 1.5,
  /** Within one second, this many new things or new words to read is a lot to take in at once. Our setting. */
  burstThings: 7,
  burstWords: 14,
  /** A scene where less than this share of the frame is used, for most of it, reads as mostly empty. */
  usedShare: 0.2,
  /** The biggest drawn thing under this share of the frame reads as small on a phone. Our setting. */
  subjectShare: 0.06,
  /** Of a scene's time, the share a frame fact has to hold for to be reported for the scene. */
  mostOf: 0.6,
  /** Where the captions are drawn on a 1920 tall frame (video/Video.tsx): rows 1640 to 1810. */
  captionTop: 1640 / 1920,
  captionBottom: 1810 / 1920,
  /** Samples a second the scenes are read at. */
  sampleFps: 10,
  /** When a video has at least this many beats and more than half run the same shelf piece, the report notes it as a fact. Our setting. */
  samePieceMinBeats: 3,
} as const;

/** One piece of writing on one sample, its lines together. */
export interface TextSeen {
  owner: string;
  text: string;
  box: Rect;
  /** Its smallest line's text size on the frame, in pixels. */
  size: number;
  opacity: number;
  /** Share outside the frame, of its worst line. */
  cut: number;
  /** Share covered by a filled shape painted in front of it, of its worst line. */
  covered: number;
}

/** One sample of the video: the writing, the things on screen (by what owns them) and how much of the frame is used. */
export interface Sample {
  t: number;
  beat: string;
  texts: TextSeen[];
  things: { id: string; box: Rect; words: boolean }[];
  /** Pairs of writing on top of each other, and the share of the smaller. */
  overlaps: [string, string, number][];
  /** Share of the frame above the captions with anything in it. */
  used: number;
}

export interface Facts {
  width: number;
  height: number;
  step: number;
  samples: Sample[];
  /** Shelf pieces run in each beat (beat id -> piece names), recorded at render time when available. */
  pieces?: Record<string, string[]>;
}

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const join = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const round = (r: Rect): Rect => ({ x0: Math.round(r.x0), y0: Math.round(r.y0), x1: Math.round(r.x1), y1: Math.round(r.y1) });
const top = (owner: string) => owner.split(".")[0]!;

/** What one frame of a scene shows, as a sample. */
export function sampleOf(scene: Scene, frame: number, t: number, beat: string): Sample {
  const W = scene.width;
  const H = scene.height;
  const all = inventory(scene, frame).filter((x) => x.opacity > 0.1);
  // A shape over most of the frame is the background, not a thing on it.
  const shown = all.filter((x) => !(x.kind === "shape" && area(x.box) > W * H * 0.8));
  const lines = shown.filter((x) => x.kind === "text");
  const frameBox: Rect = { x0: 0, y0: 0, x1: W, y1: H };
  const coverOf = (l: Thing) => {
    const a = Math.max(1, area(l.box));
    return Math.max(0, ...shown.filter((s) => s.kind === "shape" && s.filled && s.order > l.order).map((s) => area(meet(s.box, l.box)) / a));
  };
  const texts = new Map<string, TextSeen>();
  for (const l of lines) {
    const a = Math.max(1, area(l.box));
    const cut = 1 - area(meet(l.box, frameBox)) / a;
    const was = texts.get(l.owner);
    const size = l.size ?? 60;
    if (was) Object.assign(was, { text: `${was.text} ${l.text ?? ""}`.trim(), box: join(was.box, l.box), size: Math.min(was.size, size), opacity: Math.max(was.opacity, l.opacity), cut: Math.max(was.cut, cut), covered: Math.max(was.covered, coverOf(l)) });
    else texts.set(l.owner, { owner: l.owner, text: l.text ?? "", box: l.box, size, opacity: l.opacity, cut, covered: coverOf(l) });
  }
  const overlaps: [string, string, number][] = [];
  const readable = lines.filter((l) => l.opacity >= VIEWER.readOpacity);
  for (let i = 0; i < readable.length; i++) {
    for (let j = i + 1; j < readable.length; j++) {
      const [a, b] = [readable[i]!, readable[j]!];
      if (a.owner === b.owner) continue;
      const share = area(meet(a.box, b.box)) / Math.max(1, Math.min(area(a.box), area(b.box)));
      if (share > VIEWER.overlapShare) overlaps.push([a.owner, b.owner, Math.round(share * 100) / 100]);
    }
  }
  const owners = new Map<string, { id: string; box: Rect; words: boolean }>();
  for (const x of shown.filter((s) => s.opacity >= 0.5)) {
    const id = top(x.owner);
    const o = owners.get(id);
    owners.set(id, o ? { id, box: join(o.box, x.box), words: o.words && x.kind === "text" } : { id, box: x.box, words: x.kind === "text" });
  }
  // The share of the frame above the captions with anything in it, on a coarse grid (as the build's layout check reads it).
  const [y0, y1] = [H * 0.047, H * 0.812];
  const [cols, rows] = [9, 16];
  let used = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell: Rect = { x0: (c * W) / cols, x1: ((c + 1) * W) / cols, y0: y0 + (r * (y1 - y0)) / rows, y1: y0 + ((r + 1) * (y1 - y0)) / rows };
      if (shown.some((x) => x.opacity >= 0.15 && area(meet(x.box, cell)) > area(cell) * 0.15)) used++;
    }
  }
  return {
    t: Math.round(t * 1000) / 1000,
    beat,
    texts: [...texts.values()].map((x) => ({ ...x, box: round(x.box), size: Math.round(x.size * 10) / 10, opacity: Math.round(x.opacity * 100) / 100, cut: Math.round(x.cut * 100) / 100, covered: Math.round(x.covered * 100) / 100 })),
    things: [...owners.values()].map((o) => ({ ...o, box: round(o.box) })),
    overlaps,
    used: Math.round((used / (rows * cols)) * 100) / 100,
  };
}

/** The scenes of a cut, each at its offset in the video (seconds), sampled `VIEWER.sampleFps` times a second. */
export function sampleScenes(scenes: { id: string; scene: Scene; offset: number }[]): Facts {
  const first = scenes[0]?.scene;
  const samples: Sample[] = [];
  for (const { id, scene, offset } of scenes) {
    const every = Math.max(1, Math.round(scene.fps / VIEWER.sampleFps));
    for (let f = 0; f < scene.frames; f += every) samples.push(sampleOf(scene, f, offset + f / scene.fps, id));
  }
  return { width: first?.width ?? 1080, height: first?.height ?? 1920, step: 1 / VIEWER.sampleFps, samples };
}

/** How much the picture changes, read from the mp4: for each moment, the share of pixels that changed since the one before. */
export interface Motion {
  fps: number;
  change: number[];
}

/** Reads the rendered mp4 small and grey, and measures change between frames, leaving out the caption band. */
export async function motionOf(video: string, frame: { width: number; height: number }): Promise<Motion> {
  const w = 108;
  const h = Math.round((w * frame.height) / frame.width / 2) * 2;
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", video, "-vf", `fps=${VIEWER.motionFps},scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const size = w * h;
  const count = Math.floor(stdout.length / size);
  const [c0, c1] = [Math.floor(h * VIEWER.captionTop) - 2, Math.ceil(h * VIEWER.captionBottom) + 2];
  const change = [0];
  for (let i = 1; i < count; i++) {
    let n = 0;
    let all = 0;
    for (let y = 0; y < h; y++) {
      if (y >= c0 && y <= c1) continue;
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        all++;
        if (Math.abs(stdout[i * size + k]! - stdout[(i - 1) * size + k]!) > VIEWER.pixelStep) n++;
      }
    }
    change.push(n / all);
  }
  return { fps: VIEWER.motionFps, change };
}

/** Stretches of the mp4's sound below the silence level, in seconds. */
export async function silencesOf(video: string): Promise<[number, number][]> {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-hide_banner", "-nostats", "-i", video, "-af", `silencedetect=n=${VIEWER.silenceDb}dB:d=${VIEWER.silenceSeconds}`, "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const out: [number, number][] = [];
  let start: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== undefined) {
      out.push([start, Number(e[1])]);
      start = undefined;
    }
  }
  return out;
}

/** What the report needs of a cut (cut.ts's Cut has all of it). */
export interface Heard {
  durationMs: number;
  spans: { id: string; startMs: number; endMs: number }[];
  words: { text: string; start: number; end: number; beat: string }[];
  holds: { beat: string; id: string; start: number; seconds: number }[];
  voice: { real: boolean; label?: string };
  sound?: { lufs: number; truePeak: number; music: string[] };
}

/** One thing a viewer would notice. `weight` only orders the lines; it is never shown. */
export interface Observation {
  at: number;
  beat: string;
  kind: string;
  text: string;
  weight: number;
}

export interface Report {
  observations: Observation[];
  fine: string[];
  unmeasured: string[];
  /** How the seconds are shared between the beats, and the spoken length against the length asked. */
  time?: string;
}

/** The seconds of each beat and its share of the spoken video, longest marked, against the length asked when known. */
export function timeShares(heard: Heard, targetSeconds?: number): string | undefined {
  if (!heard.spans.length) return undefined;
  const spoken = heard.spans.at(-1)!.endMs / 1000;
  const each = heard.spans.map((s) => ({ id: s.id, seconds: (s.endMs - s.startMs) / 1000 }));
  const most = each.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  const least = each.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  const over = targetSeconds ? spoken / targetSeconds - 1 : 0;
  const against = targetSeconds ? ` against about ${Math.round(targetSeconds)} s asked (${over >= 0 ? `${Math.round(over * 100)}% over` : `${Math.round(-over * 100)}% under`})` : "";
  return `Time by beat: ${each.map((x) => `${x.id} ${s1(x.seconds)} s (${Math.round((x.seconds / spoken) * 100)}%)`).join(", ")}; ${s1(spoken)} s spoken${against}, the end card after it. The longest beat is ${most.id}, the shortest ${least.id}${each.length > 2 && most.seconds < least.seconds * 1.5 ? ", and the beats are within half again of each other: the time is spread about evenly" : ""}.`;
}

/** 0:14.2 */
export const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const s1 = (x: number) => x.toFixed(1);
const quoted = (s: string, n = 40) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
const wordsIn = (s: string) => s.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];
const STOP = new Set("the and that this with from into over under what when where which while have has had are was were been being their there them they then than your yours about also only just more most such each very will would could should these those its it's once after before until since during through without within between against across along around among onto upon because though although unless whether however instead every some many much other another still even ever never always often here again does doing done cannot can't don't won't isn't aren't wasn't weren't ours hers itself himself herself themselves ourselves".split(" "));
/** The words of a text that carry its meaning, plain, for matching against what the voice says. */
const keyWords = (s: string) => wordsIn(s.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w));
/** The words of a thing's id that could name it, four letters or more: "shearLine.mark" gives shear, line and mark. */
const idWords = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const same = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Run {
  owner: string;
  text: string;
  beat: string;
  from: number;
  to: number;
  size: number;
  cut: number;
  covered: number;
  cutFor: number;
  coveredFor: number;
}

/** Each piece of writing's times on screen, readable: one run per stretch it stays with the same words. */
function runsOf(facts: Facts): Run[] {
  const open = new Map<string, Run>();
  const done: Run[] = [];
  const step = facts.step;
  for (const s of facts.samples) {
    const seen = new Set<string>();
    for (const x of s.texts) {
      if (x.opacity < VIEWER.readOpacity || !x.text.trim()) continue;
      const key = `${s.beat}\u0000${x.owner}\u0000${x.text}`;
      seen.add(key);
      const r = open.get(key);
      if (r) {
        r.to = s.t;
        r.size = Math.min(r.size, x.size);
        r.cut = Math.max(r.cut, x.cut);
        r.covered = Math.max(r.covered, x.covered);
        if (x.cut > VIEWER.cutShare) r.cutFor += step;
        if (x.covered > VIEWER.coveredShare) r.coveredFor += step;
      } else open.set(key, { owner: x.owner, text: x.text, beat: s.beat, from: s.t, to: s.t, size: x.size, cut: x.cut, covered: x.covered, cutFor: x.cut > VIEWER.cutShare ? step : 0, coveredFor: x.covered > VIEWER.coveredShare ? step : 0 });
    }
    for (const [k, r] of open) {
      if (!seen.has(k)) {
        done.push(r);
        open.delete(k);
      }
    }
  }
  return [...done, ...open.values()].sort((a, b) => a.from - b.from);
}

/** The words a beat's voice says, with their times in the video. */
const spokenIn = (heard: Heard, beat: string) => heard.words.filter((w) => w.beat === beat);

/**
 * Everything the report finds, from the scenes' samples, the cut's words and (when read) the mp4's change and silences.
 * Pure, so each kind of observation can be tried on a small built video.
 */
export function observe(facts: Facts, heard: Heard, motion?: Motion, silences: [number, number][] = [], targetSeconds?: number): Report {
  const out: Observation[] = [];
  const fine: string[] = [];
  const step = facts.step;
  const spanOf = (beat: string) => heard.spans.find((s) => s.id === beat);
  const into = (t: number, beat: string) => t - (spanOf(beat)?.startMs ?? 0) / 1000;
  const where = (t: number, beat: string) => `${clock(t)} (${beat}, ${s1(Math.max(0, into(t, beat)))} s in)`;
  const add = (at: number, beat: string, kind: string, weight: number, text: string) => out.push({ at, beat, kind, weight, text });
  const toPoints = (px: number) => (px * VIEWER.phoneWidth) / facts.width;

  // Writing: how long each piece is readable, how big it is on a phone, whether the frame or a shape cuts it.
  const runs = runsOf(facts);
  const byOwner = new Map<string, Set<string>>();
  for (const r of runs) byOwner.set(`${r.beat}\u0000${r.owner}`, (byOwner.get(`${r.beat}\u0000${r.owner}`) ?? new Set()).add(r.text));
  // A piece whose words keep changing (a counter, a value a kit updates, letters typed in) is a readout, not a label to read.
  const readout = (r: Run) => (byOwner.get(`${r.beat}\u0000${r.owner}`)?.size ?? 0) >= 3;
  let labels = 0;
  let brief = 0;
  for (const r of runs) {
    const n = wordsIn(r.text).length;
    if (!n || readout(r)) continue;
    labels++;
    const shown = r.to - r.from + step;
    const need = VIEWER.noticeSeconds + n / VIEWER.readWordsPerSecond;
    const said = spokenIn(heard, r.beat);
    const keys = keyWords(r.text);
    const hits = said.filter((w) => keyWords(w.text).some((k) => keys.some((x) => same(k, x))));
    const during = hits.filter((w) => w.start <= r.to + step && w.end >= r.from);
    if (shown < need * VIEWER.briefShare) {
      brief++;
      const voice = during.length ? ` The voice says ${quoted(during[0]!.text)} while it is up, so it is heard even where it is not read.` : "";
      add(r.from, r.beat, "brief", 55 * (1 - shown / need) + (during.length ? 0 : 10), `At ${where(r.from, r.beat)} the words ${quoted(r.text)} are on screen for ${s1(shown)} s; reading ${plural(n, "word")} takes about ${s1(need)} s, so a viewer sees them go after about ${Math.round((shown / need) * 100)}% of that.${voice}`);
    }
    // In step with the voice: the voice names it well before it shows, or after it has gone.
    if (hits.length && !during.length) {
      const before = hits.filter((w) => w.end < r.from).at(-1);
      const after = hits.find((w) => w.start > r.to + step);
      if (before && r.from - before.end > VIEWER.laggingSeconds && (!after || after.start - r.to > r.from - before.end)) {
        add(r.from, r.beat, "late", 35, `At ${where(r.from, r.beat)} ${quoted(r.text)} appears ${s1(r.from - before.end)} s after the voice said ${quoted(before.text)} (at ${clock(before.start)}); it is not on screen while it is said.`);
      } else if (after && after.start - (r.to + step) > 0.3 && after.start - (r.to + step) < 6) {
        add(r.to, r.beat, "gone", 50, `At ${where(r.to + step, r.beat)} ${quoted(r.text)} leaves the screen ${s1(after.start - (r.to + step))} s before the voice says ${quoted(after.text)} (at ${clock(after.start)}); the viewer hears it named with it gone.`);
      }
    }
    if (r.cutFor >= VIEWER.steadySeconds) add(r.from, r.beat, "cut", 80, `At ${where(r.from, r.beat)} ${quoted(r.text)} runs off the edge of the frame: about ${Math.round(r.cut * 100)}% of it is outside, for ${s1(r.cutFor)} s.`);
    if (r.coveredFor >= VIEWER.steadySeconds) add(r.from, r.beat, "covered", 70, `At ${where(r.from, r.beat)} ${quoted(r.text)} is ${Math.round(r.covered * 100)}% under a filled shape drawn in front of it, for ${s1(r.coveredFor)} s.`);
  }
  if (labels && !brief) fine.push(`all ${plural(labels, "piece")} of writing stay on screen long enough to read at ${VIEWER.readWordsPerSecond} words a second`);

  // Small writing, by beat: the smallest each piece gets on a phone.
  const small = new Map<string, Run[]>();
  let smallest = Infinity;
  for (const r of runs) {
    if (!wordsIn(r.text).length && !/\d/.test(r.text)) continue;
    smallest = Math.min(smallest, toPoints(r.size));
    if (toPoints(r.size) < VIEWER.smallestPoints && r.to - r.from + step >= VIEWER.steadySeconds) small.set(r.beat, [...(small.get(r.beat) ?? []), r]);
  }
  for (const [beat, list] of small) {
    const pieces = [...new Map(list.map((r) => [r.text, r])).values()];
    const worst = Math.min(...pieces.map((r) => toPoints(r.size)));
    add(pieces[0]!.from, beat, "small", 45 + (VIEWER.smallestPoints - worst) * 4, `In ${beat}, from ${clock(pieces[0]!.from)}, ${pieces.slice(0, 3).map((r) => `${quoted(r.text, 30)} is ${s1(toPoints(r.size))} pt`).join(", ")}${pieces.length > 3 ? ` and ${pieces.length - 3} more` : ""} on a phone ${VIEWER.phoneWidth} points wide; ${VIEWER.smallestPoints} pt is the smallest text a phone uses.`);
  }
  if (Number.isFinite(smallest) && !small.size) fine.push(`the smallest writing is ${s1(smallest)} pt on a phone (${VIEWER.smallestPoints} pt is the smallest a phone uses)`);
  if (!runs.some((r) => r.cutFor >= VIEWER.steadySeconds)) fine.push("no writing runs off the frame");

  // Writing on top of writing, by pair, for as long as it lasts.
  const pairs = new Map<string, { a: string; b: string; beat: string; from: number; for: number; share: number }>();
  const textAt = (s: Sample, owner: string) => s.texts.find((x) => x.owner === owner)?.text ?? owner;
  for (const s of facts.samples) {
    for (const [a, b, share] of s.overlaps) {
      const key = `${s.beat}\u0000${a}\u0000${b}`;
      const p = pairs.get(key);
      if (p) Object.assign(p, { for: p.for + step, share: Math.max(p.share, share) });
      else pairs.set(key, { a: textAt(s, a), b: textAt(s, b), beat: s.beat, from: s.t, for: step, share });
    }
  }
  const overlapping = [...pairs.values()].filter((p) => p.for >= VIEWER.steadySeconds);
  for (const p of overlapping) add(p.from, p.beat, "overlap", 75, `At ${where(p.from, p.beat)} ${quoted(p.a, 30)} and ${quoted(p.b, 30)} sit on top of each other (${Math.round(p.share * 100)}% of the smaller) for ${s1(p.for)} s.`);
  if (!overlapping.length) fine.push("no writing sits on other writing");

  // Under the captions: things drawn where the captions are, while words are spoken.
  const [c0, c1] = [facts.height * VIEWER.captionTop, facts.height * VIEWER.captionBottom];
  const band: Rect = { x0: 90 * (facts.width / 1080), y0: c0, x1: facts.width - 160 * (facts.width / 1080), y1: c1 };
  const talking = (t: number) => heard.words.some((w) => w.start - 0.1 <= t && w.end + 0.3 >= t);
  const under = new Map<string, { beat: string; from: number; for: number; words: boolean }>();
  for (const s of facts.samples) {
    if (!talking(s.t)) continue;
    for (const x of s.things) {
      if (area(meet(x.box, band)) < Math.max(1, area(x.box)) * 0.2 || area(x.box) > facts.width * facts.height * 0.5) continue;
      const key = `${s.beat}\u0000${x.id}`;
      const u = under.get(key);
      if (u) u.for += step;
      else under.set(key, { beat: s.beat, from: s.t, for: step, words: x.words });
    }
  }
  for (const [key, u] of under) if (u.for >= VIEWER.steadySeconds) add(u.from, u.beat, "captions", 40, `At ${where(u.from, u.beat)} ${u.words ? `the writing ${quoted(facts.samples.find((s) => s.beat === u.beat)?.texts.find((t) => top(t.owner) === key.split("\u0000")[1])?.text ?? "", 30)}` : "a drawn thing"} sits in the band where the captions are drawn, for ${s1(u.for)} s while the voice speaks.`);

  // Each beat: how it opens, how it ends, how full the frame is, how big its subject.
  for (const span of heard.spans) {
    const [start, end] = [span.startMs / 1000, span.endMs / 1000];
    const own = facts.samples.filter((s) => s.beat === span.id);
    if (!own.length) continue;
    const firstSeen = own.find((s) => s.things.length);
    const empty = (firstSeen?.t ?? end) - start;
    if (empty >= VIEWER.emptyOpenSeconds) add(start, span.id, "opens", 65, `${span.id} opens on an empty frame: nothing is on screen for its first ${s1(empty)} s (from ${clock(start)}).`);
    const seenAt = new Map<string, number>();
    for (const s of own) for (const x of s.things) if (!seenAt.has(x.id)) seenAt.set(x.id, s.t);
    const latecomers = [...seenAt].filter(([, t]) => t > start + 0.5 && end - t < VIEWER.lateSeconds);
    if (latecomers.length) add(latecomers[0]![1], span.id, "ending", 30, `${span.id} cuts at ${clock(end)}, ${s1(end - latecomers[0]![1])} s after ${latecomers.length === 1 ? "a thing" : `${latecomers.length} things`} first appear${latecomers.length === 1 ? "s" : ""} (${latecomers.slice(0, 3).map(([id]) => own.flatMap((s) => s.texts).find((t) => top(t.owner) === id)?.text ?? "a drawn thing").map((x) => quoted(x, 24)).join(", ")}); it is barely seen before the next beat.`);
    const seconds = end - start;
    const sparse = own.filter((s) => s.used < VIEWER.usedShare).length / own.length;
    if (seconds >= 2 && sparse >= VIEWER.mostOf) add(start, span.id, "sparse", 20, `In ${span.id} (${clock(start)} to ${clock(end)}) the frame above the captions is mostly empty for ${Math.round(sparse * 100)}% of the beat: on average ${Math.round((own.reduce((a, s) => a + s.used, 0) / own.length) * 100)}% of it has anything in it.`);
    const usable = facts.width * facts.height * (0.812 - 0.047);
    const drawn = own.filter((s) => s.things.some((x) => !x.words));
    if (seconds >= 2 && drawn.length / own.length >= VIEWER.mostOf) {
      const biggest = drawn.map((s) => Math.max(...s.things.filter((x) => !x.words).map((x) => area(x.box)))) .map((a) => a / usable);
      const smallShare = biggest.filter((b) => b < VIEWER.subjectShare).length / own.length;
      if (smallShare >= VIEWER.mostOf) add(start, span.id, "subject", 20, `In ${span.id} the biggest drawn thing covers about ${Math.round((biggest.reduce((a, b) => a + b, 0) / biggest.length) * 100)}% of the frame above the captions; on a phone it reads as small.`);
    } else if (seconds >= 2 && own.every((s) => s.things.every((x) => x.words))) add(start, span.id, "words-only", 15, `${span.id} (${clock(start)} to ${clock(end)}) shows only writing: nothing drawn and no picture.`);
    // Drawn things against the words that name them: a thing whose id holds a word the voice says, first shown well
    // after that word (the voice named it before it was there to see).
    const said = spokenIn(heard, span.id);
    const late: string[] = [];
    for (const [id, t] of seenAt) {
      if (own.find((s) => s.t === t)?.things.find((x) => x.id === id)?.words) continue;
      const names = idWords(id);
      if (!names.length) continue;
      const named = said.find((w) => keyWords(w.text).some((k) => names.some((n) => same(k, n))));
      if (named && t - named.end > VIEWER.laggingSeconds && t > start + 0.3) late.push(`"${named.text.replace(/[.,;:!?]+$/, "")}" is said at ${clock(named.start)} and the thing drawn for it (${id}) first shows at ${clock(t)}, ${s1(t - named.end)} s later`);
    }
    if (late.length) add(start, span.id, "named-first", 40, `In ${span.id} the voice names ${late.length === 1 ? "a thing" : `${late.length} things`} before ${late.length === 1 ? "it is" : "they are"} drawn: ${late.slice(0, 3).join("; ")}${late.length > 3 ? `; and ${late.length - 3} more` : ""}. Matched by the words of each thing's id, so a thing named otherwise is not seen here.`);
  }

  // Repeated shelf piece across most beats of the video: stated as a plain observation with when it starts.
  if (facts.pieces && heard.spans.length >= VIEWER.samePieceMinBeats) {
    const byPiece = new Map<string, string[]>();
    for (const span of heard.spans) {
      for (const piece of new Set(facts.pieces[span.id] ?? [])) {
        byPiece.set(piece, [...(byPiece.get(piece) ?? []), span.id]);
      }
    }
    for (const [piece, beats] of byPiece) {
      if (beats.length < VIEWER.samePieceMinBeats || beats.length <= heard.spans.length / 2) continue;
      const firstAt = (spanOf(beats[0]!)?.startMs ?? 0) / 1000;
      const who = beats.length === heard.spans.length ? `All ${beats.length} beats` : `${beats.length} of ${heard.spans.length} beats`;
      add(firstAt, beats[0]!, "same-piece", 55, `${who} (${beats.join(", ")}) run the same shelf piece ("${piece}"), starting at ${clock(firstAt)}, so those beats share one layout.`);
    }
  }

  // Too much at once: new things and new words arriving within one second (not counting a beat's opening, which is a cut).
  let last = -10;
  for (const span of heard.spans) {
    const own = facts.samples.filter((s) => s.beat === span.id);
    const arrivals: { t: number; things: number; words: number }[] = [];
    for (let i = 1; i < own.length; i++) {
      const before = new Set(own.slice(Math.max(0, i - 3), i).flatMap((s) => s.things.map((x) => x.id)));
      const textBefore = new Set(own.slice(Math.max(0, i - 3), i).flatMap((s) => s.texts.map((x) => `${x.owner}\u0000${x.text}`)));
      const fresh = own[i]!.things.filter((x) => !before.has(x.id)).length;
      const words = own[i]!.texts.filter((x) => x.opacity >= VIEWER.readOpacity && !textBefore.has(`${x.owner}\u0000${x.text}`)).reduce((n, x) => n + wordsIn(x.text).length, 0);
      if (own[i]!.t - span.startMs / 1000 > 0.3) arrivals.push({ t: own[i]!.t, things: fresh, words });
    }
    for (const a of arrivals) {
      const win = arrivals.filter((b) => b.t >= a.t && b.t < a.t + 1);
      const [things, words] = [win.reduce((n, b) => n + b.things, 0), win.reduce((n, b) => n + b.words, 0)];
      if ((things >= VIEWER.burstThings || words >= VIEWER.burstWords) && a.t - last > 2) {
        last = a.t;
        add(a.t, span.id, "burst", 25, `At ${where(a.t, span.id)} ${things >= VIEWER.burstThings ? `${things} new things appear within one second` : ""}${things >= VIEWER.burstThings && words >= VIEWER.burstWords ? ", with " : ""}${words >= VIEWER.burstWords ? `${words} new words to read appear within one second` : ""}.`);
      }
    }
  }

  // The picture standing still while the voice goes on, from the mp4's own pixels.
  const stillRuns: [number, number][] = [];
  if (motion) {
    let from: number | undefined;
    const stories = heard.spans.length ? heard.spans.at(-1)!.endMs / 1000 : 0;
    for (let i = 1; i <= motion.change.length; i++) {
      const t = i / motion.fps;
      const quiet = i < motion.change.length && motion.change[i]! < VIEWER.changedShare && t <= stories;
      if (quiet) from ??= (i - 1) / motion.fps;
      else if (from !== undefined) {
        if (t - from >= VIEWER.stillSeconds) stillRuns.push([from, Math.min(t, stories)]);
        from = undefined;
      }
    }
    for (const [a, b] of stillRuns) {
      const said = heard.words.filter((w) => w.start < b && w.end > a);
      if (!said.length) continue;
      const beat = heard.spans.find((s) => a * 1000 >= s.startMs && a * 1000 < s.endMs)?.id ?? said[0]!.beat;
      const text = said.map((w) => w.text).join(" ");
      add(a, beat, "still", 45 * Math.min(2, (b - a) / VIEWER.stillSeconds), `From ${clock(a)} to ${clock(b)} (${beat}) nothing on screen moves or changes for ${s1(b - a)} s while the voice says ${quoted(text, 80)} (${plural(said.length, "word")}).`);
    }
    if (!stillRuns.length) fine.push(`the picture never stands still for ${VIEWER.stillSeconds} s or more while the voice speaks`);
  }

  // The voice: gaps, silence, being cut, pace.
  const lastWords = new Map<string, number>();
  for (const w of heard.words) lastWords.set(w.beat, w.end);
  for (const span of heard.spans) {
    const endT = lastWords.get(span.id);
    if (endT !== undefined && endT > span.endMs / 1000 + 0.02) add(span.endMs / 1000, span.id, "voice-cut", 100, `${span.id} cuts at ${clock(span.endMs / 1000)} while its voice is still speaking; its last word runs to ${clock(endT)}.`);
  }
  let gaps = 0;
  for (let i = 1; i < heard.words.length; i++) {
    const [a, b] = [heard.words[i - 1]!, heard.words[i]!];
    const gap = b.start - a.end;
    if (gap < VIEWER.gapSeconds) continue;
    gaps++;
    const hold = heard.holds.find((h) => h.start >= a.end - 0.3 && h.start <= b.start);
    const silent = silences.some(([s, e]) => s < b.start - 0.3 && e > a.end + 0.3);
    const still = stillRuns.some(([s, e]) => s <= a.end + 0.2 && e >= b.start - 0.2);
    add(a.end, a.beat, "gap", 30 + Math.min(20, gap * 5) + (still ? 15 : 0), `From ${clock(a.end)} to ${clock(b.start)} the voice is quiet for ${s1(gap)} s, between ${quoted(a.text)} and ${quoted(b.text)}${hold ? ` (a [pause ${hold.seconds}] in ${hold.beat})` : a.beat !== b.beat ? ` (across the cut from ${a.beat} to ${b.beat})` : ""}${silent ? "; nothing at all is heard, no music either" : ""}${motion ? (still ? ", and the picture stands still through it" : ", while the picture moves") : ""}.`);
  }
  const voiced = heard.spans.length ? heard.spans.at(-1)!.endMs / 1000 : 0;
  const hush = silences.filter(([s, e]) => e - s >= VIEWER.silenceSeconds && s < voiced - 0.5 && !heard.words.some((w) => w.start < e && w.end > s));
  if (heard.voice.real && !gaps && !hush.length) fine.push(`no gap in the voice is longer than ${VIEWER.gapSeconds} s`);
  if (!heard.voice.real) add(0, heard.spans[0]?.id ?? "", "no-voice", 90, `The video has no sound: it is made without a voice, so the captions carry every word and the picture must be watchable with the sound off.`);

  const paces: string[] = [];
  const pace: Observation[] = [];
  for (const span of heard.spans) {
    const said = spokenIn(heard, span.id);
    if (said.length < 6) continue;
    const holds = heard.holds.filter((h) => h.beat === span.id).reduce((n, h) => n + h.seconds, 0);
    const minutes = Math.max(0.01, said.at(-1)!.end - said[0]!.start - holds) / 60;
    const wpm = Math.round(said.length / minutes);
    paces.push(`${span.id} ${wpm}`);
    if (wpm > VIEWER.fastWordsPerMinute) pace.push({ at: said[0]!.start, beat: span.id, kind: "fast", weight: 25 + (wpm - VIEWER.fastWordsPerMinute) / 4, text: `${span.id} (${clock(said[0]!.start)}) is spoken at ${wpm} words a minute; conversation runs near 150, so it sounds rushed.` });
    if (wpm < VIEWER.slowWordsPerMinute) pace.push({ at: said[0]!.start, beat: span.id, kind: "slow", weight: 20, text: `${span.id} (${clock(said[0]!.start)}) is spoken at ${wpm} words a minute; conversation runs near 150, so it sounds slow.` });
  }
  // When most beats share the pace, it is the voice's own speed: one line for the whole video.
  const overall = heard.words.length > 6 ? Math.round(heard.words.length / Math.max(0.01, (heard.words.at(-1)!.end - heard.words[0]!.start - heard.holds.reduce((n, h) => n + h.seconds, 0)) / 60)) : 0;
  const paused = heard.holds.reduce((n, h) => n + h.seconds, 0);
  for (const kind of ["fast", "slow"]) {
    const list = pace.filter((p) => p.kind === kind);
    if (list.length >= 2 && list.length >= paces.length / 2) add(list[0]!.at, list[0]!.beat, kind, Math.max(...list.map((p) => p.weight)), `The whole voice is ${kind === "fast" ? "fast" : "slow"}: ${overall} words a minute over the video (${paces.join(", ")}), where conversation runs near 150, so it sounds ${kind === "fast" ? "rushed" : "slow"} throughout${paused ? `. That is the pace of the speech itself; the ${s1(paused)} s of pauses between are not counted in it` : ""}.`);
    else out.push(...list);
  }
  if (overall && !pace.length) fine.push(`the voice runs at ${overall} words a minute over the video (${paces.join(", ")})`);
  if (heard.sound) fine.push(`loudness ${heard.sound.lufs} LUFS, peak ${heard.sound.truePeak} dBTP${heard.sound.music.length ? "" : ", voice only (no music)"}`);
  out.sort((a, b) => b.weight - a.weight || a.at - b.at);
  return {
    observations: out,
    fine,
    unmeasured: ["whether a drawn thing arrives when the voice names it, where its id does not hold the word the voice says", "colours and contrast", "whether the picture explains the idea"],
    time: timeShares(heard, targetSeconds),
  };
}

/** The report in plain words, for the agent. */
export function reportText(report: Report, about: string, most = 14): string {
  const lines = report.observations.slice(0, most);
  const more = report.observations.length - lines.length;
  return [
    about,
    lines.length ? `What a viewer would notice, the most noticeable first (${plural(report.observations.length, "thing")}):` : "Nothing measured here stands out to a viewer.",
    ...lines.map((o, i) => `${i + 1}. ${o.text}`),
    ...(more > 0 ? [`And ${more} more of the same kinds, less noticeable.`] : []),
    ...(report.time ? [report.time] : []),
    ...(report.fine.length ? [`Reads fine: ${report.fine.join("; ")}.`] : []),
    `Not measured here: ${report.unmeasured.join("; ")}.`,
  ].join("\n");
}
