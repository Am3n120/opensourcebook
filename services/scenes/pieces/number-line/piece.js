const lo = Number(args.from), hi = Number(args.to);
const marks = items(args.marks).map(Number).filter((v) => Number.isFinite(v));
const names = items(args.names).map(String);
const hops = items(args.hops).map(Number).filter((v) => Number.isFinite(v));
const U = Math.min(W, H);
const L = clamp(W * 0.078, 42, 96);
const y = hops.some((h) => h < 0) ? H * 0.5 : H * 0.72;
const x0 = L * 0.8, x1 = W - L * 0.8;
const X = (v) => lerp(x0, x1, (v - lo) / (hi - lo || 1));
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
path("line", { points: [x0 - L * 0.5, y, x1 + L * 0.5, y], stroke: "ink", strokeWidth: 6 });
path("left", { x: x0 - L * 0.5, y, points: [L * 0.45, -L * 0.3, 0, 0, L * 0.45, L * 0.3], stroke: "ink", strokeWidth: 6, fill: "none" });
path("right", { x: x1 + L * 0.5, y, points: [-L * 0.45, -L * 0.3, 0, 0, -L * 0.45, L * 0.3], stroke: "ink", strokeWidth: 6, fill: "none" });
// Ticks at a step that leaves room for their numbers.
const span = hi - lo || 1;
const widest = Math.max(textWidth(fmt(lo), L * 0.9), textWidth(fmt(hi), L * 0.9));
const fit = Math.max(2, Math.floor((x1 - x0) / (widest + L * 0.8)));
const raw = span / fit;
const mag = Math.pow(10, Math.floor(Math.log10(raw)));
const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
let t = 0;
for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
  path("tick" + t, { points: [X(v), y - L * 0.35, X(v), y + L * 0.35], stroke: "ink", strokeWidth: 4 });
  text("num" + t, { x: X(v), y: y + L * 1.05, text: fmt(Math.round(v / step) * step), size: L * 0.9, color: "ink", opacity: 0.8 });
  t++;
}
const at = beats(marks.length + hops.length, args.when, names.concat(hops.map(fmt)));
// Marks: a dot on the line, its name above, staggered up when names would touch.
let lastRight = -1e9, lift = 0;
marks.forEach((v, i) => {
  const dot = path("mark" + i, { x: X(v), y, points: circle(0, 0, L * 0.32), fill: i === marks.length - 1 && args.lastIsKey ? "accent" : "highlight", stroke: "ink", strokeWidth: 4 });
  appear(dot, at[i], "pop");
  const label = names[i] ?? fmt(v);
  const w = textWidth(label, L);
  lift = X(v) - w / 2 < lastRight + L * 0.3 ? (lift + 1) % 3 : 0;
  lastRight = X(v) + w / 2;
  const ly = y - L * (1.3 + lift * 1.15);
  const lx = clamp(X(v), w / 2, W - w / 2);
  if (lift) appear(path("stem" + i, { points: [X(v), y - L * 0.4, X(v), ly + L * 0.5], stroke: "ink", strokeWidth: 2, opacity: 0.5 }), at[i]);
  appear(text("name" + i, { x: lx, y: ly, text: label, size: L, color: "ink", weight: 700 }), at[i] + 4);
});
// Hops: arcs from one value to the next, each with its difference, as a count or a sum is walked along the line.
const start = args.start !== "" && args.start !== undefined ? Number(args.start) : (marks[0] ?? lo);
let here = start;
// Forward hops arc over the line, backward ones under its numbers, each as high as the room on its side allows.
const roomUp = y - L * 2.4, roomDown = H - (y + L * 2.2) - L * 1.3;
hops.forEach((h, i) => {
  const a = X(here), b = X(here + h);
  const up = h >= 0;
  const base = up ? y - L * 0.45 : y + L * 1.75;
  const bend = Math.max(L, Math.min(Math.abs(b - a) * 0.45, up ? roomUp : roomDown)) * (up ? -1 : 1);
  const arcPts = [];
  for (let k = 0; k <= 24; k++) arcPts.push(lerp(a, b, k / 24), base + Math.sin((Math.PI * k) / 24) * bend);
  const f = at[marks.length + i];
  appear(path("hop" + i, { points: arcPts, stroke: "accent", strokeWidth: 7, fill: "none" }), f, "draw", 18);
  const d = up ? -1 : 1;
  const head = path("hophead" + i, { x: b, y: base, points: [-L * 0.32, d * L * 0.4, 0, 0, L * 0.32, d * L * 0.4], stroke: "accent", strokeWidth: 7, fill: "none" });
  appear(head, f + 16);
  appear(text("hopnum" + i, { x: (a + b) / 2, y: base + bend + d * L * 0.75, text: (h > 0 ? "+" : "") + fmt(h), size: L, color: "accent", weight: 700 }), f + 10);
  here += h;
  const land = path("land" + i, { x: b, y, points: circle(0, 0, L * 0.26), fill: "accent", stroke: "ink", strokeWidth: 3 });
  appear(land, f + 18, "pop");
});
