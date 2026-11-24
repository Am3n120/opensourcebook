/**
 * The shelf of pieces: ready-made things the agent can put on screen and drive with a few settings and the spoken
 * words. Each is a folder (services/scenes/pieces/NAME/ shipped with Open Sourcebook, or the data folder's pieces/NAME/ for one the
 * person's agent saved) with its program (piece.js), a line on what it is with its tags and settings (piece.json), a
 * built scene that uses it (example.md) and its picture (still.jpg). The scene language runs a piece by name like any
 * library program (`run NAME id ...`), and its guide lists them; this file finds pieces by what the agent wants to
 * show, keeps a note of searches that found nothing, and saves a piece the agent made.
 *
 * Search is a plain word match, with no model call: the words of the query against each piece's name, tags, line and
 * settings, with endings cut so "growing" meets "grow". It is honest about what it is: the agent reads the one-liners
 * and looks at the pictures to choose.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadShelf, PIECES, readPiece, savedShelf, testProgram, type LibraryEntry } from "../engine/language/library.ts";
import { parse } from "../engine/language/syntax.ts";
import { renderStills } from "../pipeline/stages/scene.ts";
import { kitKinds } from "../pipeline/stages/scene.ts";
import { buildScene, lookAt, type Built } from "./scene.ts";
import { readExample, type Example } from "./skills.ts";
import { estimate } from "./voice.ts";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

export const shippedPieces = (): LibraryEntry[] => loadShelf(PIECES, null).pieces;
export const shelf = (): LibraryEntry[] => loadShelf().pieces;

/** The piece's built scene: its narration and its source, from example.md. */
export function pieceExample(p: LibraryEntry): Example {
  const file = join(p.folder!, "example.md");
  if (!existsSync(file)) throw new Error(`The piece ${p.name} has no example.md (a built scene that uses it).`);
  return readExample(p.name, readFileSync(file, "utf8"));
}

/** How a piece is written in a scene, with its settings at their defaults. */
export function usage(p: LibraryEntry): string {
  const settings = Object.entries(p.params).map(([k, v]) => `${k}=${/[\s"]/.test(v) || v === "" ? JSON.stringify(v) : v}`);
  return `run ${p.name} ID ${settings.join(" ")} w=900 h=1200`.replace(/\s+/g, " ");
}

export interface PieceBuild extends Pick<Built, "ok" | "problems" | "serious" | "warnings"> {
  stills?: string[];
  /** The shelf's picture: the end of the scene, small. */
  picture?: string;
}

/** Builds a piece's scene in a style, with stills of how it opens, its middle and how it ends when asked. */
export async function buildPieceScene(p: LibraryEntry, style: string, folder: string, o: { stills?: boolean } = {}): Promise<PieceBuild> {
  const e = pieceExample(p);
  const scene = { id: "s1", narration: e.narration, onScreenText: [], visual: e.about, cites: [] };
  const c = { title: e.title, idea: e.about, brief: "", style, frame: { width: 1080, height: 1920 }, scene, timing: estimate(e.narration) };
  const built = await buildScene(c, e.source, folder);
  const out: PieceBuild = { ok: built.ok, problems: built.problems, serious: built.serious, warnings: built.warnings };
  if (o.stills && built.ok && built.scene) {
    out.stills = (await lookAt(c, e.source, { ...built, scene: built.scene }, undefined, folder, 0.5)).map((s) => s.file);
    const [pic] = await renderStills(built.scene, built.theme, [Math.max(0, built.scene.frames - 2)], join(folder, "picture"), 1 / 3);
    out.picture = pic;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding

const STOP = new Set("a an the of to and or for in on at by with from into over under as is are be it its this that these those what which how show shows showing something thing things some way ways one two my me i we you want need make using use like about".split(" "));

/** A word cut to its stem, so "growing", "grows" and "grow" meet. */
export function stem(w: string): string {
  let s = w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  for (const end of ["ations", "ation", "ings", "ing", "ies", "ied", "ers", "er", "ed", "es", "ly", "s"]) {
    if (s.length - end.length >= 3 && s.endsWith(end)) {
      s = s.slice(0, -end.length) + (end === "ies" || end === "ied" ? "y" : "");
      break;
    }
  }
  return s;
}
const terms = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w.toLowerCase())).map(stem).filter((w) => w.length > 1);

export interface Found {
  piece: LibraryEntry;
  score: number;
}

/** Raw weighted match across the query's distinct words: total weight matched across name, tags, doc, and settings. */
function rawScore(p: LibraryEntry, want: string[]): number {
  if (!want.length) return 0;
  const fields: [string[], number][] = [
    [terms(p.name.replace(/-/g, " ")), 1],
    [terms((p.tags ?? []).join(" ")), 0.9],
    [terms(p.doc), 0.7],
    [terms(Object.values(p.about ?? {}).join(" ")), 0.35],
  ];
  let total = 0;
  for (const w of want) {
    let best = 0;
    for (const [words, weight] of fields) {
      for (const x of words) {
        const m = x === w ? 1 : w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x)) ? 0.7 : 0;
        best = Math.max(best, m * weight);
      }
    }
    total += best;
  }
  return total;
}

/** How well a piece answers the query, from 0 (no word meets) to about 1 (every word meets its name or tags). */
export function score(p: LibraryEntry, query: string): number {
  const want = [...new Set(terms(query))];
  return want.length ? rawScore(p, want) / want.length : 0;
}

/** What counts as fitting: about half the query's words meet the piece's name, tags or line. */
export const FITS = 0.4;

export function search(query: string, pieces: LibraryEntry[] = shelf(), n = 5): Found[] {
  return pieces
    .map((piece) => ({ piece, score: score(piece, query) }))
    .filter((f) => f.score >= FITS)
    .sort((a, b) => b.score - a.score || a.piece.name.localeCompare(b.piece.name))
    .slice(0, n);
}

const EXTRA_VISUAL_STOP = new Set(["through", "both", "each", "between"]);

/**
 * High-confidence piece matches for a beat's visual description: requires at least two distinct non-stop query
 * words hitting name, tags, or one-line doc (total score >= 1.7), with at least one exact name or tag match.
 */
export function matchPieces(query: string, pieces: LibraryEntry[] = shelf(), n = 3): Found[] {
  const want = [...new Set(terms(query))].filter((w) => !EXTRA_VISUAL_STOP.has(w));
  if (want.length < 2) return [];
  const out: Found[] = [];
  for (const piece of pieces) {
    const fields: [string[], number][] = [
      [terms(piece.name.replace(/-/g, " ")), 1],
      [terms((piece.tags ?? []).join(" ")), 0.9],
      [terms(piece.doc), 0.7],
    ];
    let total = 0;
    let hits = 0;
    let nameOrTag = false;
    for (const w of want) {
      let best = 0;
      let nt = false;
      for (const [words, weight] of fields) {
        for (const x of words) {
          const m = x === w ? 1 : w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x)) ? 0.7 : 0;
          if (m * weight > best) {
            best = m * weight;
            nt = weight >= 0.9 && m === 1;
          }
        }
      }
      if (best >= 0.7) {
        total += best;
        hits += 1;
        if (nt) nameOrTag = true;
      }
    }
    if (hits >= 2 && total >= 1.7 && nameOrTag) out.push({ piece, score: total });
  }
  return out.sort((a, b) => b.score - a.score || a.piece.name.localeCompare(b.piece.name)).slice(0, n);
}

/** The note of what was looked for and not found, beside the person's shelf in the data folder. */
export const wantedLog = (saved = savedShelf()) => join(dirname(saved), "pieces-wanted.log");

/** Notes a search that found nothing, a JSON line each: what was looked for, when, and the nearest pieces. */
export function noteMiss(query: string, nearest: Found[], saved = savedShelf()): void {
  const file = wantedLog(saved);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), wanted: query, nearest: nearest.map((f) => `${f.piece.name} ${f.score.toFixed(2)}`) })}\n`);
}

/** A piece as the search answers it: its line, how it is written, its settings and where it came from. */
export function describe(p: LibraryEntry, i?: number): string {
  const settings = Object.entries(p.params).map(([k, v]) => `  - ${k} (default ${JSON.stringify(v)})${p.about?.[k] ? `: ${p.about[k]}` : ""}`);
  return [
    `${i === undefined ? "" : `${i}. `}${p.name} (${p.origin === "saved" ? "saved on this person's shelf" : "shipped with Open Sourcebook"}): ${p.doc}`,
    `  ${usage(p)}`,
    ...(settings.length ? settings : ["  - no settings"]),
    ...(p.notes?.length ? [`  When it was saved: ${p.notes.join(" ")}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeing the whole shelf

/** The size of one piece on the sheet: its picture at the frame's shape, and a band under it for its name. */
export const SHEET = { cols: 8, tile: 120, gap: 6, label: 22 } as const;

let sheetFont = "";
function nameFont(): string {
  if (!sheetFont) {
    const file = join(PIECES, "..", "fonts", "barlow", "Barlow-SemiBold.ttf");
    sheetFont = existsSync(file) && GlobalFonts.registerFromPath(file, "Open Sourcebook shelf sheet") ? "Open Sourcebook shelf sheet" : "sans-serif";
  }
  return sheetFont;
}

/**
 * One picture of the whole shelf: each piece's own picture, small, with its name under it, left to right and down in
 * the shelf's order, so every piece can be seen at a glance and asked for by name. A piece with no picture keeps its
 * place with its name alone. Written to `file` (a JPEG) and its path returned; nothing is written for an empty shelf.
 */
export async function shelfSheet(pieces: LibraryEntry[], file: string): Promise<string | undefined> {
  if (!pieces.length) return undefined;
  const { cols, tile, gap, label } = SHEET;
  const th = Math.round((tile * 16) / 9);
  const [cw, ch] = [tile + gap, th + label + gap];
  const rows = Math.ceil(pieces.length / Math.min(cols, pieces.length));
  const width = Math.min(cols, pieces.length) * cw + gap;
  const canvas = createCanvas(width, rows * ch + gap);
  const g = canvas.getContext("2d");
  g.fillStyle = "#e9e9e9";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = `15px "${nameFont()}"`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const [i, p] of pieces.entries()) {
    const x = gap + (i % cols) * cw;
    const y = gap + Math.floor(i / cols) * ch;
    const still = p.folder ? join(p.folder, "still.jpg") : "";
    g.fillStyle = "#ffffff";
    g.fillRect(x, y, tile, th);
    if (still && existsSync(still)) {
      try {
        g.drawImage(await loadImage(readFileSync(still)), x, y, tile, th);
      } catch {
        // A picture that cannot be read leaves the piece's place blank, with its name.
      }
    }
    g.fillStyle = "#1a1a1a";
    let name = p.name;
    while (name.length > 3 && g.measureText(name).width > tile) name = `${name.slice(0, -2)}…`;
    g.fillText(name, x + tile / 2, y + th + label / 2);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, canvas.toBuffer("image/jpeg", 82));
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------
// Saving

export interface SaveRequest {
  name: string;
  about: string;
  tags?: string[];
  /** What each setting means. */
  params?: Record<string, string>;
  /** The program's source and its settings with their defaults, as written in the scene. */
  program: { params: Record<string, string>; source: string; doc?: string };
  /** The style its picture is drawn in. */
  style: string;
  replace?: boolean;
}

/** Words a program writes itself: quoted strings that are not colors, eases, anchors or part ids. */
function bakedWords(source: string): string[] {
  const out = new Set<string>();
  const known = /^(ink|accent|paper|highlight|soft|none|linear|smooth|in|out|spring|bounce|step|anticipate|overshoot|swing|elastic|start|middle|end|center)$/;
  for (const m of source.matchAll(/(["'`])((?:(?!\1)[^\\\n])*)\1/g)) {
    const s = m[2]!.trim();
    if (!s || known.test(s) || /\$\{/.test(s)) continue;
    // An id or a part name ("bar", "dot" + i) is not words on screen; two or more words, or a capital, is.
    if (/\s/.test(s) || /^\p{Lu}\p{Ll}+/u.test(s) || /^\d[\d.,]*\s*\p{L}/u.test(s)) out.add(s);
  }
  return [...out].slice(0, 6);
}

/** What would make a program reusable, found by code: words or numbers of one video in its code, no settings, sizes it breaks at. */
export async function generality(entry: LibraryEntry, tested?: string[]): Promise<string[]> {
  const notes: string[] = [];
  const words = bakedWords(entry.source);
  if (words.length) notes.push(`It writes these words itself: ${words.map((w) => `"${w}"`).join(", ")}. As settings (a list such as labels="A|B|C" that the program splits with items()), the next video can give its own.`);
  const lists = [...entry.source.matchAll(/\[\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){3,}\s*\]/g)].map((m) => m[0]);
  if (lists.length) notes.push(`It holds lists of numbers in its code (${lists.slice(0, 2).join(", ")}). If they are this video's data rather than the drawing's own shape, take them as a setting (values="3,5,8").`);
  if (!Object.keys(entry.params).length) notes.push("It has no settings, so it shows the same thing every time. Settings for what changes from one use to the next (labels, values, how many, when) make it reusable.");
  tested ??= await testProgram(entry);
  if (tested.length) notes.push(`Run on its own at other sizes and seeds: ${tested.slice(0, 4).join("; ")}.`);
  return notes;
}

/** The scene a saved piece is shown with: the piece alone, at its defaults. */
function savedExample(name: string, about: string): string {
  const narration = "Here is the piece as it was saved, drawn on its own with its settings left at their defaults, so it can be seen and chosen again.";
  return `# ${name}\n\n${about}\n\nNarration: "${narration}"\n\n\`\`\`scene\n@0\nrun ${name} p1 w=950 h=1250\n\`\`\`\n`;
}

/** Saves a piece to the person's shelf. Returns what it noticed; refuses only a name that is taken or a program that never runs. */
export async function savePiece(r: SaveRequest, folder: string, saved = savedShelf()): Promise<{ ok: boolean; text: string; picture?: string }> {
  const name = r.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) return { ok: false, text: "A piece's name is lowercase letters, digits and hyphens, such as rising-tide-chart." };
  if (shippedPieces().some((p) => p.name === name)) return { ok: false, text: `${name} is a shipped piece's name. Give yours another.` };
  if (r.about.trim().length < 12) return { ok: false, text: "Say in a line what it is and when to use it (about), so a later search can find it." };
  const dir = join(saved, name);
  if (existsSync(dir) && !r.replace) return { ok: false, text: `There is already a saved piece called ${name}. Send replace: true to save over it, or another name.` };
  const entry: LibraryEntry = { name, doc: r.about.trim(), params: r.program.params, source: r.program.source };
  const tested = await testProgram(entry);
  const failures = tested.filter((t) => / it failed: /.test(t));
  if (failures.length >= 3) return { ok: false, text: `It did not run on its own at any size, so it cannot be kept as it is: ${failures[0]}` };
  const notes = await generality(entry, tested.filter((t) => !/^the name |one-line description/.test(t)));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const params = Object.fromEntries(Object.entries(r.program.params).map(([k, v]) => [k, { default: v, ...(r.params?.[k] ? { about: r.params[k] } : {}) }]));
  writeFileSync(join(dir, "piece.json"), `${JSON.stringify({ about: entry.doc, tags: r.tags ?? [], params, ...(notes.length ? { notes } : {}), savedAt: new Date().toISOString() }, null, 2)}\n`);
  writeFileSync(join(dir, "piece.js"), r.program.source.endsWith("\n") ? r.program.source : `${r.program.source}\n`);
  writeFileSync(join(dir, "example.md"), savedExample(name, entry.doc));
  const piece = readPiece(dir, "saved");
  let picture: string | undefined;
  try {
    const built = await buildPieceScene(piece, r.style, join(folder, "piece", name), { stills: true });
    if (built.picture) {
      writeFileSync(join(dir, "still.jpg"), readFileSync(built.picture));
      picture = join(dir, "still.jpg");
    }
  } catch {
    // The picture is a help for choosing; a piece that cannot be drawn alone is still kept, and says so.
  }
  const text = [
    `Saved ${name} to this person's shelf. A search finds it from the next video on (and in this one), told apart from the shipped pieces.`,
    notes.length ? `What would make it more reusable, as code sees it:\n- ${notes.join("\n- ")}\nThese are kept with it and shown with it in searches; save it again with replace: true once it takes them as settings.` : "It takes its content as settings and runs at other sizes, so it reads as general.",
    picture ? "Its picture, drawn alone at its defaults, is below." : "It could not be drawn alone at its defaults, so it has no picture on the shelf.",
  ].join("\n");
  return { ok: true, text, ...(picture ? { picture } : {}) };
}

/** A program block of a scene, by name, with its settings' defaults. */
export function programIn(source: string, name: string): { params: Record<string, string>; source: string; doc?: string } | undefined {
  const { doc } = parse(source, kitKinds());
  const p = doc.programs.find((x) => x.name === name);
  return p ? { params: p.params, source: p.source, ...(p.doc ? { doc: p.doc } : {}) } : undefined;
}
