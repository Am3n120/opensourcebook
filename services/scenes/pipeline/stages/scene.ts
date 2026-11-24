// The scene step's pure parts: the build context and options, the
// section checks (range, hand-off, direction), what code can see about a built part, the instruments over a part, the
// viewing, and stills. What used to call a model here (writing, looking, judging, taste, repair rounds, the depicter, the
// cast pass) is left behind; in Open Sourcebook the person's own agent does that work through the tools in src/tools.ts.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoPhase, DirectionEvent, Project } from "../../schemas/project.ts";
import { when } from "../../engine/core/compile.ts";
import { bundled } from "../../engine/render/bundle.ts";
import { evaluate } from "../../engine/core/evaluate.ts";
import type { CompileContext, Kit, Resolved, Scene, Theme } from "../../engine/core/types.ts";
import { KITS } from "../../engine/kits/index.ts";
import { mathKit } from "../../engine/kits/math.ts";
import { stepLines } from "../../engine/kits/steps.ts";
import { numbered, reviewText, truthKinds } from "../../engine/language/author.ts";
import { build, measureLines, type BuildOptions, type BuildResult } from "../../engine/language/build.ts";
import { expandHolds, holdMoments, type HoldTime } from "../../engine/language/holds.ts";
import { loadLibrary } from "../../engine/language/library.ts";
import { fontMeasure } from "../../engine/language/measure.ts";
import { parse, type Item, type State } from "../../engine/language/syntax.ts";
import { themeFrom } from "../../engine/render/theme.ts";
import { toolboxKit, type Toolbox } from "../../engine/language/toolbox.ts";
import { partNotes, type PartNotes } from "../lib/instrument-notes.ts";
import { suggestViewing, viewingFrom } from "../../engine/design/suggest.ts";
import type { Viewing } from "../../engine/design/types.ts";

const FPS = 30;
const [WIDTH, HEIGHT] = [1080, 1920];
export const MAX_PROBLEMS = 25;

export type Range = { id: string; firstWord: number; lastWord: number };
// A thing one section hands to the next: what it is, the ids of its pieces (so they stay the same things on screen rather
// than being drawn again), and how the next section builds on it.
export type Carry = { id: string; what: string; parts?: string[]; use?: string };

// Ids a state names directly: its items, everything inside them, and their atoms.
function named(items: Item[], into = new Set<string>()): Set<string> {
  for (const i of items) {
    into.add(i.id);
    for (const part of i.parts ?? []) for (const a of part.type === "text" ? [part.atom] : part.type === "frac" ? [...part.num, ...part.den] : part.rows.flat()) into.add(a.id);
    named(i.children, into);
  }
  return into;
}

// What code can check about a section against its range and its handoffs, before and after the engine builds it.
export function contract(source: string, range: Range, carry: Carry[], kitKinds: string[] = []): string[] {
  const { doc } = parse(source, kitKinds);
  const out: string[] = [];
  const first = doc.states[0];
  if (!first) return [`Your part has no states. Start it with a plain state at @${range.firstWord}.`];
  if (first.at.word !== range.firstWord || first.at.offset < 0) out.push(`line ${first.line}: your first state must be @${range.firstWord}, the first word of your part.`);
  if (first.keep) out.push(`line ${first.line}: your first state must be a plain state, not keep, so your part stands on its own; list everything that is on screen.`);
  for (const s of doc.states) if (s.at.word < range.firstWord || s.at.word > range.lastWord) out.push(`line ${s.line}: @${s.at.word} is outside your part; every state starts on a word from ${range.firstWord} to ${range.lastWord}.`);
  const shown = named(first.items);
  for (const c of carry) {
    if (!shown.has(c.id)) out.push(`line ${first.line}: the part before yours leaves ${c.id} (${c.what}) on screen. If your first words build on it, list it in your first state with the id ${c.id}, so it stays rather than being drawn again; if they do not, it leaves as your part begins.`);
    else if (c.parts?.length) {
      const missing = c.parts.filter((x) => !shown.has(x));
      if (missing.length) out.push(`line ${first.line}: you keep ${c.id}, but not its pieces ${missing.join(", ")}, so the viewer sees them drawn again. Give its pieces the ids ${c.parts.join(", ")}, as the part before yours does.`);
    }
  }
  return out;
}

// Whether a contract line is about a carried thing the part left out, which is the writer's call, not a mistake.
const leftOut = (x: string) => x.includes("the part before yours leaves");

// Every id visible at a frame, through the whole tree, so a hand-off can be checked on the built scene.
export function visibleAt(scene: Scene, frame: number): Set<string> {
  const out = new Set<string>();
  const walk = (list: Resolved[], opacity: number) => {
    for (const n of list) {
      const o = opacity * Number(n.props.opacity ?? 1);
      if (o <= 0.05) continue;
      out.add(n.id);
      walk(n.children, o);
    }
  };
  walk(evaluate(scene, frame), 1);
  return out;
}

// Checks that what the next section expects is on screen as this one ends. A line or arrangement counts when any of
// what it holds is visible.
function handedOver(source: string, scene: Scene, frame: number, handoff: Carry[], range: Range, kitKinds: string[]): string[] {
  if (!handoff.length) return [];
  const { doc } = parse(source, kitKinds);
  const members = new Map<string, Set<string>>();
  const index = (items: Item[]) => {
    for (const i of items) {
      members.set(i.id, named([i]));
      index(i.children);
    }
  };
  doc.states.forEach((s: State) => index(s.items));
  const seen = visibleAt(scene, frame);
  const visible = (id: string) => [...(members.get(id) ?? new Set([id]))].some((m) => seen.has(m) || [...seen].some((v) => v.startsWith(`${m}.`)));
  return handoff.flatMap((c) => {
    if (!visible(c.id)) return [`The next part picks up ${c.id} (${c.what}), but it is not on screen when your last word, ${range.lastWord}, is spoken. Have it on screen with that id by then.`];
    const missing = (c.parts ?? []).filter((x) => !visible(x));
    return missing.length ? [`The next part picks up ${c.id} with its pieces ${c.parts!.join(", ")}, but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not on screen with ${missing.length > 1 ? "those ids" : "that id"} as your last word is spoken. Give its pieces those ids.`] : [];
  });
}

// Things that stay over full-frame pictures through picture after picture: a heading or list left on top stops being
// read and hides the pictures. Measured on the built scene, so it sees what the viewer sees. Feedback, not a rule.
export function overPictures(source: string, scene: Scene, from: number, to: number, kitKinds: string[] = [], fps = FPS): string[] {
  const { doc } = parse(source, kitKinds);
  const fills = new Set<string>();
  const tops = new Map<string, number>();
  const walk = (items: Item[], top: boolean) => {
    for (const i of items) {
      if (i.attrs.frame === "fill" && i.kind === "image") fills.add(i.id);
      else if (i.attrs.frame === "fill") continue; // a field of color behind everything is a backdrop, not something on top
      else if (top && i.kind !== "image" && i.kind !== "space" && !tops.has(i.id)) tops.set(i.id, i.line);
      walk(i.children, false);
    }
  };
  for (const s of doc.states) walk(s.items, true);
  if (!fills.size || !tops.size) return [];
  const step = Math.max(1, Math.round(fps / 2));
  const over = new Map<string, { frames: number; pictures: Set<string> }>();
  for (let f = from; f <= to; f += step) {
    const seen = visibleAt(scene, f);
    const pics = [...fills].filter((id) => seen.has(id));
    if (!pics.length) continue;
    for (const id of tops.keys()) {
      if (!seen.has(id) && ![...seen].some((v) => v.startsWith(`${id}.`))) continue;
      const o = over.get(id) ?? { frames: 0, pictures: new Set<string>() };
      o.frames += step;
      pics.forEach((x) => o.pictures.add(x));
      over.set(id, o);
    }
  }
  return [...over].filter(([, o]) => o.pictures.size >= 2 && o.frames / fps >= 6).map(([id, o]) => `${id} (line ${tops.get(id)}) stays over the full-frame pictures for ${Math.round(o.frames / fps)} s, across ${[...o.pictures].join(", ")}. Over a picture that fills the frame, the picture is the subject. If the words are no longer about ${id}, drop it when the picture changes, or bring it back when they return to it.`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Building: the same context and options for checking a section, the whole scene, and the player.

// Real math typesetting joins the scene's kits here, with the guide line a writer needs, so a formula is set for real
// rather than typed as characters. Its part behaviors work through `do` now that kits expand in compile's context.
const mathFormulas: Kit = {
  name: "math",
  kinds: mathKit.kinds,
  behaviors: mathKit.behaviors,
  docs: {
    math: "`math f latex=\"\\bar{x} = \\frac{1}{n}\\sum x_i\"` real typeset math from LaTeX, as in a good textbook: fractions, roots that reach over what they cover, bars and hats, sums, powers and indices, matrices. Write each backslash once. Every symbol is its own part, and the whole formula can be lit, tagged, ringed, marked and moved like any thing. Give it a role, as words take (role=answer for a result), and it takes that role's color and the style's hand. To change a formula, repeat its line with the same id and new latex, and it changes in place. For a derivation, give `states=[\"...\",\"...\"]` and step through them with `do become f state=N`: symbols that stay travel to their new places",
    become: "`do become f state=1 frames=20`: a formula with `states=` moves to that state; matching symbols travel, the rest appear or fade",
    each: "`do each f part=frac.0.num color=accent stagger=4`: recolor, fade (opacity=) or nudge (dx= dy=) every symbol of a named part at once. Parts: word.N, line.N, frac.N.num, frac.N.den, matrix.N.row.R, matrix.N.col.C, char.X",
    swell: "`do swell f part=matrix.0.col.1 size=1.2`: a set of symbols swells and settles together, to point at it",
  },
};
export const SCENE_KITS: Kit[] = [...KITS, mathFormulas];

// With a toolbox, the language also draws things as themselves (`depict`, `do change`, `do act`) from the depictions in
// it, so every build of the same scene draws the same things.
export function sceneContext(p: Project, theme: Theme = themeFrom(p.input.style), toolbox?: Toolbox): CompileContext {
  const words = p.narration!.words.map((w) => ({ text: w.text, start: w.start }));
  const [width, height] = p.input.frame ?? [WIDTH, HEIGHT];
  return { fps: FPS, width, height, frames: Math.ceil((p.narration!.seconds + 0.5) * FPS), theme, words, kits: toolbox ? [...SCENE_KITS, toolboxKit(toolbox)] : SCENE_KITS };
}

// Build options for this project's scene. `assets` maps asset names to an image source the renderer can load.
// Words are measured in the style's real fonts, so what is laid out is what the renderer draws.
export function sceneBuildOptions(p: Project, assets: Record<string, string> = {}, toolbox?: Toolbox): BuildOptions {
  const ctx = sceneContext(p, themeFrom(p.input.style), toolbox);
  return { ctx, words: p.narration!.words.map((w) => w.text), assets, library: loadLibrary(), seed: 11, measure: fontMeasure(ctx.theme), holds: holdsOf(p) };
}

// The silences the voice left, as the language reads them.
export const holdsOf = (p: Project): HoldTime[] => (p.narration?.holds ?? []).map((h) => ({ id: h.id, afterWord: h.afterWord, start: h.start, seconds: h.seconds }));

// A section with its hold moments written as word moments, which is how it is stored, joined and read by later steps.
export function plainMoments(source: string, opts: BuildOptions): string {
  return expandHolds(source, holdMoments(opts.holds, opts.ctx)).source;
}


export const kitKinds = () => [...SCENE_KITS.flatMap((k) => Object.keys(k.kinds ?? {})).filter((k) => k !== "graph"), "depict"];

// ---------------------------------------------------------------------------------------------------------------------
// Stills: one bundle and one browser for the whole stage, a few renders at a time.

type Renderer = { serveUrl: string; browser: any; close: () => Promise<void> };
let renderer: Promise<Renderer> | undefined;
let slots = 2;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (slots <= 0) await new Promise<void>((r) => waiting.push(r));
  slots--;
  try {
    return await fn();
  } finally {
    slots++;
    waiting.shift()?.();
  }
}

function openRenderer(): Promise<Renderer> {
  renderer ??= (async () => {
    const { openBrowser } = await import("@remotion/renderer");
    const serveUrl = await bundled(join(import.meta.dirname, "../../engine/render/preview.tsx"));
    const browser = await openBrowser("chrome", { browserExecutable: process.env.OPENSOURCEBOOK_CHROME ?? null, chromiumOptions: { gl: "angle" } });
    return { serveUrl, browser, close: () => browser.close({ silent: true }) };
  })();
  // A browser that failed to start (a slow machine, a timeout) is tried again on the next still, not kept as failed.
  const opening = renderer;
  opening.catch(() => {
    if (renderer === opening) renderer = undefined;
  });
  return renderer;
}

export async function closeRenderer() {
  if (!renderer) return;
  const r = await renderer;
  renderer = undefined;
  await r.close();
}

// Renders frames of a built scene as small JPEGs and returns their paths.
export async function renderStills(scene: Scene, theme: Theme, frames: number[], folder: string, scale = 0.4): Promise<string[]> {
  const { renderStill, selectComposition } = await import("@remotion/renderer");
  const r = await openRenderer();
  mkdirSync(folder, { recursive: true });
  const inputProps = { scene, theme };
  return slot(async () => {
    const composition = await selectComposition({ serveUrl: r.serveUrl, id: "Scene", inputProps, puppeteerInstance: r.browser });
    const out: string[] = [];
    for (const frame of frames) {
      const file = join(folder, `${String(frame).padStart(5, "0")}.jpg`);
      await renderStill({ serveUrl: r.serveUrl, composition, inputProps, frame, imageFormat: "jpeg", jpegQuality: 80, scale, output: file, puppeteerInstance: r.browser });
      out.push(file);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing one section: build, repair from errors, then look at stills and repair from what Spark sees.
export type Job = {
  p: Project;
  range: Range;
  next?: Range;
  carry: Carry[];
  handoff: Carry[];
  system: string;
  request: string;
  opts: BuildOptions; // assets here are loadable sources, for stills
  folder: string;
  log: (line: string) => void;
};

const endFrame = (job: Job) => (job.next ? when({ word: job.next.firstWord }, job.opts.ctx) - 2 : job.opts.ctx.frames - 1);

export type Checked = { result: BuildResult; problems: string[]; warnings: string[]; notes: string[] };

export async function check(job: Job, written: string): Promise<Checked> {
  const kinds = kitKinds();
  const result = await build(written, job.opts);
  const source = plainMoments(written, job.opts);
  const built = result.problems.map((p) => (p.line ? `line ${p.line}: ${p.message}` : p.message));
  const shape = contract(source, job.range, job.carry, kinds);
  // Ranges and plain first states keep the join sound, so they must be fixed. What the next part was promised goes back
  // for repair too, but a part that still misses it is reported, not failed. Leaving out a carried thing is the
  // writer's call (its words may have moved on), so it is only recorded.
  const handoff = result.scene ? handedOver(source, result.scene, endFrame(job), job.handoff, job.range, kinds) : [];
  const carry = shape.filter((x) => !leftOut(x) && x.includes("you keep"));
  // What the direction asks of this stretch that code can check: withheld things declared, and a demonstration of
  // computed steps played by the thing that computes them. Both go back for repair; a part that still misses a
  // demonstration is reported rather than failed, as a hand-off is.
  const direction = directed(source, job.p, job.range, kinds);
  return { result, problems: [...built, ...shape.filter((x) => !leftOut(x) && !carry.includes(x)), ...direction.withholds, ...direction.truth], warnings: [...carry, ...handoff, ...direction.demos], notes: [...shape.filter(leftOut), ...needs(written)] };
}

// Lines a writer leaves when a hold is too short for what the direction asks of it: `# needs h2 6s: why`. They go to
// the section's notes, for the direction to lengthen the hold.
export const needs = (source: string): string[] => [...source.matchAll(/^\s*#\s*needs\s+([A-Za-z]\w*)\s+([\d.]+)\s*s\b:?\s*(.*)$/gm)].map((m) => `hold ${m[1]} too short: needs ${m[2]} s${m[3] ? `, ${m[3].trim()}` : ""}`);


// Events of the direction that share words with a range.
const eventsIn = (p: Project, range: Range): DirectionEvent[] => (p.direction?.events ?? []).filter((e) => e.lastWord >= range.firstWord && e.firstWord <= range.lastWord);

// Withholds whose stretch (from the event that sets it to the event it waits for) overlaps a range, with the word the
// thing may appear from.
export function withholdsIn(p: Project, range: Range): { event: DirectionEvent; what: string; until: string; word: number }[] {
  const events = p.direction?.events ?? [];
  return events.flatMap((e) => {
    if (!e.withhold) return [];
    const word = events.find((x) => x.id === e.withhold!.until)?.firstWord ?? (p.narration?.words.length ?? 0);
    return e.firstWord <= range.lastWord && word > range.firstWord ? [{ event: e, what: e.withhold.what, until: e.withhold.until, word }] : [];
  });
}

// The computed things the direction demonstrates, each one thing for the whole video with one id and one input. For a
// range: the line that makes it, how many of its steps are done as the range begins, and exactly the steps it plays.
// Parts are written at the same time, so this is how each knows where the demonstration stands.
export type TruthPart = { id: string; kind: string; line: string; steps: string[]; total: number; done: number; plays: { from: number; to: number; pace: string; event: string }[] };
const setting = (k: string, v: unknown) => `${k}=${typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`;
export function truthPlan(p: Project, range: Range): TruthPart[] {
  const events = p.direction?.events ?? [];
  const holdWord = new Map(events.flatMap((e) => (e.holds ?? []).map((h) => [h.id, h.afterWord] as const)));
  const startOf = (ph: DemoPhase, e: DirectionEvent) => ("word" in ph.at ? ph.at.word : holdWord.get(ph.at.hold) ?? e.firstWord);
  const things = new Map<string, TruthPart & { phases: { from: number; to: number; pace: string; event: string; word: number }[] }>();
  for (const e of events) {
    const t = e.demo?.truth;
    if (!t) continue;
    const key = `${t.kind} ${JSON.stringify(t.data)}`;
    if (!things.has(key)) {
      const id = `demo${things.size + 1}`;
      things.set(key, { id, kind: t.kind, line: `${t.kind} ${id} ${Object.entries(t.data).map(([k, v]) => setting(k, v)).join(" ")}`, steps: t.steps, total: t.steps.length, done: 0, plays: [], phases: [] });
    }
    for (const ph of e.demo!.phases) if (ph.steps) things.get(key)!.phases.push({ from: ph.steps[0], to: ph.steps[1], pace: ph.pace, event: e.id, word: startOf(ph, e) });
  }
  return [...things.values()].map(({ phases, ...t }) => ({
    ...t,
    // Where it stands as the range begins: after the steps played before it, or, in a video that opens partway through
    // a process, just before the first step any phase plays.
    done: Math.max(0, phases.length ? Math.min(...phases.map((ph) => ph.from)) - 1 : 0, ...phases.filter((ph) => ph.word < range.firstWord).map((ph) => ph.to)),
    plays: phases.filter((ph) => ph.word >= range.firstWord && ph.word <= range.lastWord).map(({ word: _w, ...ph }) => ph),
  }));
}

// Checks a part's computed things against the truth plan: the very same thing, standing where the parts before left it,
// playing exactly its own steps. A demonstration split across parts written at once only joins when each part does.
export function truthChecked(doc: ReturnType<typeof parse>["doc"], plan: TruthPart[]): string[] {
  const out: string[] = [];
  const items = new Map<string, Item>();
  const index = (list: Item[]) => list.forEach((i) => (items.has(i.id) || items.set(i.id, i), index(i.children)));
  doc.states.forEach((st) => index(st.items));
  const OWN = new Set(["at", "into", "before", "after", "done", "w", "h", "role", "follow", "enter"]);
  const input = (attrs: Record<string, string>) => Object.entries(attrs).filter(([k]) => !OWN.has(k)).map(([k, v]) => `${k}=${v}`).sort().join(" ");
  for (const t of plan) {
    const wanted = `${t.line}${t.done ? ` done=${t.done}` : ""}`;
    const expected = input(Object.fromEntries(t.line.split(/\s+/).slice(2).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1).replace(/^"(.*)"$/, "$1")])));
    const item = items.get(t.id);
    const others = [...items.values()].filter((i) => i.kind === t.kind && i.id !== t.id && input(i.attrs) === expected);
    for (const o of others) out.push(`line ${o.line}: ${o.id} is the computed thing the direction demonstrates, which is ${t.id} in every part of the video. Write it as \`${wanted}\`.`);
    const plays = doc.states.flatMap((st) => st.commands.flatMap((c) => (c.do === "play" && c.behavior === "steps" && c.targets.includes(t.id) ? [{ line: c.line, from: Number(c.attrs.from ?? 1), to: Number(c.attrs.to ?? t.total) }] : [])));
    const mine = t.plays.map((x) => `${x.from} to ${x.to} (${x.pace}, event ${x.event})`).join(", ");
    if (!item) {
      if (t.plays.length) out.push(`The direction plays steps ${mine} of ${t.id} in your part, but your part does not show it. Make it as \`${wanted}\` and play those steps with \`do steps ${t.id}\`.`);
      continue;
    }
    if (input(item.attrs) !== expected) out.push(`line ${item.line}: ${t.id} must be the very thing the other parts show, made with exactly \`${wanted}\` (you may add a place, a size, a role); other settings would make a different computation.`);
    if (Number(item.attrs.done ?? 0) !== t.done) out.push(`line ${item.line}: as your part begins, ${t.id} stands after step ${t.done}, which the parts before yours played. Write done=${t.done} on it${t.done ? "" : " or leave done= out"}, so it shows that state from your first frame.`);
    const want = new Set(t.plays.flatMap((x) => Array.from({ length: x.to - x.from + 1 }, (_, k) => x.from + k)));
    const got = new Set(plays.flatMap((x) => Array.from({ length: Math.max(0, x.to - x.from + 1) }, (_, k) => x.from + k)));
    const extra = [...got].filter((k) => !want.has(k));
    const missing = [...want].filter((k) => !got.has(k));
    if (extra.length || missing.length) out.push(`${plays.length ? `line ${plays[0]!.line}: ` : ""}your part must play exactly ${t.plays.length ? `steps ${mine}` : `no steps of ${t.id} (the parts around yours play them)`} of ${t.id}, one \`do steps ${t.id} from= to=\` per phase.${extra.length ? ` It plays ${extra.join(", ")}, which another part plays.` : ""}${missing.length ? ` It leaves out ${missing.join(", ")}.` : ""}`);
  }
  return out;
}

// Checks a part against its direction, from its source alone.
export function directed(source: string, p: Project, range: Range, kitKindList: string[] = kitKinds()): { withholds: string[]; demos: string[]; truth: string[] } {
  if (!p.direction?.events?.length) return { withholds: [], demos: [], truth: [] };
  const { doc } = parse(source, kitKindList);
  const withholds = withholdsIn(p, range).flatMap((w) => doc.withholds.some((d) => d.until.word >= w.word) ? [] : [`The direction withholds ${w.what} until event ${w.until}, at word ${w.word}, and your part comes before it. Name the ids in your part that show it with \`withhold IDS until=@${w.word}\`, so the engine keeps them off screen until then; if nothing in your part shows it, write \`withhold none until=@${w.word}\`.`]);
  const truth = new Set(truthKinds(SCENE_KITS));
  const kinds = new Map<string, string>();
  const index = (items: Item[]) => items.forEach((i) => (kinds.set(i.id, i.kind), index(i.children)));
  doc.states.forEach((s) => index(s.items));
  const played = doc.states.some((s) => s.commands.some((c) => c.do === "play" && c.behavior === "steps" && c.targets.some((t) => truth.has(kinds.get(t) ?? ""))));
  const demos = eventsIn(p, range).flatMap((e) => (e.demo?.phases.some((ph) => ph.steps) && !played ? [`The direction demonstrates ${e.demo.what} in event ${e.id} as phases of computed steps, but your part plays no steps of a truth thing. Show it with the kit that computes it (${[...truth].map((k) => `\`${k}\``).join(", ")}) and one \`do steps\` per phase, so every step and every label is right; draw it by hand only if no kit computes what the words describe.`] : []));
  return { withholds, demos, truth: truthChecked(doc, truthPlan(p, range)) };
}

// What code can see about a built part beyond errors: computed steps to bind, and craft notes the writer weighs.
export function review(job: Job, written: string, result: BuildResult): string {
  const kinds = kitKinds();
  const source = plainMoments(written, job.opts);
  const from = when({ word: job.range.firstWord }, job.opts.ctx);
  const extra = result.scene ? overPictures(source, result.scene, from, endFrame(job), kinds) : [];
  // What the part's programs measured against what they claim to prove: numbers for the writer to read, never a verdict.
  const measures = measureLines(result, job.opts.ctx.fps);
  // When each computed step really played, against the words spoken then, so a step that runs ahead of its words is seen.
  const steps = result.scene ? stepLines(result.scene.events, job.p.narration!.words.map((w) => ({ text: w.text, start: w.start })), job.opts.ctx.fps) : [];
  return reviewText(source, result, { kitKinds: kinds, truthKinds: truthKinds(SCENE_KITS), math: kinds.includes("math"), extra: [...extra, ...measures, ...steps] });
}

// What goes back to the writer: a part with build problems, and a part that builds with what code can see about it.
const PROMPTS = join(import.meta.dirname, "../../prompts");
export const prompt = (name: string) => readFileSync(join(PROMPTS, `${name}.md`), "utf8");
export const repairRequest = (job: Job, src: string, list: string[]) => `${job.request}\n\nYour part, with line numbers added for reference. Do not include the numbers:\n${numbered(src)}\n\n${prompt("engine-repair")}\nProblems:\n${list.slice(0, MAX_PROBLEMS).join("\n")}`;

/** What the instruments read on a built part: its window of the video, the project's viewing, the words and silences. */
export function measurePart(job: Job, scene: Scene): PartNotes {
  const words = job.p.narration!.words.map((w) => ({ text: w.text, start: w.start, ...("end" in w && typeof w.end === "number" ? { end: w.end } : {}) }));
  const holds = (job.opts.holds ?? []).map((h) => ({ id: h.id, from: h.start, to: h.start + h.seconds }));
  return partNotes({ scene, words, viewing: projectViewing(job.p), window: [when({ word: job.range.firstWord }, job.opts.ctx), endFrame(job) + 1], holds });
}

// How the video is watched, as far as the project says: the frame, the screen and distance the user's request and plan
// imply (suggest.ts suggestViewing: lengths the words give, else a typical screen of the kind they name, else the
// frame's shape), and the captions the timeline burns in (video/Video.tsx: a band from 1640 to 1810 px of a 1920 px
// frame). Each number has its reason; the director confirms or replaces it.
export function projectViewing(p: Project): Viewing {
  const [width, height] = p.input.frame ?? [WIDTH, HEIGHT];
  const request = [p.input.prompt, p.plan?.intent, ...(p.plan?.story ?? []), ...(p.plan?.visuals ?? [])].filter(Boolean).join(". ");
  const sized = suggestViewing({ request }, width, height);
  return viewingFrom({
    width, height, fps: FPS,
    screen: sized.screen,
    frameWidthMm: sized.frameWidthMm,
    distanceMm: sized.distanceMm,
    watch: height > width ? "glancing in a feed (not stated)" : "watching on purpose (not stated)",
    captions: { show: true, box: [0, 1640 / 1920, 1, 1810 / 1920], why: "the timeline burns the narration in as captions" },
    why: `from the user's request and the project's frame: ${sized.why}`,
  });
}

