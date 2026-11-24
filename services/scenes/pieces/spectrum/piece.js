// A spectrum between two ends, with things set where they sit along it, each dropping into place as it is named:
// positions in a debate, how acidic, how formal, how risky; anything that runs from one pole to another.
const ends = items(args.ends).map(String);
const names = items(args.labels).map(String);
const where = items(args.positions).map(Number).map((v) => (v > 1 ? v / 100 : v));
const n = Math.min(names.length, where.length, 10);
const U = Math.min(W, H);
const L = clamp(U * 0.08, 44, 100);
const x0 = L * 0.6, x1 = W - L * 0.6;
const y = H * 0.5;
// The band shades from one end to the other in steps, so the direction reads without words.
const steps = 12;
for (let k = 0; k < steps; k++) {
  const a = lerp(x0, x1, k / steps), b = lerp(x0, x1, (k + 1) / steps);
  path("band" + k, { points: rect(a, y - L * 0.35, b - a + 1, L * 0.7), fill: k < steps / 2 ? "highlight" : "accent", stroke: "none", closed: 1, opacity: 0.25 + 0.6 * Math.abs(k + 0.5 - steps / 2) / (steps / 2) });
}
path("frame", { points: rect(x0, y - L * 0.35, x1 - x0, L * 0.7), stroke: "ink", strokeWidth: 4, fill: "none", closed: 1 });
// The two ends' names under the band's ends.
if (ends[0]) text("end0", { x: x0, y: y - L * 0.7 - L * 1.25 * 0.65, text: ends[0], size: fitSize(ends[0], L, W * 0.45), anchor: "start", color: "ink", weight: 800 });
if (ends[1]) text("end1", { x: x1, y: y - L * 0.7 - L * 1.25 * 0.65, text: ends[1], size: fitSize(ends[1], L, W * 0.45), anchor: "end", color: "ink", weight: 800 });
// Things: a marker at their place and their name on a level below or above the band, chosen so that no name touches
// another and no stem from the band to a name runs through another name.
const at = beats(n, args.when, names);
const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => where[a] - where[b]);
const rowH = L * 1.25;
const taken = { 1: [], [-1]: [] }; // per side: { d, a, b } label spans
const stems = { 1: [], [-1]: [] }; // per side: { d, x }
if (ends[0]) taken[-1].push({ d: 1, a: x0, b: x0 + textWidth(ends[0], L) });
if (ends[1]) taken[-1].push({ d: 1, a: x1 - textWidth(ends[1], L), b: x1 });
const pad = L * 0.35;
for (const i of order) {
  const px = lerp(x0, x1, clamp(where[i], 0, 1));
  const size = fitSize(names[i], L * 0.85, W);
  const w = textWidth(names[i], size);
  const a = clamp(px - w / 2, 0, W - w), b = a + w;
  let pick = null;
  for (let d = 1; d <= 6 && !pick; d++) for (const s of [1, -1]) {
    const free = taken[s].every((t) => (t.d === d ? t.b + pad < a || t.a - pad > b : t.d > d || px < t.a - pad / 2 || px > t.b + pad / 2));
    const clear = stems[s].every((t) => t.d <= d || t.x < a - pad / 2 || t.x > b + pad / 2);
    if (free && clear) { pick = { s, d }; break; }
  }
  pick = pick || { s: 1, d: 7 };
  taken[pick.s].push({ d: pick.d, a, b });
  stems[pick.s].push({ d: pick.d, x: px });
  const ly = y + pick.s * (L * 0.35 + L * 0.35 + pick.d * rowH - rowH * 0.35);
  const edge = y + pick.s * L * 0.42;
  appear(path("stem" + i, { points: [px, edge, px, ly - pick.s * L * 0.5], stroke: "ink", strokeWidth: 3 }), at[i], "draw", 10);
  appear(text("name" + i, { x: (a + b) / 2, y: ly, text: names[i], size, color: "ink", weight: 700 }), at[i] + 4);
  appear(path("mark" + i, { x: px, y, points: circle(0, 0, L * 0.3), fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 }), at[i], "pop");
}
