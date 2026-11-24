/**
 * The pictures a video can show, and the ones the agent has looked at on the way.
 *
 * A **candidate** is any picture the toolbox showed the agent: an archive hit, a picture on a page, a page's screenshot,
 * a frame of a video, a figure from a PDF. Each gets a short id (c1, c2, …) so the agent can keep one by id with
 * save_image. An **asset** is a picture kept for the video under a name the agent chose; a scene shows it with
 * `image id asset=NAME`. Assets live in the job's folder (`assets/NAME.jpg`, or `.png` for a cut-out, which keeps its
 * see-through edge), at most 2048 pixels on the long side, with where they came from and the credit line the video
 * shows under them while they are on screen.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type AssetKind = "found" | "generated" | "screenshot" | "frame" | "figure" | "cutout";

export interface Origin {
  /** Where it came from, as a person would name it: "Wikimedia Commons", "nasa.gov", "a PDF". */
  source: string;
  title?: string;
  /** The page a viewer could check it on. */
  page?: string;
  license?: string;
  /** Who made it, when known. */
  author?: string;
}

export interface Asset {
  name: string;
  /** Relative to the job's folder; the render serves the folder, so this is also what a scene loads. */
  file: string;
  kind: AssetKind;
  width: number;
  height: number;
  /** What it shows, in the agent's words or the source's title. */
  about: string;
  origin: Origin;
  /** The short line shown under it while it is on screen, and on the end card; none for a picture made for this video. */
  credit?: string;
  /** For a generated picture: what it was asked for. */
  prompt?: string;
}

export interface Candidate {
  id: string;
  kind: AssetKind;
  about: string;
  origin: Origin;
  /** A remote picture: the large version to keep, and a small one to look at. */
  url?: string;
  thumb?: string;
  /** A picture already on disk (a frame, a figure, a screenshot), relative to the job's folder. */
  file?: string;
  size?: string;
}

/** What the toolbox keeps in the job's draft. */
export interface Pictures {
  assets: Record<string, Asset>;
  candidates: Record<string, Candidate>;
  next: number;
  /** Paid calls made for this video, by kind ("generate", "cutout", "search"). */
  spent: Record<string, number>;
}

export const emptyPictures = (): Pictures => ({ assets: {}, candidates: {}, next: 1, spent: {} });

export const NAME = /^[a-z][a-z0-9_-]{0,39}$/i;
/** A picture smaller than this on its short side looks blurred when it fills a phone's frame. */
export const SMALL_SIDE = 700;
const LONG_SIDE = 2048;

export function addCandidate(p: Pictures, c: Omit<Candidate, "id">): Candidate {
  const id = `c${p.next++}`;
  const candidate = { ...c, id };
  p.candidates[id] = candidate;
  // Keep the last 200; older ids stop working, which the agent is told if it asks for one.
  const ids = Object.keys(p.candidates);
  for (const old of ids.slice(0, Math.max(0, ids.length - 200))) delete p.candidates[old];
  return candidate;
}

/** The credit line for a picture from somewhere else: its maker and source, and its license when it has one. */
export function creditLine(o: Origin): string {
  const who = o.author && o.author !== o.source && !/^unknown$/i.test(o.author) ? `${o.author}, ` : "";
  const license = o.license && !/^unknown$/i.test(o.license) ? ` (${o.license})` : "";
  return `${who}${o.source}${license}`.slice(0, 120);
}

export async function size(file: string): Promise<[number, number]> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeout: 30_000 });
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!w || !h) throw new Error("that file is not a picture ffmpeg can read");
  return [w, h];
}

/**
 * Writes a picture into the job's assets: decoded and scaled down to fit 2048 pixels (never up), as a JPEG, or a PNG
 * when it keeps transparency. Any format ffmpeg reads goes in (JPEG, PNG, WebP, GIF's first frame, TIFF).
 */
export async function keep(folder: string, name: string, input: Buffer | string, o: { alpha?: boolean; signal?: AbortSignal } = {}): Promise<{ file: string; width: number; height: number }> {
  const dir = join(folder, "assets");
  mkdirSync(dir, { recursive: true });
  let source = typeof input === "string" ? input : "";
  if (typeof input !== "string") {
    source = join(dir, `.in-${createHash("sha1").update(input).digest("hex").slice(0, 12)}`);
    writeFileSync(source, input);
  }
  const file = `assets/${name}.${o.alpha ? "png" : "jpg"}`;
  const fit = `scale='min(${LONG_SIDE},iw)':'min(${LONG_SIDE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
  const flatten = o.alpha ? "format=rgba" : "format=yuvj444p";
  await run("ffmpeg", ["-y", "-v", "error", "-i", source, "-frames:v", "1", "-vf", `${fit},${flatten}`, ...(o.alpha ? [] : ["-q:v", "3"]), "-update", "1", join(folder, file)], { signal: o.signal, timeout: 60_000 });
  const [width, height] = await size(join(folder, file));
  return { file, width, height };
}

/** A small JPEG of a picture for the agent to see (and a data URL for stills), cached next to it. */
export async function preview(path: string, side = 512): Promise<string> {
  const out = `${path}.${side}.jpg`;
  if (!existsSync(out)) await run("ffmpeg", ["-y", "-v", "error", "-i", path, "-frames:v", "1", "-vf", `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease,format=yuvj444p`, "-q:v", "5", "-update", "1", out], { timeout: 60_000 });
  return out;
}

export const base64 = (file: string) => readFileSync(file).toString("base64");

/** The assets a scene's source names with asset=NAME. */
export function assetsIn(source: string): string[] {
  return [...new Set([...source.matchAll(/(?:^|\s)asset=([A-Za-z0-9_-]+)/g)].map((m) => m[1]!))];
}

export function describeAsset(a: Asset): string {
  const shape = a.width > a.height * 1.15 ? "wide" : a.height > a.width * 1.15 ? "tall" : "square";
  const small = Math.min(a.width, a.height) < SMALL_SIDE ? "; small, so show it in part of the frame, not filling it" : "";
  return `${a.name}: ${a.kind}, ${a.width} by ${a.height} (${shape}${small}), ${a.about}${a.credit ? `; shown with "${a.credit}"` : ""}`;
}
