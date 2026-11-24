const ys = items(args.values).map(Number).filter((v) => Number.isFinite(v));
const ys2 = items(args.second).map(Number).filter((v) => Number.isFinite(v));
const xs = items(args.labels).map(String);
const n = Math.max(2, ys.length);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const L = clamp(U * 0.07, 38, 90);
const all = ys.concat(ys2);
let lo = Math.min(0, ...all), hi = Math.max(...all, lo + 1e-9);
const pad = (hi - lo) * 0.08;
hi += pad;
if (lo < 0) lo -= pad;
const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)) + unit;
const left = textWidth(fmt(Math.round(hi)), L * 0.9) + L * 0.6;
const right = Math.max(textWidth(fmt(ys[ys.length - 1] ?? 0), L) * 0.55, L);
const top = L * (args.name ? 2.2 : 0.8);
const bottom = H - L * 1.9;
const x0 = left, x1 = W - right;
const X = (i) => lerp(x0, x1, i / (n - 1));
const Y = (v) => lerp(bottom, top, (v - lo) / (hi - lo));
// Axes and a few faint guides, with the values they stand for.
path("axis", { points: [x0, top - L * 0.4, x0, bottom, x1 + right * 0.6, bottom], stroke: "ink", strokeWidth: 5 });
const raw = (hi - lo) / 3.5;
const mag = Math.pow(10, Math.floor(Math.log10(raw)));
const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
let g = 0;
for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
  if (Math.abs(v - lo) < step * 0.3) continue;
  const tv = Math.round(v / step) * step;
  path("guide" + g, { points: [x0, Y(tv), x1, Y(tv)], stroke: "ink", strokeWidth: 2, opacity: 0.2 });
  text("tick" + g, { x: x0 - L * 0.3, y: Y(tv), text: fmt(Math.round(tv * 1000) / 1000), size: L * 0.9, anchor: "end", color: "ink", opacity: 0.75 });
  g++;
}
// Labels under the axis: as many as fit, always the first and the last.
const every = Math.max(1, Math.ceil(Math.max(...xs.map((s) => textWidth(s, L * 0.9)), 1) / ((x1 - x0) / (n - 1) * 0.9)));
xs.slice(0, n).forEach((s, i) => {
  if (i % every && i !== n - 1) return;
  if (i !== n - 1 && n - 1 - i < every && i !== 0) return;
  text("x" + i, { x: X(i), y: bottom + L * 0.95, text: s, size: L * 0.9, color: "ink" });
});
if (args.name) text("name", { x: x0, y: L * 0.7, text: String(args.name), size: L, anchor: "start", color: "accent", weight: 700 });
const at = beats(n, args.when, xs);
const line = (id, vals, color, width, when) => {
  const pts = vals.flatMap((v, i) => [X(i), Y(v)]);
  const id2 = path(id, { points: pts, stroke: color, strokeWidth: width, fill: "none" });
  // The line reaches each point as its moment comes, drawn by length.
  const lens = [0];
  for (let i = 1; i < vals.length; i++) lens.push(lens[i - 1] + Math.hypot(X(i) - X(i - 1), Y(vals[i]) - Y(vals[i - 1])));
  const total = lens[lens.length - 1] || 1;
  key(id2, "drawn", T0, 0);
  for (let i = 0; i < vals.length; i++) key(id2, "drawn", when[i] + (i ? 14 : 0), lens[i] / total, i ? "smooth" : "step");
  const dot = path(id + "-head", { x: X(0), y: Y(vals[0]), points: circle(0, 0, width * 1.6), fill: color, stroke: "ink", strokeWidth: 3 });
  appear(dot, when[0], "pop");
  for (let i = 1; i < vals.length; i++) {
    key(dot, "x", when[i - 1] + (i > 1 ? 14 : 0), X(i - 1));
    key(dot, "x", when[i] + 14, X(i), "smooth");
    key(dot, "y", when[i - 1] + (i > 1 ? 14 : 0), Y(vals[i - 1]));
    key(dot, "y", when[i] + 14, Y(vals[i]), "smooth");
  }
  return pts;
};
line("line", ys, "accent", 11, at);
const end = text("last", { x: X(n - 1), y: Y(ys[n - 1]) - L * 1.1, text: fmt(ys[n - 1]), size: L * 1.15, color: "accent", weight: 700, anchor: "end" });
appear(end, at[n - 1] + 16);
if (ys2.length) {
  const at2 = beats(ys2.length, args.secondWhen, undefined, at[0], T1);
  line("line2", ys2, "ink", 6, at2.map((f, i) => Math.max(f, at[Math.min(i, at.length - 1)])));
  if (args.secondName) appear(text("name2", { x: X(ys2.length - 1), y: Y(ys2[ys2.length - 1]) + L * 0.95, text: String(args.secondName), size: L * 0.9, anchor: "end", color: "ink" }), at[n - 1] + 20);
}
