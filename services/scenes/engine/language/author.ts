// The scene language's guide for a writer, filled in with what this engine can really do, and the notes code can give
// a writer about a scene that builds. This file once also had a hosted model write a scene in rounds (`author`); that
// loop is left out: in Open Sourcebook the person's own agent writes, through the tools in src/tools.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEHAVIORS } from "../core/behaviors.ts";
import { EASES } from "../core/ease.ts";
import { ROLES, type CompileContext, type Kit } from "../core/types.ts";
import type { BuildOptions, BuildResult } from "./build.ts";
import { LIMITS } from "./sandbox.ts";
import { parse, type Item, type State } from "./syntax.ts";

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
const read = (name: string) => readFileSync(join(PROMPTS, name), "utf8");

export type AuthorRequest = { topic: string; words: { text: string; start: number }[]; wishes?: string };

const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- none yet");

// What each motion behavior does and the settings it takes, read from the comment above it in engine/motion, so the
// guide never falls behind the code and a model does not have to guess a behavior's settings.
let motionCache: Record<string, string> | undefined;
export function motionDocs(): Record<string, string> {
  if (motionCache) return motionCache;
  const out: Record<string, string> = {};
  for (const file of ["moves.ts", "parts.ts", "effects.ts"]) {
    let src = "";
    try {
      src = readFileSync(join(PROMPTS, "..", "engine", "motion", file), "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/((?:^ {2}\/\/.*\n)+)^ {2}(\w+): /gm)) {
      const text = m[1]!.split("\n").map((l) => l.replace(/^\s*\/\/\s?/, "").trim()).filter(Boolean).join(" ");
      out[m[2]!] = `\`do ${m[2]} id key=value\`: ${text.replace(/\bargs:/, "Settings:")}`;
    }
  }
  return (motionCache = out);
}

// What each role is for, read from the comments beside `ROLES` in engine/core/types.ts, so the guide follows the contract.
let roleCache: { name: string; doc: string }[] | undefined;
export function roleDocs(): { name: string; doc: string }[] {
  if (roleCache) return roleCache;
  const docs = new Map<string, string>();
  try {
    const src = readFileSync(join(PROMPTS, "..", "engine", "core", "types.ts"), "utf8");
    const block = /export const ROLES = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? "";
    for (const m of block.matchAll(/"(\w+)",\s*\/\/\s*(.+)/g)) docs.set(m[1]!, m[2]!.trim());
  } catch {
    // the names alone still teach the roles
  }
  return (roleCache = ROLES.map((name) => ({ name, doc: docs.get(name) ?? "" })));
}

// Whether the language takes `role=` yet. The guide teaches roles once it does, and plain looks until then, so a guide
// never teaches a word the engine would refuse.
export function rolesSupported(kitKinds: Iterable<string> = []): boolean {
  return !parse(`@0\ntext a "x" role=title\nrow r role=panel\n  box b "y" role=key\n`, kitKinds).problems.length;
}

// Fills `[[roles]]...[[/roles]]` and `[[looks]]...[[/looks]]` blocks, keeping the one this engine supports, and
// `{{as ROLE|ATTRS}}`, which becomes ` role=ROLE` or ` ATTRS`.
export function withLooks(text: string, roles: boolean): string {
  return text
    .replace(/\[\[(roles|looks)\]\]\n?([\s\S]*?)\[\[\/\1\]\]\n?/g, (_, kind: string, body: string) => ((kind === "roles") === roles ? body : ""))
    .replace(/\{\{as (\w+)\|([^}]*)\}\}/g, (_, role: string, attrs: string) => (roles ? ` role=${role}` : attrs ? ` ${attrs}` : ""));
}

// The language guide, filled in with what this engine can really do right now, so new abilities reach Spark by themselves.
/**
 * `say` fills the guide's slots that belong to whoever runs the engine, such as `depicter` (who answers for a depicted
 * thing). A toolbox kit with `pictures` also teaches the picture tiers (a sprite, a picture with parts).
 */
export function languagePrompt(opts: BuildOptions, say: Record<string, string> = {}): string {
  const { ctx } = opts;
  const kits = ctx.kits ?? [];
  const kinds = kits.flatMap((k) => Object.keys(k.kinds ?? {}).map((name) => ({ name, doc: k.docs?.[name] })));
  const docs: Record<string, string> = { ...motionDocs(), flow: "`do flow id color=accent frames=20`: a pulse of color runs along a line", pulse: "`do pulse id size=1.25 frames=16`: a quick grow and return", shake: "`do shake id size=14`: a short shake" };
  // Several kits share a behavior (every truth kit plays `steps`): its line is taught once.
  const behaviors = [...new Set([...Object.keys(BEHAVIORS).map((name) => docs[name] ?? `\`do ${name} id\``), ...kits.flatMap((k) => Object.keys(k.behaviors ?? {}).map((name) => k.docs?.[name] ?? `\`do ${name} id\``))])];
  const assets = Object.keys(opts.assets ?? {});
  const fill: Record<string, string> = {
    fps: String(ctx.fps),
    width: String(ctx.width),
    height: String(ctx.height),
    eases: Object.keys(EASES).join("|"),
    colors: Object.keys(ctx.theme.colors).join(", "),
    behaviors: list(behaviors),
    programs: list((opts.library ?? []).map((p) => `\`${p.name}\`${p.origin === "saved" ? " (saved)" : ""} (${Object.keys(p.params).join(", ") || "no settings"}): ${p.doc}`)),
    kits: kinds.length ? `\nOther things, written as \`KIND id key=value\`, with JSON allowed in a value:\n${list(kinds.map((k) => (k.doc ? `\`${k.name}\`: ${k.doc}` : `\`${k.name}\``)))}` : "",
    assets: assets.length ? `Assets: ${assets.join(", ")}\n` : "",
    cpu: String(LIMITS.cpuMs),
    nodes: String(LIMITS.nodes),
    roles: roleDocs().map((r) => `- \`${r.name}\`${r.doc ? `: ${r.doc}` : ""}`).join("\n"),
    truthKinds: truthKinds(kits).map((k) => `\`${k}\``).join(", ") || "none in this engine",
    leans: leansText(ctx.theme),
  };
  const roles = rolesSupported(kinds.map((k) => k.name));
  // The design brain's toolbox (engine/language/toolbox.ts) is taught only to a writer whose engine has it.
  const toolbox = kits.some((k) => k.name === "toolbox");
  const pictures = kits.some((k) => k.name === "toolbox" && (k as { pictures?: boolean }).pictures === true);
  if (!toolbox) fill.leans = "";
  Object.assign(fill, say);
  return withLooks(read("engine-language.md").replace(toolbox ? /^$/ : /\{\{leans\}\}\n/, ""), roles)
    .replace(/\[\[toolbox\]\]\n?([\s\S]*?)\[\[\/toolbox\]\]\n?/g, (_, body: string) => (toolbox ? body : ""))
    .replace(/\[\[pictures\]\]\n?([\s\S]*?)\[\[\/pictures\]\]\n?/g, (_, body: string) => (pictures ? body : ""))
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => fill[k] ?? "");
}

// The style's motion leanings, as suggestions the writer weighs against what the words need (engine/style/design.ts).
export function leansText(theme: CompileContext["theme"]): string {
  const leans = theme.design?.moves?.leans ?? [];
  if (!leans.length) return "";
  const word: Record<string, string> = { travel: "a thing keeps its id and glides (move= and ease= on a state)", cut: "`@N cut`", fade: "enter=fade", spring: "ease=spring, or `do spring`", drop: "enter=slam, or `do fall`", morph: "`do morph`", arc: "`do arc`", hop: "`do hop`", follow: "`do follow`", orbit: "`do orbit`", squash: "`do squash`", jiggle: "`do jiggle`", wiggle: "`do wiggle`" };
  return `\nThis style leans toward these moves. They are suggestions, not rules: use one where it serves the words, and anything else where it does not.\n${leans.map((l) => `- ${l.move}${word[l.move] ? ` (${word[l.move]})` : ""}: ${l.why}`).join("\n")}\n`;
}

// Kinds whose kit plays computed steps: the things that work a process out for real.
export function truthKinds(kits: Kit[]): string[] {
  return kits.filter((k) => k.behaviors?.steps).flatMap((k) => Object.keys(k.kinds ?? {}));
}

// ---------------------------------------------------------------------------------------------------------------------
// Craft notes: what code can see in a scene that builds but may not show its subject at its best. They are feedback the
// writer weighs, never errors: the writer keeps a choice that serves the words.

const FORMULA = /[̀-ͯ√∑Σ∫∏²³⁴⁵⁶⁷⁸⁹⁰¹ⁿ₀₁₂₃₄₅₆₇₈₉ᵢⱼ]|\\(?:frac|sqrt|bar|sum|hat)\b|\w\^[\w(]|\w_\{?\w/;
const NUMBER = /^[−-]?\d+(?:[.,]\d+)?$/;
// A formula, not a sentence with a symbol in passing: formula signs, and few words around them.
const isFormula = (t: string) => FORMULA.test(t) && (t.match(/\p{L}{3,}/gu) ?? []).length <= 3;

type Shown = { line: number; text: string };

// Every piece of words a scene writes itself, by line: texts, shape labels, atom lines and tags.
function writtenText(items: Item[], out: Shown[] = []): Shown[] {
  for (const i of items) {
    if (i.kind === "atoms") {
      const atoms = (i.parts ?? []).flatMap((p) => (p.type === "text" ? [p.atom] : p.type === "frac" ? [...p.num, ...p.den] : p.rows.flat()));
      out.push({ line: i.line, text: atoms.map((a) => a.text).join(" ") });
    } else if (i.text && i.kind !== "code") out.push({ line: i.line, text: i.text });
    writtenText(i.children, out);
  }
  return out;
}

// Numbers a scene writes as things of their own, by id: shape labels, texts and atoms that are only a number.
type Value = { id: string; value: string };
function ownValue(i: Item): Value[] {
  if (i.kind === "atoms") return (i.parts ?? []).flatMap((p) => (p.type === "text" && NUMBER.test(p.atom.text.trim()) ? [{ id: p.atom.id, value: p.atom.text.trim() }] : []));
  return i.kind !== "code" && i.text !== undefined && NUMBER.test(i.text.trim()) ? [{ id: i.id, value: i.text.trim() }] : [];
}
// Every number in reading order.
const allValues = (items: Item[]): Value[] => items.flatMap((i) => [...ownValue(i), ...allValues(i.children)]);
// Numbers that sit side by side: the children of one arrangement, or the atoms of one line.
function valueGroups(items: Item[], out: { line: number; values: Value[] }[] = []): { line: number; values: Value[] }[] {
  for (const i of items) {
    const values = i.kind === "atoms" ? ownValue(i) : i.children.flatMap(ownValue);
    if (values.length >= 2) out.push({ line: i.line, values });
    valueGroups(i.children, out);
  }
  return out;
}

// Whether a scene puts numbers it showed into a new order by hand, either moving the same things or writing the same
// values again as new things. Returns the two lines that show it.
function reordered(states: State[]): { first: number; then: number; before: string[]; after: string[] } | undefined {
  for (let a = 0; a < states.length; a++) {
    if (states[a]!.keep) continue;
    const base = allValues(states[a]!.items);
    if (base.length < 3) continue;
    const ids = base.map((v) => v.id);
    const values = base.map((v) => v.value);
    for (const s of states.slice(a + 1)) {
      for (const g of valueGroups(s.items)) {
        const same = g.values.every((v) => ids.includes(v.id));
        // New things carrying shown values count only when each value names one thing: in a table, repeated small
        // numbers are new results, not copies.
        const once = (v: Value) => values.filter((x) => x === v.value).length === 1 && g.values.filter((x) => x.value === v.value).length === 1;
        const fresh = g.values.every((v) => !ids.includes(v.id) && once(v));
        const order = g.values.map((v) => (same ? ids.indexOf(v.id) : values.indexOf(v.value)));
        if ((same || fresh) && order.some((x, k) => k > 0 && x < order[k - 1]!)) return { first: states[a]!.line, then: g.line, before: values, after: g.values.map((v) => v.value) };
      }
    }
  }
  return undefined;
}

// Rows of a table written as separate lines outside a grid (atom lines or rows with the same number of values, or
// words split by bars or wide gaps), whose columns cannot line up. The first such run, as lines and its column count.
export function tableRows(states: State[]): { from: number; to: number; cols: number } | undefined {
  const cellsOf = (i: Item): number => {
    if (i.kind === "atoms" && (i.parts ?? []).every((p) => p.type === "text")) return i.parts!.length;
    if (i.kind === "row" && i.children.length > 1 && i.children.every((c) => c.kind === "text" || c.kind === "atoms")) return i.children.length;
    if (i.kind === "text" && i.text) {
      const bars = i.text.split("|").length;
      if (bars >= 3) return bars;
      const wide = i.text.trim().split(/\s{2,}/).length;
      if (wide >= 3) return wide;
    }
    return 0;
  };
  const look = (list: Item[], inGrid: number): { from: number; to: number; cols: number } | undefined => {
    for (let a = 0; a < list.length; a++) {
      const n = cellsOf(list[a]!);
      if (n < 2) continue;
      let b = a;
      while (b + 1 < list.length && cellsOf(list[b + 1]!) === n) b++;
      if (b - a >= 2 && inGrid !== n) return { from: list[a]!.line, to: list[b]!.line, cols: n };
      a = b;
    }
    for (const i of list) {
      const deep = look(i.children, i.kind === "grid" ? Number(i.attrs.cols ?? 2) : 0);
      if (deep) return deep;
    }
    return undefined;
  };
  for (const s of states) {
    const hit = look(s.items, 0);
    if (hit) return hit;
  }
  return undefined;
}

export function craftNotes(source: string, opts: { kitKinds?: string[]; truthKinds?: string[]; math?: boolean } = {}): string[] {
  const { doc } = parse(source, opts.kitKinds ?? []);
  const notes: string[] = [];
  const kinds = new Set(doc.states.flatMap((s) => s.items).flatMap(function all(i: Item): string[] {
    return [i.kind, ...i.children.flatMap(all)];
  }));
  // Formulas typed as characters, when real typesetting is there.
  if (opts.math) {
    const typed = new Map<string, number>();
    for (const s of doc.states) {
      for (const t of writtenText(s.items)) if (isFormula(t.text) && !typed.has(t.text)) typed.set(t.text, t.line);
      for (const c of s.commands) if (c.do === "tag" && isFormula(c.text) && !typed.has(c.text)) typed.set(c.text, c.line);
    }
    if (typed.size) {
      const shown = [...typed].slice(0, 4).map(([text, line]) => `line ${line}: "${text}"`).join("; ");
      notes.push(`These are formulas typed as characters: ${shown}. Typed marks such as a bar over a letter or a root over a fraction can drop out or sit wrong, and the symbols cannot be pointed at one by one. \`math id latex="..."\` typesets them for real. Keep characters only where it is plain words with a symbol in passing.`);
    }
  }
  // Rows of values typed as lines, when a grid would line their columns up.
  const rows = tableRows(doc.states);
  if (rows) notes.push(`Lines ${rows.from} to ${rows.to} are rows of a table written as separate lines, so their columns cannot line up and the values crowd together. Put the rows in \`grid id cols=${rows.cols}\`, one line per row: an atom line or a row with ${rows.cols} values puts each value in its own cell, the first row is the header in the style's table look, and each line's id still names its whole row (to light, tag or mark it).`);
  // Values put in a new order by hand, when a kit can work the process out.
  const truth = (opts.truthKinds ?? []).filter((k) => !kinds.has(k));
  const moved = truth.length && truth.length === (opts.truthKinds ?? []).length ? reordered(doc.states) : undefined;
  // Steps spread evenly to a moment, where the words may be calling them out one by one.
  for (const st of doc.states)
    for (const c of st.commands) {
      if (c.do !== "play" || c.behavior !== "steps" || c.attrs.until === undefined || c.attrs.at !== undefined) continue;
      const [from, to] = [Number(c.attrs.from ?? 1), Number(c.attrs.to ?? NaN)];
      const n = Number.isFinite(to) ? to - from + 1 : undefined;
      if (n !== undefined && n > 8) continue;
      notes.push(`Line ${c.line} plays ${n ? `${n} step${n > 1 ? "s" : ""}` : "steps"} of ${c.targets.join(", ")} spread evenly until ${c.attrs.until}, so each moves on a schedule, not when it is said. If the words name these steps one by one, give each the moment its words are said with at=@..., one per step; until= is for a stretch the words sum up.`);
    }
  if (moved) notes.push(`The state at line ${moved.first} shows ${moved.before.join(", ")}, and line ${moved.then} puts ${moved.after.join(", ")} in a new order by hand. If a kit in your guide works this process out (${truth.map((k) => `\`${k}\``).join(", ")}), let it: every step is then right, each part can be pointed at, and \`do steps\` ties each step to the words that say it, slowly the first time and faster after. Keep the hand-made version only if no kit does what the words describe.`);
  return notes;
}

// Lines that type numbers a truth thing computes, so the writer can point at the computed parts instead.
export function typedResults(source: string, truth: NonNullable<BuildResult["truth"]>, kitKinds: string[] = []): string[] {
  const computed = new Set(truth.flatMap((t) => t.steps.join(" ").match(/[−-]?\d+(?:[.,]\d+)?/g) ?? []));
  const { doc } = parse(source, kitKinds);
  const out = new Map<number, string>();
  for (const s of doc.states) {
    const texts = [...writtenText(s.items), ...s.commands.flatMap((c) => (c.do === "tag" ? [{ line: c.line, text: c.text }] : []))];
    for (const t of texts) {
      const nums = t.text.match(/[−-]?\d+(?:[.,]\d+)?/g) ?? [];
      if (nums.length >= 2 && nums.every((n) => computed.has(n))) out.set(t.line, t.text);
    }
  }
  return [...out].map(([line, text]) => `line ${line}: "${text}"`);
}

export const requestText = (r: AuthorRequest) => `Topic: ${r.topic}\n\n${r.wishes ? `${r.wishes}\n\n` : ""}Spoken words (number, seconds, word):\n${r.words.map((w, i) => `${i} ${w.start.toFixed(1)} ${w.text}`).join("\n")}`;

export function numbered(source: string): string {
  return source.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
}

// The numbered steps of every truth thing in a scene, for one alignment round. With the scene's source, lines that type
// numbers the truth things compute are named, so the writer can point at the computed parts instead.
export function truthText(truth: NonNullable<BuildResult["truth"]>, source?: string, kitKinds: string[] = []): string {
  const list = truth.map((t) => `${t.kind} ${t.id}${t.drawn ? ` (${t.drawn})` : ""}:\n${t.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`).join("\n");
  const typed = source ? typedResults(source, truth, kitKinds) : [];
  const typedNote = typed.length ? `\n\nThese lines type numbers that the truth things compute: ${typed.slice(0, 5).join("; ")}. A typed copy can disagree with what is computed and cannot follow the steps; where a line shows a result, point at the part that shows it (light, tag, mark) instead. A line that only quotes the narration's words can stay.` : "";
  return `These are the steps the truth things in your scene really compute, in order, each with how it is drawn on this frame:\n${list}\n\nCheck that each \`do steps\` plays these steps on the spoken words that talk about them (at=, or from= and to= across states), that the way the thing is drawn moves the way the words say (a value the words send down must move down on screen: set form= when it does not), and that tags, marks and lights point at the parts that show computed results rather than writing results as text yourself.${typedNote}`;
}

// What goes back to the writer once a scene builds: computed steps to bind, craft notes to weigh, or both. Empty when
// there is nothing to say. `extra` adds notes only the caller can see, such as how the part sits with its pictures.
export function reviewText(source: string, result: BuildResult, opts: { kitKinds?: string[]; truthKinds?: string[]; math?: boolean; extra?: string[] } = {}): string {
  const notes = [...craftNotes(source, opts), ...(result.notes ?? []), ...(opts.extra ?? [])];
  const parts = [
    result.truth?.length ? truthText(result.truth, source, opts.kitKinds) : "",
    notes.length ? `Notes on how the scene reads. They are not errors: act on a note where it makes the scene serve its words better, and leave the scene as it is where your choice already does:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n\nChange only what needs it, and return the whole scene again, with no commentary.` : "";
}
