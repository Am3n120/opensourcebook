// A container whose contents rise and fall to each level as it is said, with marks on its side: a tank, a jar, a
// tube or a battery; how full something is, a reserve that drains, a dose, a charge.
const levels = items(args.levels).map(Number).filter((v) => Number.isFinite(v)).map((v) => (v > 1 ? v / 100 : v));
const marks = items(args.marks).map(String);
const shape = String(args.shape || "tank");
const U = Math.min(W, H);
const L = clamp(U * 0.075, 40, 90);
const labelRoom = Math.max(L * 2.5, ...marks.map((m) => textWidth(m, L * 0.85) + L * 0.8));
const ch = H - L * 2.4;
const cw = Math.min(W - labelRoom - L, shape === "tube" ? ch * 0.28 : shape === "battery" ? ch * 0.5 : ch * 0.72);
const x0 = (W - labelRoom - cw) / 2, y0 = L * 0.6;
const inner = { x: x0 + 10, y: y0 + (shape === "jar" ? ch * 0.12 : shape === "battery" ? ch * 0.06 : 10), w: cw - 20 };
inner.h = y0 + ch - 10 - inner.y;
// The outline of the container, drawn in the style's line.
let outline;
if (shape === "jar") {
  const neck = cw * 0.62, nx = x0 + (cw - neck) / 2;
  outline = [nx, y0, nx, y0 + ch * 0.08, x0, y0 + ch * 0.16, x0, y0 + ch, x0 + cw, y0 + ch, x0 + cw, y0 + ch * 0.16, nx + neck, y0 + ch * 0.08, nx + neck, y0];
  path("lid", { points: rect(nx - 8, y0 - L * 0.5, neck + 16, L * 0.5), fill: "ink", stroke: "ink", strokeWidth: 4, closed: 1 });
} else if (shape === "battery") {
  outline = rect(x0, y0 + ch * 0.04, cw, ch * 0.96);
  path("cap", { points: rect(x0 + cw * 0.32, y0 - ch * 0.01, cw * 0.36, ch * 0.05), fill: "ink", stroke: "ink", strokeWidth: 4, closed: 1 });
} else if (shape === "tube") {
  outline = [x0, y0].concat(arc(x0 + cw / 2, y0 + ch - cw / 2, cw / 2, Math.PI, 0, 16), [x0 + cw, y0]);
} else outline = rect(x0, y0, cw, ch);
// The contents: a body that grows from the bottom, with a gently moving surface line.
const at = beats(levels.length, args.when, undefined);
const start = levels.length ? (args.start === "" || args.start === undefined ? 0 : Number(args.start) > 1 ? Number(args.start) / 100 : Number(args.start)) : 0;
const bottom = inner.y + inner.h;
const fill = path("contents", { x: inner.x, y: bottom, points: rect(0, -inner.h, inner.w, inner.h), fill: String(args.color || "highlight"), stroke: "none", scaleY: Math.max(0.001, start) });
const surface = path("surface", { x: inner.x, y: bottom - inner.h * start, points: curve(0, inner.w, (x) => Math.sin(x / inner.w * TAU * 2) * 5, 32), stroke: "accent", strokeWidth: 6, fill: "none" });
let lv = start;
levels.forEach((v, i) => {
  const span = 30 + Math.round(Math.abs(v - lv) * 40);
  key(fill, "scaleY", at[i], Math.max(0.001, lv));
  key(fill, "scaleY", at[i] + span, Math.max(0.001, v), "smooth");
  key(surface, "y", at[i], bottom - inner.h * lv);
  key(surface, "y", at[i] + span, bottom - inner.h * v, "smooth");
  lv = v;
});
anim(surface, "x", T0, T1, (t, f) => inner.x + Math.sin(f / 9) * 4, 3);
path("container", { points: outline, stroke: "ink", strokeWidth: 8, fill: "none", closed: shape === "tube" ? 0 : 1 });
// Marks up the side, evenly from empty to full, or at the levels given with "name@0.4".
const right = x0 + cw;
marks.forEach((m, i) => {
  const [name, where] = m.split("@");
  const p = where !== undefined ? Number(where) > 1 ? Number(where) / 100 : Number(where) : marks.length === 1 ? 1 : i / (marks.length - 1);
  const y = bottom - inner.h * p;
  path("tick" + i, { points: [right - L * 0.4, y, right + L * 0.25, y], stroke: "ink", strokeWidth: 5 });
  text("mark" + i, { x: right + L * 0.5, y, text: name, size: L * 0.85, anchor: "start", color: "ink" });
});
const readout = args.showPercent === "1" || args.showPercent === 1;
if (readout) {
  const r = text("percent", { x: x0 + cw / 2, y: y0 + ch + L * 1.15, text: Math.round(start * 100) + "%", size: L * 1.2, color: "ink", weight: 700 });
  let p = start;
  levels.forEach((v, i) => { const from = p; anim(r, "text", at[i], at[i] + 30, (t) => Math.round(lerp(from, v, smooth(t)) * 100) + "%", 3); p = v; });
}
