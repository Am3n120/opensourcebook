// Widths of words in the style's real fonts. The layout's built-in estimate knows no fonts, so a wide face (a chalk or
// display title, a heavy caption) came out wider on screen than planned and ran into the frame's edges. Each character's
// advance is measured once per font in the browser that renders the video (cached on disk), so laying out stays pure
// and fast: a width is a sum of known advances, plus the style's letter spacing.
import type { Theme } from "../core/types.ts";
import { measureMany } from "../kits/text-browser.ts";
import { estimate, type Measure } from "./layout.ts";

const CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ..."—–−×÷±≤≥≠≈→←↑↓↔⇒•·°√π∑∞²³¹½¼¾€£¥✓✗…‘’“”éèêàáçñöüäß"];
type Key = "body" | "title" | "mono";

// What a measured font says about a character: its advance in ems, the widest of regular and bold, since words are
// drawn bold when lit and must still fit.
export type FontTable = Record<Key, Record<string, number>>;

export function fontTable(theme: Theme): FontTable {
  const fonts: Record<Key, string> = { body: theme.fonts.body, title: theme.fonts.title, mono: theme.fonts.mono ?? theme.style?.type.mono ?? "Menlo, monospace" };
  const weights = [400, theme.style?.type.bold ?? 700];
  const keys = Object.keys(fonts) as Key[];
  const requests = keys.flatMap((k) => weights.flatMap((weight) => CHARS.map((c) => ({ clusters: [c], font: fonts[k], weight }))));
  const measured = measureMany(requests);
  const out = { body: {}, title: {}, mono: {} } as FontTable;
  let i = 0;
  for (const k of keys) for (const _w of weights) for (const c of CHARS) out[k][c] = Math.max(out[k][c] ?? 0, measured[i++]!.edges[0] ?? 0);
  return out;
}

// A measure from a font table. Text drawn in capitals by the style is measured in capitals; a character the table
// does not have is estimated, scaled by how this font compares with the estimate.
export function tableMeasure(table: FontTable, theme: Theme): Measure {
  const type = theme.style?.type;
  const ratio = {} as Record<Key, number>;
  for (const k of Object.keys(table) as Key[]) {
    const sample = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const real = [...sample].reduce((s, c) => s + (table[k][c] ?? 0), 0);
    ratio[k] = real > 0 ? real / estimate(sample, 1) : 1;
  }
  return (text, size, font) => {
    const k: Key = font === "mono" ? "mono" : font === "title" ? "title" : "body";
    const shown = type?.case === "upper" ? text.toUpperCase() : text;
    const chars = [...shown];
    const width = chars.reduce((s, c) => s + (table[k][c] ?? estimate(c, 1) * ratio[k]), 0);
    return Math.max(0.3, width + (type?.tracking ?? 0) * Math.max(0, chars.length - 1)) * size;
  };
}

const known = new Map<string, Measure>();
const named = new WeakMap<Measure, string>();
// The measure for a theme's fonts, built once per set of fonts.
export function fontMeasure(theme: Theme): Measure {
  const key = measureKey(theme);
  const hit = known.get(key);
  if (hit) return hit;
  const made = tableMeasure(fontTable(theme), theme);
  known.set(key, made);
  named.set(made, key);
  return made;
}
export const measureKey = (theme: Theme) => JSON.stringify([theme.fonts, theme.style?.type]);
// The name a built scene keeps of the measure it was laid out with (Scene.measure), so whatever reads the scene later
// (the checks on its frames) measures its words in the same fonts.
export const keyOf = (m: Measure | undefined) => (m ? named.get(m) : undefined);
// That measure again, when this process made it; nothing when it did not.
export const measureNamed = (key: string | undefined) => (key ? known.get(key) : undefined);

// Per character advances, in ems, for programs, which cannot call the browser: what the style really draws, capitals
// and letter spacing included, so a program that lays words out by hand puts them where they will be.
export function charWidths(measure: Measure): Record<"body" | "title" | "mono", Record<string, number>> {
  const out = { body: {}, title: {}, mono: {} } as Record<"body" | "title" | "mono", Record<string, number>>;
  for (const k of ["body", "title", "mono"] as const) for (const c of CHARS) out[k][c] = Math.round((measure(c.repeat(10), 100, k) / 1000) * 10000) / 10000;
  return out;
}
