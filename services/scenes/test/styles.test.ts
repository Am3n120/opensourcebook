/**
 * Styles as worlds: which styles are offered, what a style left half written inherits, how a style reaches captions,
 * cuts, letters and programs, and the traits that make each offered style its own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "../engine/core/types.ts";
import { themeFrom } from "../engine/render/theme.ts";
import { CAPTION_DEFAULT, FEELS, HALO_DEFAULT, resolveStyle } from "../engine/style/format.ts";
import { paintPath, paintText } from "../engine/style/paint.ts";
import { runProgram } from "../engine/language/sandbox.ts";
import { turnPrompt } from "../src/prompt.ts";
import { allStyles, listStyles, readStyles } from "../src/styles.ts";
import { sceneLook } from "../video/look.ts";
import { captions } from "../pipeline/stages/timeline.ts";

const PALETTE = { paper: "#ffffff", ink: "#111111", accent: "#c03030", highlight: "#ffd93d" };

test("a style is offered unless its file says it is not, and every style kept still draws", () => {
  const files: Record<string, { label: string; description?: string; offered?: unknown }> = {
    a: { label: "A", description: "one" },
    b: { label: "B", description: "two", offered: false },
    c: { label: "C", description: "three", offered: true },
  };
  const read = readStyles(Object.keys(files), (id) => files[id] as never);
  assert.deepEqual(read.map((s) => [s.id, s.offered]), [["a", true], ["b", false], ["c", true]]);
  assert.throws(() => readStyles(["x"], () => ({ label: "X", description: "x", offered: "no" }) as never), /offered must be true or false/);
  assert.throws(() => readStyles(["x"], () => ({ label: "X" }) as never), /no description/);

  const all = allStyles();
  const offered = listStyles();
  assert.ok(offered.length >= 3 && offered.length <= all.length, `${offered.length} of ${all.length} offered`);
  assert.ok(offered.every((s) => s.offered));
  // Offered ones come first, so a default pick (the first style) is always one that is offered.
  assert.deepEqual(all.slice(0, offered.length), offered);
  for (const s of all) assert.ok(themeFrom(s.id).design, s.id);
});

test("the agent picking a style is shown only the offered ones; a request that names a kept one gets its description", () => {
  const request = { title: "T", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 60, style: "auto", passages: [], limits: { minScenes: 2, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4 } } as never;
  // One style kept but not offered, whether or not the folder has one today.
  const [hidden, ...offered] = allStyles();
  const prompt = turnPrompt(request, offered);
  for (const s of allStyles()) assert.equal(prompt.includes(`- ${s.id} (`), s !== hidden, s.id);
  const named = turnPrompt({ ...(request as object), style: hidden!.id } as never, offered);
  assert.ok(named.includes(hidden!.description));
});

test("a style that leaves its world unsaid inherits it: captions, the rim round letters, and how scenes change", () => {
  const s = resolveStyle({ palette: PALETTE });
  assert.deepEqual(s.caption, CAPTION_DEFAULT);
  assert.equal(s.type.halo, HALO_DEFAULT);
  assert.equal(s.motion.cut, FEELS.steady.cut);
  assert.equal(s.motion.write, 0);
  const calm = resolveStyle({ palette: PALETTE, render: { motion: { feel: "calm" } } });
  assert.equal(calm.motion.cut, "dip");
  assert.equal(calm.motion.write, 1);
  const own = resolveStyle({ palette: PALETTE, render: { motion: { feel: "calm", cut: "wipe", write: 0 }, caption: { kind: "strip" }, type: { halo: 0 } } });
  assert.deepEqual([own.motion.cut, own.motion.write, own.caption!.kind, own.caption!.size, own.type.halo], ["wipe", 0, "strip", CAPTION_DEFAULT.size, 0]);
  assert.throws(() => resolveStyle({ palette: PALETTE, render: { motion: { cut: "spin" } } }), /motion.cut/);
  assert.throws(() => resolveStyle({ palette: PALETTE, render: { caption: { kind: "big" } } }), /caption.kind/);
  assert.throws(() => resolveStyle({ palette: PALETTE, render: { caption: { size: 200 } } }), /caption.size/);
});

test("words get a rim of what they sit on, so a line behind them never touches them; a glowing style keeps its light", () => {
  const theme = themeFrom(listStyles()[0]!.id);
  const pen = theme.style!;
  const page = theme.colors.paper!;
  const onPage = paintText({ text: "label", size: 60, color: theme.colors.ink }, "t", theme, { ...pen, type: { ...pen.type, glow: 0, halo: 0.5 } }, page);
  assert.equal(onPage.halo?.color, page);
  assert.ok(onPage.halo!.width >= 2);
  const onShape = paintText({ text: "label", size: 60, color: theme.colors.ink, on: "accent" }, "t", theme, { ...pen, type: { ...pen.type, glow: 0, halo: 0.5 } }, page);
  assert.equal(onShape.halo?.color, theme.colors.accent);
  assert.equal(paintText({ text: "x", size: 60, color: theme.colors.ink }, "t", theme, { ...pen, type: { ...pen.type, glow: 0, halo: 0 } }, page).halo, undefined);
  assert.equal(paintText({ text: "x", size: 60, color: theme.colors.ink }, "t", theme, { ...pen, type: { ...pen.type, glow: 1, halo: 0.5 } }, page).halo, undefined);
});

test("captions are the style's own: words on its caption strip, or words with a rim of its page", () => {
  for (const s of allStyles()) {
    const theme = themeFrom(s.id) as Theme;
    const look = sceneLook(theme);
    const kind = theme.style!.caption!.kind;
    assert.equal(look.size, theme.style!.caption!.size, s.id);
    if (kind === "strip") {
      assert.equal(look.strip?.back, theme.colors[theme.design!.roles.caption.back!], s.id);
      assert.notEqual(look.highlight, look.strip!.back, s.id);
    } else {
      assert.equal(look.strip, undefined, s.id);
      assert.equal(look.outline, theme.colors.paper, s.id);
      assert.equal(look.stroke > 0, kind === "outline", s.id);
    }
  }
});

test("a program lays words out in the style's own letters when the build measured them", async () => {
  const input = { W: 1000, H: 1000, T0: 0, T1: 10, fps: 30, frames: 11, seed: 1, args: {}, on: {}, words: [], colors: ["ink"] };
  const program = 'measure("w", 0, textWidth("MMMM", 100)); measure("t", 0, textWidth("MMMM", 100, "title")); measure("lines", 0, wrapText("aa aa aa aa", 100, 300).length);';
  const guessed = await runProgram(program, input);
  const wide = { body: { M: 2, a: 1, " ": 0.5 }, title: { M: 0.25 }, mono: {} };
  const measured = await runProgram(program, { ...input, widths: wide });
  assert.ok(guessed.ok && measured.ok);
  const read = (r: typeof guessed, name: string) => (r.ok ? r.output.measures!.find((m) => m.name === name)!.value : NaN);
  assert.ok(Math.abs(read(measured, "w") - 4 * 2 * 100 * 1.03) < 1e-6);
  assert.ok(Math.abs(read(measured, "t") - 4 * 0.25 * 100 * 1.03) < 1e-6);
  assert.ok(read(guessed, "w") < read(measured, "w"));
  assert.equal(read(measured, "lines"), 4);
});

// What makes each offered style a world of its own, guarded so a later change that flattens one is seen. Read from the
// files by what they say they are, so a style that is added or dropped needs no change here.
test("each offered style keeps the traits of its world", () => {
  const seen = new Set<string>();
  for (const s of listStyles()) {
    const theme = themeFrom(s.id);
    const pen = theme.style!;
    // A world: its own line, page, way in and change between scenes, not only a palette.
    const signature = JSON.stringify([pen.line.pen, pen.fill.kind, pen.surface.kind, pen.motion.enter, pen.motion.cut, pen.caption!.kind, theme.fonts.title]);
    assert.ok(!seen.has(signature), `${s.id} draws like another offered style`);
    seen.add(signature);
    assert.ok(s.description.length > 150 && /Suits /.test(s.description), `${s.id}: its description says what it looks like and what it suits`);
    // One accent for what matters: it stands apart from the page.
    assert.ok(theme.design!.roles.key.color === "accent" || theme.design!.roles.answer.color === "accent" || theme.design!.roles.key.back === "highlight", s.id);
    // Its line as drawn is its own: textured, tapered or ruled pens make more than one plain stroke layer.
    const layers = paintPath({ points: [0, 0, 200, 40, 400, 0], stroke: theme.colors.ink, strokeWidth: 6 }, "l", pen, theme.colors.paper!, theme.colors.accent!);
    if (pen.line.pen !== "vector") assert.ok(layers.length > 1 || layers.some((l) => l.fill), `${s.id}: its pen draws like a ${pen.line.pen}`);
  }
});

test("a style can hold longer caption pages, still broken at punctuation", () => {
  const text = "Water climbs up the tree without any pump at all, pulled from the leaves above".split(" ");
  const words = text.map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3, beatId: "s1" }));
  const p = { narration: { words, holds: [] }, script: { beats: [{ id: "s1", emphasis: [] }] } } as never;
  const sizes = (most?: number) => captions(p, [], most).map((c) => c.words.length);
  assert.ok(Math.max(...sizes()) <= 3);
  const long = sizes(6);
  assert.ok(Math.max(...long) <= 6 && Math.max(...long) > 3, JSON.stringify(long));
  assert.equal(captions(p, [], 6)[1]!.words.at(-1)!.text, "all", "a page still ends at a comma");
});
