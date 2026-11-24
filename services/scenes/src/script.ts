/**
 * The script of one video, as the agent writes it beat by beat with `write_beat`, and the checks code can make on it before any
 * scene is drawn: every scene is grounded in a passage, word for word; lengths stay inside Open Sourcebook's limits; and each scene's
 * narration is numbered word by word, so the agent can time what it draws to the words (`@N` in the scene language).
 */

import { labelReader } from "../../../common/labels.ts";

export interface Passage {
  id: string;
  /** The short label the caller's own writers cite it by (P3), when it has one: a word the viewer never sees either. */
  label?: string;
  sourceId: string;
  sourceTitle: string;
  locator?: string;
  text: string;
}

export interface Limits {
  minScenes: number;
  maxScenes: number;
  /** Per scene. */
  narrationMaxChars: number;
  visualMinChars: number;
  visualMaxChars: number;
  /** Entries of on-screen text per scene. */
  onScreenTextMax: number;
  /** Characters of one entry of on-screen text. */
  onScreenChars: number;
  /** Cites a scene. */
  cites: number;
  /** Characters of one quote. */
  quoteChars: number;
}

/**
 * Sensible defaults for a short video of drawn scenes. Open Sourcebook's own checker allows more (up to 60 scenes, 1,200 characters
 * of narration a scene); a caller passes its numbers in `limits` and they win.
 */
export const DEFAULT_LIMITS: Limits = { minScenes: 2, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4, onScreenChars: 120, cites: 4, quoteChars: 300 };
/** Limits a caller does not change. */
export const FIXED = { titleChars: 140, ideaChars: 400, minWords: 4, maxSceneSeconds: 60 };

export function readLimits(value: unknown): Limits {
  const out = { ...DEFAULT_LIMITS };
  if (typeof value !== "object" || value === null) return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  if (out.maxScenes < out.minScenes) out.maxScenes = out.minScenes;
  return out;
}

export interface Cite {
  passageId: string;
  quote: string;
}

export interface ScriptScene {
  id: string;
  narration: string;
  onScreenText: string[];
  visual: string;
  cites: Cite[];
  /** The words the captions light as they are said: the agent's pick, words of this scene's narration. */
  emphasis?: string[];
  /** Where the voice waits for the picture: silences after a word, in seconds. */
  pauses?: Pause[];
}

export interface Pause {
  /** The word (from 0) the silence comes after. */
  afterWord: number;
  seconds: number;
}

export interface Script {
  title: string;
  idea: string;
  style?: string;
  styleWhy?: string;
  scenes: ScriptScene[];
}

/** The words a scene's narration is spoken as, in order; `@N` in a scene is the N-th of these, from 0. */
export function wordsOf(narration: string): string[] {
  return narration.trim().split(/\s+/).filter(Boolean);
}

/** `@0 The @1 pivot …`: a scene's words with the number a scene moment uses for each. */
export function numberedWords(narration: string): string {
  return wordsOf(narration).map((w, i) => `@${i} ${w}`).join(" ");
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** A word as the captions compare it: lower case, letters and digits only. */
const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Reads a whole script at once (a revise round's draft, a fixture). Problems are in words the agent can act on; none means it is accepted. */
export function checkScript(input: unknown, passages: Passage[], limits: Limits, styles: string[]): { script?: Script; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (typeof input !== "object" || input === null) return { problems: ["Send { title, idea, scenes: [...] }."], notes };
  const raw = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const title = text(raw.title);
  const idea = text(raw.idea);
  if (!title) problems.push("title: give the video a title.");
  else if (title.length > FIXED.titleChars) problems.push(`title: ${title.length} characters; at most ${FIXED.titleChars}.`);
  if (!idea) problems.push("idea: say in one or two sentences what the viewer should understand by the end.");
  else if (idea.length > FIXED.ideaChars) problems.push(`idea: ${idea.length} characters; at most ${FIXED.ideaChars}.`);
  const style = text(raw.style);
  if (style && !styles.includes(style)) problems.push(`style: "${style}" is not one of ${styles.join(", ")}.`);
  const list = Array.isArray(raw.scenes) ? raw.scenes : [];
  if (list.length < limits.minScenes || list.length > limits.maxScenes) problems.push(`scenes: ${list.length}; write ${limits.minScenes} to ${limits.maxScenes}.`);
  const beats = list.map((_, i) => `s${i + 1}`);
  const scenes: ScriptScene[] = list.map((item, i): ScriptScene => checkScene(item, `scene ${i + 1}`, `s${i + 1}`, passages, limits, problems, notes, beats));
  if (problems.length) return { problems, notes };
  return { notes, script: { title, idea, ...(style ? { style } : {}), ...(text(raw.styleWhy) ? { styleWhy: text(raw.styleWhy) } : {}), scenes }, problems: [] };
}

/**
 * Reads one scene (a beat) as the agent sent it, adding what is wrong to `problems` and what it should know to `notes`.
 * The narration may carry pauses, `[pause 1.5]` (seconds, 1 when none are given), where the voice waits for the
 * picture: they are taken out of the words and kept as `pauses`, after the word before them.
 */
export function checkScene(item: unknown, at: string, id: string, passages: Passage[], limits: Limits, problems: string[], notes: string[], beats: string[] = [id]): ScriptScene {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const byId = new Map(passages.map((p) => [p.id, p]));
  const s = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
  const { narration, pauses, wrong } = readPauses(squash(text(s.narration)));
  problems.push(...wrong.map((w) => `${at}: ${w}`));
  const visual = squash(text(s.visual));
  const onScreenText = (Array.isArray(s.onScreenText) ? s.onScreenText : []).map(text).filter(Boolean);
  const words = wordsOf(narration).length;
  if (words < FIXED.minWords) problems.push(`${at}: narration has ${words} words; a scene says at least ${FIXED.minWords}.`);
  if (narration.length > limits.narrationMaxChars) problems.push(`${at}: narration is ${narration.length} characters; at most ${limits.narrationMaxChars}. Split it into two scenes or cut it.`);
  // About 2.4 spoken words a second; a scene longer than a minute is two scenes.
  if (words / 2.4 > FIXED.maxSceneSeconds) problems.push(`${at}: about ${Math.round(words / 2.4)} s of speech; a scene lasts at most ${FIXED.maxSceneSeconds} s.`);
  if (visual.length < limits.visualMinChars || visual.length > limits.visualMaxChars) problems.push(`${at}: visual is ${visual.length} characters; say what is on screen in ${limits.visualMinChars} to ${limits.visualMaxChars}.`);
  if (onScreenText.length > limits.onScreenTextMax) problems.push(`${at}: onScreenText has ${onScreenText.length} entries; at most ${limits.onScreenTextMax}. Keep the ${limits.onScreenTextMax} a viewer most needs (you sent ${onScreenText.map((t) => `"${t.slice(0, 30)}"`).join(", ")}).`);
  for (const t of onScreenText) if (t.length > limits.onScreenChars) problems.push(`${at}: on-screen text "${t.slice(0, 40)}…" is ${t.length} characters; at most ${limits.onScreenChars}.`);
  // Open Sourcebook's one label check (common/labels.ts), the same the engine applies to the finished video.
  const leaks = labelsIn(passages, beats)(`${narration}\n${onScreenText.join("\n")}`);
  if (leaks.length) problems.push(`${at}: narration or on-screen text points at what only you were given: ${leaks.map((l) => `"${l}"`).join(", ")}. The viewer never sees passages, their ids or beat ids; say what the source says instead.`);
  const cites = (Array.isArray(s.cites) ? s.cites : []).map((c): Cite => {
    const cite = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    return { passageId: text(cite.passageId), quote: squash(text(cite.quote)) };
  });
  if (!cites.length) problems.push(`${at}: cite at least one passage this scene stands on, with a quote copied from it word for word.`);
  if (cites.length > limits.cites) problems.push(`${at}: ${cites.length} cites; at most ${limits.cites}.`);
  for (const c of cites) {
    const passage = byId.get(c.passageId);
    if (!passage) problems.push(`${at}: there is no passage "${c.passageId}" (they are ${[...byId.keys()].join(", ")}).`);
    else if (!c.quote) problems.push(`${at}: the cite of ${c.passageId} has no quote.`);
    else if (c.quote.length > limits.quoteChars) problems.push(`${at}: a quote from ${c.passageId} is ${c.quote.length} characters; at most ${limits.quoteChars}.`);
    else if (!squash(passage.text).includes(c.quote)) problems.push(`${at}: the quote "${c.quote.slice(0, 60)}${c.quote.length > 60 ? "…" : ""}" is not word for word in ${c.passageId}. Copy it exactly from read_passages (only spaces may differ).`);
  }
  // Key words for the captions: kept when the narration says them, so a stray pick never lights nothing.
  const said = new Set(wordsOf(narration).map(plain));
  const asked = (Array.isArray(s.emphasis) ? s.emphasis : []).map(text).filter(Boolean);
  const emphasis = asked.filter((e) => e.split(/\s+/).every((w) => said.has(plain(w))));
  if (emphasis.length < asked.length) notes.push(`${at}: caption key words not in its narration, so not lit: ${asked.filter((e) => !emphasis.includes(e)).map((e) => `"${e}"`).join(", ")}.`);
  return { id, narration, onScreenText, visual, cites, ...(emphasis.length ? { emphasis } : {}), ...(pauses.length ? { pauses } : {}) };
}

const readers = new WeakMap<Passage[], Map<string, (text: string) => string[]>>();

/**
 * The label check for one video's passages and beats: the ids (and labels) of its passages and its beat ids are what
 * only the writer saw; the passages' text is the person's own words. Read once per set of passages and beats.
 */
function labelsIn(passages: Passage[], beats: string[]): (text: string) => string[] {
  let byBeats = readers.get(passages);
  if (!byBeats) readers.set(passages, (byBeats = new Map()));
  const key = beats.join(" ");
  let reader = byBeats.get(key);
  if (!reader) {
    reader = labelReader([...passages.flatMap((p) => [p.id, ...(p.label ? [p.label] : [])]), ...beats], passages.map((p) => p.text).join("\n"));
    byBeats.set(key, reader);
  }
  return reader;
}

/** Takes `[pause N]` out of a narration: the words as spoken, and each pause after the word before it. */
export function readPauses(said: string): { narration: string; pauses: Pause[]; wrong: string[] } {
  const words: string[] = [];
  const pauses: Pause[] = [];
  const wrong: string[] = [];
  for (const part of said.split(/(\[pause(?:\s+[^\]]*)?\])/i)) {
    const m = /^\[pause(?:\s+([^\]]*))?\]$/i.exec(part);
    if (!m) {
      words.push(...wordsOf(part));
      continue;
    }
    const seconds = m[1] === undefined ? 1 : Number(m[1].replace(/s(ec(onds?)?)?$/i, "").trim());
    if (!Number.isFinite(seconds) || seconds <= 0) wrong.push(`"${part}" is not a pause: write [pause 1.5] with the seconds it lasts.`);
    else if (!words.length) wrong.push(`"${part}" comes before any word; a scene opens on its first word, so put the picture's time before it in the scene before.`);
    else pauses.push({ afterWord: words.length - 1, seconds: Math.round(seconds * 100) / 100 });
  }
  return { narration: words.join(" "), pauses, wrong };
}

/** The narration as the agent writes it: its words with its pauses in place. */
export function withPauses(scene: Pick<ScriptScene, "narration" | "pauses">): string {
  const words = wordsOf(scene.narration);
  const after = new Map((scene.pauses ?? []).map((p) => [p.afterWord, p.seconds]));
  return words.map((w, i) => (after.has(i) ? `${w} [pause ${after.get(i)}]` : w)).join(" ");
}
