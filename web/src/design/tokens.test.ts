/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// Tests run from web/.
const css = readFileSync(resolvePath("src/design/tokens.css"), "utf8");

/** The light and dark token sets, read from tokens.css as written; the dark set falls back to the light one. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

function resolve(set: Record<string, string>, value: string): string {
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  return ref ? resolve(set, set[ref[1]!]!) : value;
}
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(set: Record<string, string>, fg: string, bg: string): number {
  const [a, b] = [luminance(resolve(set, set[fg]!)), luminance(resolve(set, set[bg]!))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Text and the background it is drawn on, as the screens pair them.
const PAIRS: Array<[string, string]> = [
  ["text", "bg"], ["text", "surface"], ["text", "fill"], ["mutedText", "surface"], ["mutedText", "bg"], ["ink", "bg"], ["paperInk", "paper"], ["paperInk", "paperMark"], ["paperMuted", "paper"], ["paperMuted", "paperMark"], ["paperCite", "paperCiteBg"], ["paperCite", "paperMark"],
  ["primaryText", "primarySoft"], ["successText", "successSoft"], ["accentText", "accentSoft"], ["danger", "dangerSoft"], ["teal", "tealSoft"], ["info", "infoSoft"],
  ["onPrimary", "primary"], ["onInverse", "inverse"],
  ["accentText", "surface"], ["accentText", "bg"], ["successText", "surface"], ["danger", "surface"], ["text", "dangerSoft"], ["primaryText", "primaryGhost"], ["mutedText", "fill"], ["text", "accentSoft"], ["onSuccess", "success"], ["onSolid", "danger"],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, string] => [`fmt-${n}-fg`, `fmt-${n}-bg`]),
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s tokens", (_name, set) => {
  it.each(PAIRS)("%s on %s reads at 4.5:1 or more", (fg, bg) => {
    expect(contrast(set, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["bg", "surface", "fill"])("small muted words on %s read at 4.5:1 or more", (bg) => {
    expect(contrast(set, "muted", bg)).toBeGreaterThanOrEqual(4.5);
  });
});

test("the dark set changes only colours", () => {
  for (const key of Object.keys(block(':root[data-theme="dark"]'))) expect(key).not.toMatch(/^(fs|lh|space|r|dur|ease|font)-?/);
});
