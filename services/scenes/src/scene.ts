/**
 * One scene of an Open Sourcebook video, built and read the way the scene stage builds and reads a section: each scene of
 * the script is its own part, with its own words numbered from 0, its own length from the voice, and the video's
 * style and frame. What the agent gets back is what code can see: build problems with lines, the stage's warnings,
 * craft notes, the instruments' readings, and measured layout facts at each settled moment.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { when } from "../engine/core/compile.ts";
import type { Scene, Theme } from "../engine/core/types.ts";
import type { BuildOptions } from "../engine/language/build.ts";
import { parse } from "../engine/language/syntax.ts";
import type { Project } from "../schemas/project.ts";
import { frameReadings } from "../pipeline/lib/instrument-notes.ts";
import { inventory, keptAt, lookFrames, measureLayout, readOf, wordsOnScreen, type Finding } from "../pipeline/lib/look.ts";
import { check, kitKinds, measurePart, plainMoments, projectViewing, renderStills, review, sceneBuildOptions, type Job } from "../pipeline/stages/scene.ts";
import { depictRequest, emptyToolbox, entryKey, toolboxNotes, unprepared, type Toolbox, type Wanted } from "../engine/language/toolbox.ts";
import { depicterTask } from "../engine/design/depict/depicter.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { wordsOf, type ScriptScene } from "./script.ts";

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** A scene's spoken words with their times in seconds from the scene's start, and how long the scene's voice lasts. */
export interface SceneTiming {
  seconds: number;
  words: Word[];
  /** Where the voice waits for the picture: `@h1`, `@h1.end` in the scene language. */
  holds?: Hold[];
}

/** A silence in a scene's voice, after one of its words, in seconds from the scene's start. */
export interface Hold {
  id: string;
  afterWord: number;
  start: number;
  seconds: number;
}

export interface SceneContext {
  title: string;
  idea: string;
  brief: string;
  style: string;
  frame: { width: number; height: number };
  scene: ScriptScene;
  timing: SceneTiming;
  /** The things drawn as themselves so far in this video (`depict`), kept across scenes and builds. */
  toolbox?: Toolbox;
  /** The pictures the scene may show: names to files relative to `root` (the job's folder, which the render serves). */
  assets?: { root: string; files: Record<string, string> };
}

/** The scene as a one-part project, so the stage's own helpers (context, viewing, checks) read it as they would. */
export function sceneProject(c: SceneContext): Project {
  return {
    id: c.scene.id,
    createdAt: new Date(0).toISOString(),
    input: { prompt: c.brief, style: c.style, persona: "auto", mode: "explain", seconds: 0, frame: [c.frame.width, c.frame.height] },
    script: { title: c.title, takeaway: c.idea, beats: [{ id: c.scene.id, role: "explain", text: c.scene.narration, claimIds: [], visual: c.scene.visual, emphasis: c.scene.emphasis ?? [] }] },
    // The scene opens on its first word: @0 is its first frame, not the moment the voice starts a breath later, so
    // the video never shows an empty board while it waits for the first word.
    narration: { audio: "", voiceId: "", model: "timed", seconds: c.timing.seconds, words: c.timing.words.map((w, i) => ({ ...w, ...(i === 0 ? { start: 0 } : {}), beatId: c.scene.id })), holds: c.timing.holds ?? [] },
    stages: {},
    costs: [],
  };
}

export function sceneJob(c: SceneContext, folder: string): Job {
  const p = sceneProject(c);
  const words = wordsOf(c.scene.narration);
  if (words.length !== c.timing.words.length) throw new Error(`${c.scene.id}: ${words.length} words in the narration but ${c.timing.words.length} timed`);
  return { p, range: { id: c.scene.id, firstWord: 0, lastWord: words.length - 1 }, carry: [], handoff: [], system: "", request: "", opts: sceneBuildOptions(p, c.assets?.files ?? {}, c.toolbox ?? emptyToolbox()), folder, log: () => undefined };
}

export interface Built {
  ok: boolean;
  scene?: Scene;
  theme: Theme;
  /** Must be fixed before the scene can be used. */
  problems: string[];
  /** Worth fixing; the scene can be used as it is. */
  warnings: string[];
  /**
   * The warnings a viewer cannot miss: the scene opens empty, words are cut, sit on words, or are too small to read on
   * a phone, or the subject is small in the frame. Also in `warnings`; every
   * answer about the video names the beats that have some.
   */
  serious: string[];
  /** What code sees in a scene that builds, for the agent to weigh. */
  notes: string[];
  seconds: number;
  /** Depicted things the scene asks for that are not drawn yet: the agent answers for them as the depicter. */
  undepicted?: Wanted[];
}

const runFile = promisify(execFile);

/** Words on screen with TeX-style indices or powers typed into them (N_A, x^2), sampled every half second. */
export function typedMarkup(scene: Scene): string[] {
  const out = new Set<string>();
  const step = Math.max(1, Math.round(scene.fps / 2));
  for (let f = 0; f < scene.frames; f += step) {
    for (const t of inventory(scene, f)) {
      if (t.opacity <= 0.1 || !t.text) continue;
      for (const m of t.text.matchAll(/[\p{L}\p{N})\]]+(?:_\{?[\p{L}\p{N}]+\}?|\^\{?[\p{L}\p{N}+-]+\}?)/gu)) out.add(m[0]);
    }
  }
  return [...out].slice(0, 4);
}
const sec = (frame: number, fps: number) => `${(frame / fps).toFixed(1)} s`;

/**
 * The scene as it plays: its first state is on screen from the first frame (a cut), unless the writer gave that state
 * its own `enter=`. Each scene is cut to from the one before, so a fade-in would only show an empty board; things that
 * arrive later still arrive their way. Only the first state line changes, so line numbers stay the writer's.
 */
export function opening(source: string): string {
  const lines = source.split("\n");
  let inProgram = false;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (inProgram) {
      if (t === "end") inProgram = false;
      continue;
    }
    if (/^program\s/.test(t)) inProgram = true;
    else if (/^@\S/.test(t)) {
      if (!/(^|\s)(cut|enter=\S+)(\s|$)/.test(t.replace(/#.*$/, ""))) lines[i] = `${line.replace(/\s+$/, "")} cut`;
      break;
    }
  }
  return lines.join("\n");
}

/** Builds a scene's source on these timings with the stage's checker, and reads it. */
export async function buildScene(c: SceneContext, written: string, folder: string): Promise<Built> {
  const source = opening(written);
  const job = sceneJob(c, folder);
  const theme = job.opts.ctx.theme;
  const seconds = job.opts.ctx.frames / job.opts.ctx.fps;
  // Every depicted thing needs its spec before the scene can be drawn; the agent answers for it as the depicter.
  const undepicted = unprepared(plainMoments(source, job.opts), kitKinds(), c.toolbox ?? emptyToolbox());
  if (undepicted.length) return { ok: false, theme, problems: undepicted.map((w) => depicterAsk(w, c)), warnings: [], serious: [], notes: [], seconds, undepicted };
  const checked = await check(job, source);
  const result = checked.result;
  if (!result.scene || checked.problems.length) return { ok: false, theme, problems: checked.problems.length ? checked.problems : ["It did not build, and the engine named no line."], warnings: checked.warnings, serious: [], notes: checked.notes, seconds };
  const scene = result.scene;
  const notes: string[] = [];
  const said = review(job, source, result).trim();
  if (said) notes.push(said);
  const part = measurePart(job, scene);
  const fill = part.readings.find((r) => r.instrument === "fill")?.values ?? {};
  const crafted = craft(job, source, scene, { largest: Number(fill.largest ?? 1), emptyBand: Number(fill.emptyBand ?? 0) });
  // What a viewer cannot miss: an empty opening and a subject too small to see.
  const serious = [...opensEmpty(scene), ...crafted.filter((w) => w.startsWith("Size:"))];
  // Words well under the size a phone viewer reads in passing (the legibility instrument's own setting) are worth fixing.
  const legibility = part.readings.find((r) => r.instrument === "legibility");
  const readable = Number(part.settings.legibility?.readable ?? 0);
  if (legibility && readable && Number(legibility.values.minAngle ?? readable) < readable * 0.8) {
    const small = legibility.notes.filter((n) => /^under \d+ arcmin/.test(n)).slice(0, 1);
    serious.push(`Small words: ${small.length ? small[0]!.replace(/^under (\d+) arcmin: /, "") : "some writing"} (cap heights in arcminutes; ${readable} reads on a phone). Make them bigger (a size=big text instead of a tag or a label inside a shape), or fewer.`);
  }
  // What each depicted thing can do: its states with their ranges, its verbs, its parts and points.
  const things = c.toolbox ? toolboxNotes(plainMoments(source, job.opts), kitKinds(), c.toolbox, theme) : [];
  if (things.length) notes.push(["The depicted things (use exactly these names):", ...things.map((t) => `- ${t}`)].join("\n"));
  const instruments = part.lines.map((l) => l.replace(/ \((\w+); settings: .*\)$/, " ($1)")).filter((l) => !/^\s+values:/.test(l));
  if (instruments.length) notes.push(["The instruments' readings (times are seconds into this scene, places are shares of the frame):", ...instruments].join("\n"));
  const typed = typedMarkup(scene);
  if (typed.length) serious.push(`Typed markup shows as itself: ${typed.map((t) => `"${t}"`).join(", ")}. The viewer sees the _ or ^ as a character; set indices and powers with math, or with Unicode where it has the character (x², H₂O).`);
  const found = measured(job, scene, source);
  serious.push(...found.filter((x) => SERIOUS.has(x.kind)).map((x) => x.text));
  const rest = [...checked.warnings, ...found.filter((x) => !SERIOUS.has(x.kind)).map((x) => x.text), ...crafted.filter((w) => !serious.includes(w))];
  return { ok: true, scene, theme, problems: [], warnings: [...serious, ...rest], serious, notes, seconds };
}

/** What the depicter is asked for a thing, as the agent answers it: the depicter's own request, unchanged. */
export function depicterAsk(w: Wanted, c: SceneContext): string {
  const { req } = depictRequest(w, c.toolbox?.depictions[entryKey(w.id, w.desc)], c.idea || c.title);
  return `${w.id} ("${w.desc}") is not depicted yet. Answer as the depicter: send its PropSpec in depictions with this scene, as { "id": "${w.id}", "desc": "${w.desc.replace(/"/g, '\\"')}", "spec": {...} } (the make-a-video skill's references/depicting.md has the kinds, their parameters and colors). What the depicter is asked:\n${depicterTask(req).request}`;
}

/** What a viewer sees in the scene's first moments: the cut to it should land on its subject, not a bare board. */
function opensEmpty(scene: Scene): string[] {
  const f = Math.min(scene.frames - 1, Math.round(scene.fps * 0.4));
  const area = (b: { x0: number; y0: number; x1: number; y1: number }) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const frameArea = scene.width * scene.height;
  const things = inventory(scene, f).filter((t) => t.opacity > 0.5 && area(t.box) < frameArea * 0.8);
  const fix = "Put the subject in the state at @0 so the scene opens on it (it can change and move after).";
  if (!things.length) return [`Opens empty: at ${sec(f, scene.fps)} nothing is on screen. ${fix}`];
  // Each thing by what owns it (a matrix's cells, a program's paths); a title line across the top does not count.
  const owners = new Map<string, { x0: number; y0: number; x1: number; y1: number; text: boolean }>();
  for (const t of things) {
    const key = t.owner.split(".")[0]!;
    const o = owners.get(key);
    owners.set(key, o ? { x0: Math.min(o.x0, t.box.x0), y0: Math.min(o.y0, t.box.y0), x1: Math.max(o.x1, t.box.x1), y1: Math.max(o.y1, t.box.y1), text: o.text && t.kind === "text" } : { ...t.box, text: t.kind === "text" });
  }
  const subject = [...owners.values()].filter((o) => !(o.text && o.y1 < scene.height * 0.2)).reduce((s, o) => s + area(o), 0) / frameArea;
  if (subject < 0.05) {
    const words = wordsOnScreen(things);
    return [`Opens empty: at ${sec(f, scene.fps)} only ${words.length ? words.map((w) => `"${w.slice(0, 30)}"`).join(", ") : "small marks"} ${words.length === 1 ? "is" : "are"} on screen. ${fix}`];
  }
  return [];
}

/** The settled moment of each state, and a few changing ones, as the look step picks them. */
export function moments(job: Job, scene: Scene, source: string): { frame: number; why: string }[] {
  const { doc } = parse(plainMoments(source, job.opts), kitKinds());
  const starts = doc.states.map((s) => Math.max(0, when(s.at, job.opts.ctx)));
  return lookFrames(starts, 0, scene.frames - 1, scene.fps, 12);
}

/** What the compiled scene shows at its settled moments that is measurably wrong: overlaps, cut words, small words, empty frames. */
function measured(job: Job, scene: Scene, source: string): { kind: string; text: string }[] {
  const read = readOf(job.opts.ctx.theme);
  const out = new Map<string, string[]>();
  const fps = scene.fps;
  const { doc } = parse(plainMoments(source, job.opts), kitKinds());
  const starts = doc.states.map((s) => Math.max(0, when(s.at, job.opts.ctx)));
  // Every half second; a frame within two thirds of a second of a state's start is caught while things arrive and leave.
  for (let f = Math.round(fps / 2); f < scene.frames; f += Math.round(fps / 2)) {
    const changing = starts.some((s) => f >= s && f - s < Math.round(fps * 0.67));
    const findings = measureLayout(inventory(scene, f), scene.width, scene.height, read, changing, keptAt(scene, f)).filter((x: Finding) => x.severity >= 3);
    for (const x of findings) out.set(x.kind, [...(out.get(x.kind) ?? []), `${sec(f, fps)}: ${x.note}`]);
  }
  return [...out].map(([kind, list]) => ({ kind, text: `${label[kind] ?? kind} at ${list.length} of the half-second checks, first at ${list[0]}${list.length > 1 ? `; last at ${list.at(-1)}` : ""}` }));
}

/** Measured findings a viewer cannot miss. */
const SERIOUS = new Set(["off_frame", "small_text", "overlap", "hidden_picture"]);

const label: Record<string, string> = { off_frame: "Words cut by the frame edge", small_text: "Words too small to read on a phone", overlap: "Writing on top of writing", hidden_picture: "A picture hidden under a shape", empty: "A mostly empty frame", dimmed: "Most of the frame dimmed" };

/**
 * What a phone viewer would notice that the engine does not refuse: the main thing drawn small, words that crowd the
 * frame, words that stay on screen long after the voice has moved on, and a scene made only of boxes and words.
 */
function craft(job: Job, source: string, scene: Scene, fill: { largest: number; emptyBand: number }): string[] {
  const out: string[] = [];
  const fps = scene.fps;
  const picked = moments(job, scene, source).filter((m) => m.why === "settled");
  const crowded: string[] = [];
  const shown = new Map<string, { text: string; from: number; to: number }>();
  for (const m of picked) {
    const things = inventory(scene, m.frame).filter((t) => t.opacity > 0.3);
    const words = wordsOnScreen(things);
    const count = words.join(" ").split(/\s+/).filter(Boolean).length;
    if (count > 18) crowded.push(`${sec(m.frame, fps)} (${count} words: ${words.map((w) => `"${w.slice(0, 30)}"`).join(", ")})`);
  }
  for (let f = 0; f < scene.frames; f += Math.round(fps / 2)) {
    for (const t of inventory(scene, f)) {
      if (t.kind !== "text" || t.opacity < 0.5) continue;
      const known = shown.get(t.owner);
      if (known && f - known.to <= fps) known.to = f;
      else if (!known) shown.set(t.owner, { text: t.text ?? t.owner, from: f, to: f });
    }
  }
  if (fill.largest < 0.12) out.push(`Size: the biggest single thing covers ${Math.round(fill.largest * 100)}% of the usable frame${fill.emptyBand > 0.3 ? `, and an empty band takes ${Math.round(fill.emptyBand * 100)}% of its height` : ""}. On a phone the subject should fill a good part of the frame (a quarter or more): draw it larger, give a program more room (w= h=), or put fewer things beside it.`);
  if (crowded.length) out.push(`Words: more than about 18 words on screen at ${crowded.slice(0, 3).join("; ")}. The narration already says them; keep on screen only a few words the picture cannot say.`);
  const { doc } = parse(plainMoments(source, job.opts), kitKinds());
  // A title may stay; other writing that stays through most of a long scene is what the voice has left behind.
  const titles = new Set<string>();
  const findTitles = (items: { id: string; attrs: Record<string, string>; children: unknown[] }[]) => items.forEach((i) => (i.attrs.role === "title" && titles.add(i.id), findTitles(i.children as never)));
  doc.states.forEach((s) => findTitles(s.items as never));
  const lingering = [...shown].filter(([owner, x]) => !titles.has(owner) && (x.to - x.from) / fps > Math.max(8, (scene.frames / fps) * 0.7) && x.text.split(/\s+/).length > 2).map(([, x]) => x);
  if (lingering.length) out.push(`Lingering: ${lingering.slice(0, 3).map((x) => `"${x.text.slice(0, 40)}" stays from ${sec(x.from, fps)} to ${sec(x.to, fps)}`).join("; ")}. Writing the words have moved past should leave (drop it) so the eye goes to what is new.`);
  const kinds = new Map<string, number>();
  const count = (items: { kind: string; children: unknown[] }[]) => items.forEach((i) => (kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1), count(i.children as never)));
  doc.states.forEach((s) => count(s.items as never));
  const drawn = [...kinds].filter(([k]) => !PLAIN.has(k)).reduce((s, [, n]) => s + n, 0);
  // A program that draws only rectangles and circles draws stand-ins, not the thing's own outline and parts.
  const blocky = doc.programs.filter((p) => /\b(rect|circle)\(/.test(p.source) && !/points:\s*\[|\b(curve|arc|polygon)\(|smooth:\s*1/.test(p.source)).map((p) => p.name);
  if (blocky.length) out.push(`Blocks: ${blocky.join(", ")} draw${blocky.length === 1 ? "s" : ""} only rectangles and circles. If the words are about a thing with a body or a shape of its own, draw its real outline and parts (points, smooth curves, arcs), so the viewer recognizes it, and move the part the words name.`);
  if (!doc.programs.length && drawn === 0) out.push(`Only words and plain shapes: this scene is made of ${[...kinds.keys()].join(", ")}, and nothing in it is drawn.`);
  return out;
}

/** Kinds that are words or plain labelled shapes, not a drawing of the thing itself. */
const PLAIN = new Set(["text", "box", "pill", "circle", "diamond", "tri", "dot", "space", "row", "stack", "grid", "chain", "ring", "free", "line", "atoms"]);

export interface Still {
  frame: number;
  file: string;
  text: string;
}

/**
 * Stills of a built scene at spoken moments (word indexes), as small JPEGs, each with what was said around it, the
 * words on screen and the instruments' reading of that frame. With no moments, three settled moments spread over it.
 */
export async function lookAt(c: SceneContext, source: string, built: Built & { scene: Scene }, at: number[] | undefined, folder: string, scale = 0.5): Promise<Still[]> {
  const job = sceneJob(c, folder);
  const scene = built.scene;
  const fps = scene.fps;
  const settle = Math.round(fps * 0.7);
  let frames: number[];
  if (at?.length) {
    frames = at.slice(0, 4).map((i) => Math.min(scene.frames - 1, Math.max(0, when({ word: Math.max(0, Math.min(c.timing.words.length - 1, Math.round(i))) }, job.opts.ctx) + settle)));
  } else {
    // How the scene opens, the settled moment nearest its middle, and how it ends, just before the cut to the next.
    const first = Math.min(scene.frames - 1, Math.round(fps * 0.4));
    const last = Math.max(first, scene.frames - 2);
    const settled = moments(job, scene, source).filter((m) => m.why === "settled" && m.frame > first + fps && m.frame < last - fps).map((m) => m.frame);
    const middle = settled.length ? settled.reduce((a, b) => (Math.abs(b - scene.frames / 2) < Math.abs(a - scene.frames / 2) ? b : a)) : Math.round(scene.frames / 2);
    frames = [first, middle, last];
  }
  frames = [...new Set(frames)].sort((a, b) => a - b);
  const files = await renderStills(await forStills(scene, c.assets?.root), built.theme, frames, folder, scale);
  const viewing = projectViewing(job.p);
  const read = readOf(built.theme);
  return frames.map((frame, k) => {
    const t = frame / fps;
    const near = c.timing.words.map((w, i) => ({ ...w, i })).filter((w) => w.start <= t + 0.3 && w.end >= t - 2.5);
    const things = inventory(scene, frame);
    const findings = measureLayout(things, scene.width, scene.height, read, false, keptAt(scene, frame));
    const lines = [
      `Still ${k + 1}${opensAt(frame, fps) ? " (how the scene opens)" : endsAt(frame, scene.frames, fps) ? " (how the scene ends, just before the cut)" : ""}: ${t.toFixed(1)} s into the scene${near.length ? `, as the voice says "${near.map((w) => w.text).join(" ")}" (@${near[0]!.i}..@${near.at(-1)!.i})` : ""}.`,
      `On screen: ${wordsOnScreen(things).map((w) => `"${w}"`).join(", ") || "no words"}.`,
      ...findings.map((f) => `Measured: ${f.note}.`),
      frameReadings(scene, viewing, frame, { things: 3 }),
    ];
    return { frame, file: files[k]!, text: lines.filter(Boolean).join("\n") };
  });
}

/** A still this early shows how the scene opens; one this late shows how it ends. */
export const opensAt = (frame: number, fps: number) => frame <= fps;
export const endsAt = (frame: number, frames: number, fps: number) => frame >= frames - Math.round(fps * 1.5);

/**
 * The scene with its pictures inlined, for stills: a scene loads its pictures from the job's folder, which the final
 * render serves, but stills are rendered without it. Each picture goes in as a small data URL (a JPEG, or a PNG for a
 * see-through cut-out), made once and kept beside it. ffmpeg makes them without blocking the service.
 */
export async function forStills(scene: Scene, root: string | undefined): Promise<Scene> {
  if (!root) return scene;
  const cache = new Map<string, Promise<string>>();
  const inline = (src: string): Promise<string> | string => {
    if (!src || /^(https?:|data:|blob:|\/)/.test(src)) return src;
    if (!cache.has(src)) {
      const file = join(root, src);
      const png = /\.png$/i.test(src);
      const out = `${file}.still.${png ? "png" : "jpg"}`;
      cache.set(src, (async () => {
        if (!existsSync(out)) await ffmpeg(["-y", "-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale='min(1080,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease", ...(png ? [] : ["-q:v", "4"]), "-update", "1", out]);
        return `data:image/${png ? "png" : "jpeg"};base64,${readFileSync(out).toString("base64")}`;
      })());
    }
    return cache.get(src)!;
  };
  const nodes = await Promise.all(scene.nodes.map(async (n) => (n.kind === "image" && typeof n.props.src === "string" ? { ...n, props: { ...n.props, src: await inline(n.props.src) } } : n)));
  const tracks = await Promise.all(scene.tracks.map(async (t) => (t.prop === "src" ? { ...t, keys: await Promise.all(t.keys.map(async (k) => (typeof k.value === "string" ? { ...k, value: await inline(k.value) } : k))) } : t)));
  return { ...scene, nodes, tracks };
}

export const jpegBase64 = (file: string) => readFileSync(file).toString("base64");
export const stillsFolder = (folder: string, sceneId: string) => join(folder, "stills", sceneId);
export type { BuildOptions };

export interface Strip {
  /** One JPEG of the frames in order, left to right and down, six a row. */
  file: string;
  /** A line per frame, in the same order: its time, what the voice says then, what is on screen, and what changed. */
  lines: string[];
  /** Stretches where nothing on screen arrives, leaves, moves or resizes, with the words said over them. */
  still: string[];
}

/**
 * The scene over time, as a strip of small frames from one moment to another at an even step, each with what the voice
 * says then and whether anything on screen changed since the frame before, so a stretch where the picture stands still
 * under the voice, or a thing that arrives before or after its word, can be seen.
 */
export async function stripOf(c: SceneContext, built: Built & { scene: Scene }, from: number, to: number, folder: string): Promise<Strip> {
  const scene = built.scene;
  const fps = scene.fps;
  const first = Math.max(0, Math.min(scene.frames - 1, Math.round(from * fps)));
  const last = Math.max(first, Math.min(scene.frames - 1, Math.round(to * fps)));
  const count = Math.min(18, Math.max(2, Math.round((last - first) / fps / 0.5) + 1));
  const frames = [...new Set(Array.from({ length: count }, (_, i) => Math.round(first + ((last - first) * i) / (count - 1))))];
  const files = await renderStills(await forStills(scene, c.assets?.root), built.theme, frames, folder, 0.2);
  const look = (f: number) => inventory(scene, f).filter((t) => t.opacity > 0.1).map((t) => `${t.id}:${[t.box.x0, t.box.y0, t.box.x1, t.box.y1].map((v) => Math.round(v / 6)).join(",")}:${Math.round(t.opacity * 5)}:${t.text ?? ""}`).sort().join("|");
  const saidAt = (t: number) => c.timing.words.map((w, i) => ({ ...w, i })).filter((w) => w.start <= t && w.end + 0.25 >= t);
  const holdAt = (t: number) => (c.timing.holds ?? []).find((h) => t >= h.start && t < h.start + h.seconds);
  const lines: string[] = [];
  const still: string[] = [];
  let since: { at: number; words: string[] } | undefined;
  let before = "";
  for (const [k, f] of frames.entries()) {
    const t = f / fps;
    const now = look(f);
    const same = k > 0 && now === before;
    const said = saidAt(t);
    const hold = holdAt(t);
    const words = said.map((w) => `@${w.i} "${w.text}"`);
    lines.push(`${k + 1}. ${t.toFixed(1)} s: ${hold ? `pause @${hold.id}` : words.length ? words.join(" ") : "between words"}; ${k === 0 ? "first frame" : same ? "nothing changed" : "changed"}; on screen: ${wordsOnScreen(inventory(scene, f)).map((w) => `"${w.slice(0, 24)}"`).join(", ") || "no words"}.`);
    if (same) {
      since ??= { at: frames[k - 1]! / fps, words: [] };
      since.words.push(...said.map((w) => w.text));
    }
    if ((!same || k === frames.length - 1) && since) {
      const end = same ? t : frames[k - 1]! / fps;
      if (end - since.at >= 1.5) still.push(`${since.at.toFixed(1)} to ${end.toFixed(1)} s nothing on screen changes${since.words.length ? `, while the voice says "${[...new Set(since.words)].join(" ")}"` : ""}`);
      since = undefined;
    }
    before = now;
  }
  const file = join(folder, "strip.jpg");
  // Tiles keep the frame's shape: 216 pixels wide, and as tall as the frame is for that width, with a thin border.
  const tw = 216;
  const th = Math.round((tw * c.frame.height) / c.frame.width / 2) * 2;
  const [cw, ch] = [tw + 6, th + 6];
  const cols = Math.min(6, files.length);
  const rows = Math.ceil(files.length / cols);
  const fill = rows * cols - files.length;
  const tiles = files.map((_, i) => `[${i}:v]scale=${tw}:${th},pad=${cw}:${ch}:3:3:color=gray[t${i}]`);
  const blanks = Array.from({ length: fill }, (_, i) => `color=c=black:s=${cw}x${ch}:d=1[b${i}]`);
  const inputs = [...files.map((_, i) => `[t${i}]`), ...Array.from({ length: fill }, (_, i) => `[b${i}]`)];
  const layout = inputs.map((_, i) => `${(i % cols) * cw}_${Math.floor(i / cols) * ch}`).join("|");
  const graph = [...tiles, ...blanks, `${inputs.join("")}xstack=inputs=${inputs.length}:layout=${layout}[out]`].join(";");
  await runFile("ffmpeg", ["-y", "-v", "error", ...files.flatMap((x) => ["-i", x]), "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "5", file]);
  return { file, lines, still };
}
