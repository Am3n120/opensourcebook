// The fonts a style may name. Every font Open Sourcebook draws or measures with ships in services/scenes/fonts/, one folder per
// family: its files, its licence and a font.json saying which file is which weight. A style names families; this
// finds the files, so a video looks and measures the same on any computer, whatever fonts it has installed.
//
// This file is pure, so the browser that draws a video can use it too. Reading the folder is in shipped.ts (Node),
// and loading the files into a page is in load-fonts.ts (the video's browser) and the measuring page.

// What a family can do for every style besides being named: `fallback` families are put behind every stack, for the
// symbols the styles' own fonts lack (arrows, maths, ticks); `default` is used by a style that names no font, `mono`
// by a style that names no code font.
export type FontUse = "fallback" | "default" | "mono";

// `sizeAdjust` (a CSS percentage) scales a face that is drawn small for its size, such as a handwriting font with a
// short x-height, so the same text size reads the same in every style. Measuring and drawing both apply it.
export type ShippedFace = { file: string; weight: number | [number, number]; style?: "normal" | "italic"; unicodeRange?: string; sizeAdjust?: string };
export type FontFamily = { family: string; folder: string; licence: string; licenceFiles: string[]; source: string; serves?: FontUse[]; faces: ShippedFace[] };
export type FontBook = { families: FontFamily[] };

// The generic names CSS knows. They are allowed at the end of a stack, as a last resort for a character no shipped
// font has (an emoji, a script none of them covers), and are the only names that may be left to the computer.
export const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji"]);

// The family names in a CSS font stack, unquoted, in order.
export function familiesIn(stack: string): string[] {
  const out: string[] = [];
  for (const m of stack.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

const quote = (name: string) => (GENERIC.has(name) ? name : JSON.stringify(name));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const familyNamed = (book: FontBook, name: string): FontFamily | undefined => book.families.find((f) => same(f.family, name));
export const familiesServing = (book: FontBook, use: FontUse): FontFamily[] => book.families.filter((f) => f.serves?.includes(use));

// A style's stack as the engine uses it: every named family must ship, the fallbacks go after the style's own fonts
// and before the generic name, and nothing else is left for the computer to pick. Throws with what to do otherwise.
export function shippedStack(book: FontBook, stack: string, what: string): string {
  const names = familiesIn(stack);
  if (!names.length) throw new Error(`style ${what}: names no font`);
  const own: string[] = [];
  const generic: string[] = [];
  for (const name of names) {
    if (GENERIC.has(name)) {
      generic.push(name);
      continue;
    }
    const family = familyNamed(book, name);
    if (!family) throw new Error(`style ${what}: "${name}" has no font files in services/scenes/fonts. Add a folder there with the files, their licence and a font.json naming "${name}", or name one of: ${book.families.map((f) => f.family).join(", ")}`);
    own.push(family.family);
  }
  if (!own.length) throw new Error(`style ${what}: "${stack}" names only generic fonts, which differ from one computer to the next. Name a font from services/scenes/fonts`);
  const fallbacks = familiesServing(book, "fallback").map((f) => f.family).filter((f) => !own.includes(f));
  return [...own, ...fallbacks, ...(generic.length ? generic : ["sans-serif"])].map(quote).join(", ");
}

// The family a style gets when it names none: the one serving `use`.
export function defaultFamily(book: FontBook, use: "default" | "mono"): string {
  const family = familiesServing(book, use)[0];
  if (!family) throw new Error(`no font in services/scenes/fonts serves as ${use}: one font.json needs "serves": ["${use}"]`);
  return family.family;
}

// What a face says to the browser's FontFace: weights as CSS text, so a variable font covers its whole range.
export function faceDescriptors(face: ShippedFace): { weight: string; style: string; unicodeRange?: string; sizeAdjust?: string } {
  const weight = Array.isArray(face.weight) ? `${face.weight[0]} ${face.weight[1]}` : String(face.weight);
  return { weight, style: face.style ?? "normal", ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}), ...(face.sizeAdjust ? { sizeAdjust: face.sizeAdjust } : {}) };
}

// Every face of the book with where its file is, for a page to load before it draws or measures anything.
export type FaceToLoad = { family: string; url: string; descriptors: ReturnType<typeof faceDescriptors> };
export function facesToLoad(book: FontBook, urlOf: (family: FontFamily, file: string) => string): FaceToLoad[] {
  return book.families.flatMap((f) => f.faces.map((face) => ({ family: f.family, url: urlOf(f, face.file), descriptors: faceDescriptors(face) })));
}

// Checks one font.json as read from its folder. Pure, so it can run on what the browser bundle carries too.
export function checkFamily(raw: unknown, folder: string, has: (file: string) => boolean): FontFamily {
  const at = `fonts/${folder}/font.json`;
  const r = raw as Partial<FontFamily>;
  if (!r || typeof r !== "object") throw new Error(`${at}: not an object`);
  if (typeof r.family !== "string" || !r.family.trim()) throw new Error(`${at}: needs "family", the name styles use`);
  if (familiesIn(r.family).length !== 1 || GENERIC.has(r.family)) throw new Error(`${at}: "${r.family}" is not a usable family name`);
  if (typeof r.licence !== "string" || !/open font license|apache/i.test(r.licence)) throw new Error(`${at}: "licence" must be the SIL Open Font License or Apache 2.0, got ${String(r.licence)}`);
  if (!Array.isArray(r.licenceFiles) || !r.licenceFiles.length) throw new Error(`${at}: needs "licenceFiles", the licence text kept beside the fonts`);
  for (const file of r.licenceFiles) if (!has(file)) throw new Error(`${at}: licence file ${file} is missing`);
  if (typeof r.source !== "string" || !r.source) throw new Error(`${at}: needs "source", where the files came from`);
  for (const use of r.serves ?? []) if (!["fallback", "default", "mono"].includes(use)) throw new Error(`${at}: serves "${use}" is not one of fallback, default, mono`);
  if (!Array.isArray(r.faces) || !r.faces.length) throw new Error(`${at}: needs "faces", one per font file`);
  for (const face of r.faces) {
    if (typeof face.file !== "string" || !/\.(ttf|otf|woff2?)$/i.test(face.file)) throw new Error(`${at}: a face's file must be a .ttf, .otf, .woff or .woff2, got ${String(face.file)}`);
    if (!has(face.file)) throw new Error(`${at}: ${face.file} is missing`);
    const weights = Array.isArray(face.weight) ? face.weight : [face.weight];
    if (weights.length < 1 || weights.length > 2 || weights.some((w) => typeof w !== "number" || w < 1 || w > 1000)) throw new Error(`${at}: ${face.file} weight must be 1 to 1000, or [from, to] for a variable font`);
    if (face.sizeAdjust !== undefined && !(/^\d+(\.\d+)?%$/.test(face.sizeAdjust) && parseFloat(face.sizeAdjust) >= 50 && parseFloat(face.sizeAdjust) <= 200)) throw new Error(`${at}: ${face.file} sizeAdjust must be a percentage from 50% to 200%, got ${String(face.sizeAdjust)}`);
  }
  return { family: r.family, folder, licence: r.licence, licenceFiles: r.licenceFiles, source: r.source, ...(r.serves ? { serves: r.serves } : {}), faces: r.faces };
}
