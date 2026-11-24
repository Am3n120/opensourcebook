import type { Theme } from "../engine/core/types.ts";
import { contrast } from "../engine/style/color.ts";

// How captions look. Over photos: white with a black outline. Over an engine scene: the style's own caption, as its
// file says (render.caption): plain words, words with a rim of the page, or words on the style's caption strip, in the
// caption role's font, weight and case, so a caption reads like part of the board and never like a sticker on it.
export type Look = {
  font: string;
  weight: number;
  size: number;
  upper: boolean;
  color: string;
  highlight: string;
  outline: string;
  stroke: number;
  strip?: { back: string; pad: number; rule?: string; ruleWidth: number; rotate: number; edge?: string };
};

export function sceneLook(theme: Theme): Look {
  const c = theme.colors;
  const pen = theme.style;
  const kind = pen?.caption?.kind ?? "outline";
  const size = pen?.caption?.size ?? 60;
  const role = theme.design?.roles.caption;
  const font = role?.font === "title" ? theme.fonts.title : role?.font === "mono" ? (theme.fonts.mono ?? theme.fonts.body) : theme.fonts.body;
  const weight = role?.weight ?? pen?.type.bold ?? 700;
  const upper = (role?.case ?? pen?.type.case) === "upper";
  const accent = c.accent!;
  const back = role?.back ? c[role.back] : undefined;
  if (kind === "strip" && back && theme.design) {
    const e = theme.design.elements.caption;
    const color = c[role!.color] ?? c.ink!;
    // The lit word must read on the strip: the accent where it does, else the style's highlight, else the strip's ink.
    const lit = [accent, c.highlight!, color].find((x) => !!x && contrast(x, back) >= 3) ?? color;
    return { font, weight, size, upper, color, highlight: lit, outline: back, stroke: 0, strip: { back, pad: e.pad, rule: e.rule !== "none" ? c[e.rule] : undefined, ruleWidth: e.ruleWidth, rotate: e.rotate, edge: e.edge !== "none" ? c[e.edge] : undefined } };
  }
  return { font, weight, size, upper, color: c.ink!, highlight: accent, outline: c.paper!, stroke: kind === "plain" ? 0 : Math.round(size * 0.15) };
}
