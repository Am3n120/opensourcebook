// The growing library, which the scene language calls the programs it can run by name. It is read from the shelf:
// every folder in services/scenes/pieces/ is a piece (a program with a line on what it is, its settings and a built
// scene that uses it), and every folder in the person's own shelf (the data folder's pieces/) is one they saved. A
// program a model wrote can also be kept as a plain JSON entry, after it passes tests in the sandbox: it must run
// cleanly at several sizes and seeds, give the same result twice, stay inside its box, and be general.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOutput } from "./program.ts";
import { runProgram, type ProgramInput, type RawNode } from "./sandbox.ts";

export type LibraryEntry = {
  name: string;
  /** What it is and when to use it, in a line. */
  doc: string;
  /** Each setting with its default. */
  params: Record<string, string>;
  source: string;
  tested?: string;
  /** What each setting means, in a few words. */
  about?: Record<string, string>;
  /** Words a search for it may use: what it shows, what it is for. */
  tags?: string[];
  /** Shipped with Open Sourcebook, or saved by the person's agent to their own shelf. */
  origin?: "shipped" | "saved";
  /** The piece's folder, for its picture and its scene. */
  folder?: string;
  /** What would make a saved piece reusable, as its save found it. */
  notes?: string[];
  /** Plain data the piece carries beside its program (its folder's data.json), handed to it as `pieceData`. */
  data?: unknown;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "library");
/** The shipped shelf: one folder per piece. */
export const PIECES = join(HERE, "..", "..", "pieces");
const COLORS = ["ink", "accent", "paper", "highlight", "soft"];

/** The person's own shelf: pieces their agent saved, in the service's data folder (never the repo). */
export function savedShelf(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCENES_SAVED_PIECES?.trim() || join(env.SCENES_DATA_DIR?.trim() || join(HERE, "..", "..", ".data"), "pieces");
}

type PieceFile = { about?: unknown; tags?: unknown; params?: unknown; notes?: unknown };

/** Reads one piece folder: piece.json (about, tags, params) and piece.js (the program). Throws with what is wrong. */
export function readPiece(folder: string, origin: LibraryEntry["origin"] = "shipped"): LibraryEntry {
  const name = folder.split(/[\\/]/).filter(Boolean).at(-1)!;
  const where = `The piece ${name} (${folder})`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${where}: a piece's folder name is lowercase letters, digits and hyphens.`);
  const meta = join(folder, "piece.json");
  const code = join(folder, "piece.js");
  if (!existsSync(meta)) throw new Error(`${where} has no piece.json (its line, tags and settings).`);
  if (!existsSync(code)) throw new Error(`${where} has no piece.js (its program).`);
  let m: PieceFile;
  try {
    m = JSON.parse(readFileSync(meta, "utf8")) as PieceFile;
  } catch (e) {
    throw new Error(`${where}: piece.json is not valid JSON (${(e as Error).message}).`);
  }
  if (typeof m.about !== "string" || m.about.trim().length < 12) throw new Error(`${where}: piece.json needs "about", a line on what it is and when to use it.`);
  const params: Record<string, string> = {};
  const about: Record<string, string> = {};
  if (m.params !== undefined && (typeof m.params !== "object" || m.params === null || Array.isArray(m.params))) throw new Error(`${where}: "params" is an object of settings, each { "default": "...", "about": "..." }.`);
  for (const [k, v] of Object.entries((m.params ?? {}) as Record<string, unknown>)) {
    const p = v as { default?: unknown; about?: unknown };
    if (!/^[a-z][A-Za-z0-9]*$/.test(k) || typeof p !== "object" || p === null || p.default === undefined) throw new Error(`${where}: the setting "${k}" needs a name of letters and digits and a "default".`);
    params[k] = String(p.default);
    if (typeof p.about === "string") about[k] = p.about;
  }
  const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
  const notes = Array.isArray(m.notes) ? m.notes.map(String) : undefined;
  // Data the program draws from, such as a map's coastlines, kept beside it so the program stays short to read.
  const dataFile = join(folder, "data.json");
  let data: unknown;
  if (existsSync(dataFile)) {
    try {
      data = JSON.parse(readFileSync(dataFile, "utf8"));
    } catch (e) {
      throw new Error(`${where}: data.json is not valid JSON (${(e as Error).message}).`);
    }
  }
  return { name, doc: m.about.trim(), params, about, tags, source: readFileSync(code, "utf8"), origin, folder, ...(notes?.length ? { notes } : {}), ...(data !== undefined ? { data } : {}) };
}

const folders = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isDirectory()).sort() : []);

/**
 * The shelf: the shipped pieces, then the person's saved ones (a saved one never takes a shipped name). A broken
 * shipped piece throws with what is wrong, since Open Sourcebook ships it; a broken saved one is left out and named in `broken`.
 */
export function loadShelf(shipped = PIECES, saved: string | null = savedShelf()): { pieces: LibraryEntry[]; broken: string[] } {
  const pieces = folders(shipped).map((f) => readPiece(join(shipped, f), "shipped"));
  const broken: string[] = [];
  const names = new Set(pieces.map((p) => p.name));
  for (const f of saved ? folders(saved) : []) {
    try {
      const p = readPiece(join(saved!, f), "saved");
      if (!names.has(p.name)) pieces.push(p);
    } catch (e) {
      broken.push((e as Error).message);
    }
  }
  return { pieces, broken };
}

/** Programs the language can run by name: plain JSON entries in a folder, or, by default, the whole shelf. */
export function loadLibrary(dir?: string): LibraryEntry[] {
  if (dir === undefined) return loadShelf().pieces;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LibraryEntry);
}

// How much of a program's drawing falls outside its box, from 0 to 1. Only static start positions can be checked.
function outside(nodes: RawNode[], W: number, H: number): number {
  let total = 0;
  let out = 0;
  for (const n of nodes) {
    const ox = typeof n.props.x === "number" && !n.parent ? n.props.x : 0;
    const oy = typeof n.props.y === "number" && !n.parent ? n.props.y : 0;
    const p = Array.isArray(n.props.points) ? (n.props.points as number[]) : [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      total++;
      const [x, y] = [p[i]! + ox, p[i + 1]! + oy];
      if (!n.parent && (x < -W * 0.1 || x > W * 1.1 || y < -H * 0.1 || y > H * 1.1)) out++;
    }
  }
  return total ? out / total : 0;
}

// Every way a candidate can fail. An empty list means it may be saved.
export async function testProgram(entry: LibraryEntry): Promise<string[]> {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) problems.push("the name must be lowercase letters, digits and hyphens");
  if (entry.doc.trim().length < 12) problems.push("it needs a one-line description of what it can do");
  const cases: Pick<ProgramInput, "W" | "H" | "seed" | "T0" | "T1">[] = [
    { W: 900, H: 900, seed: 1, T0: 0, T1: 150 },
    { W: 600, H: 1100, seed: 2, T0: 40, T1: 400 },
    { W: 1000, H: 420, seed: 3, T0: 10, T1: 60 },
  ];
  for (const c of cases) {
    // A spoken moment has no word to land on here, so it stands for a point inside the program's time.
    const args = Object.fromEntries(Object.entries(entry.params).map(([k, v]) => [k, /^-?[\d.]+$/.test(v) ? Number(v) : v.startsWith("@") ? Math.round((c.T0 + c.T1) / 2) : v]));
    const input: ProgramInput = { ...c, fps: 30, frames: 600, args, on: {}, words: [], colors: COLORS, ...(entry.data !== undefined ? { pieceData: entry.data } : {}) };
    const [a, b] = await Promise.all([runProgram(entry.source, input), runProgram(entry.source, input)]);
    const size = `at ${c.W} by ${c.H}`;
    if (!a.ok) {
      problems.push(`${size} it failed: ${a.error}`);
      continue;
    }
    if (!b.ok || JSON.stringify(a.output) !== JSON.stringify(b.output)) problems.push(`${size} it gave different results for the same seed`);
    const { errors } = checkOutput(a.output, { mount: "m", on: [], offset: { x: 0, y: 0 }, frames: 600, colors: new Set(COLORS) });
    problems.push(...errors.map((e) => `${size}: ${e}`));
    if (!a.output.nodes.length) problems.push(`${size} it drew nothing`);
    if (outside(a.output.nodes, c.W, c.H) > 0.02) problems.push(`${size} it draws outside its box, so it ignores W and H`);
  }
  return problems;
}

// Finds programs in a written scene that could be kept. A person or reviewer still decides which are general enough.
export async function harvest(source: string, parsePrograms: (s: string) => { name: string; doc?: string; params: Record<string, string>; source: string }[]) {
  const out: { entry: LibraryEntry; problems: string[] }[] = [];
  for (const p of parsePrograms(source)) {
    const entry: LibraryEntry = { name: p.name.toLowerCase(), doc: p.doc ?? "", params: p.params, source: p.source };
    out.push({ entry, problems: await testProgram(entry) });
  }
  return out;
}

// Saves a program after it passes. Throws with every reason when it does not, so nothing untested gets in.
export async function saveProgram(entry: LibraryEntry, dir = DIR): Promise<string> {
  const problems = await testProgram(entry);
  if (problems.length) throw new Error(`${entry.name} was not saved:\n${problems.join("\n")}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.name}.json`);
  writeFileSync(file, `${JSON.stringify({ ...entry, tested: "3 sizes, 3 seeds, repeatable, stays in its box" }, null, 2)}\n`);
  return file;
}
