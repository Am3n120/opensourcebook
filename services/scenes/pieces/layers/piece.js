// A cross-section of layers stacked top to bottom, each band as thick as it really is (or evenly), revealed in turn as
// it is named, with its name and a note beside it, and a marker that can go down through them: the Earth's layers,
// soil and rock, the atmosphere, skin, a road, the layers of a system or a society.
const names = items(args.layers).map(String).slice(0, 8);
const thick = items(args.sizes).map(Number);
const notes = String(args.notes || "").split("|").map((s) => s.trim());
const n = Math.max(1, names.length);
const U = Math.min(W, H);
const L = clamp(U * 0.08, 44, 100);
const bandW = W * 0.42;
const sizes = names.map((_, i) => (thick[i] > 0 ? thick[i] : 1));
const sum = sizes.reduce((a, b) => a + b, 0);
// Each band gets at least enough height for its name.
const minH = L * 1.5;
const avail = H - L * 0.6;
let hs = sizes.map((s) => Math.max(minH, (s / sum) * avail));
const scale = avail / hs.reduce((a, b) => a + b, 0);
hs = hs.map((h) => Math.max(minH * Math.min(1, scale), h * scale));
const fills = ["highlight", "paper", "accent", "paper"];
const at = beats(n, args.when, names);
let y = L * 0.3;
const tops = [];
names.forEach((nm, i) => {
  tops.push(y);
  const h = hs[i];
  // A band with a wavy top edge, as layers in the ground or in tissue are never ruled straight.
  const wave = (x) => Math.sin(x / bandW * TAU * 1.5 + i) * Math.min(h * 0.08, L * 0.18);
  const topEdge = [];
  for (let k = 0; k <= 16; k++) topEdge.push((bandW * k) / 16, i ? wave((bandW * k) / 16) : 0);
  const band = path("band" + i, { x: 0, y, points: topEdge.concat([bandW, h, 0, h]), fill: fills[i % fills.length], stroke: "ink", strokeWidth: 4, closed: 1, opacity: 0 });
  key(band, "opacity", T0, i === 0 ? 1 : 0.35);
  key(band, "opacity", at[i], i === 0 ? 1 : 0.35, "step");
  key(band, "opacity", at[i] + 10, 1, "smooth");
  // The name and note to the right of the band, with a short leader to it.
  const tx = bandW + L * 0.8;
  const room = W - tx;
  appear(path("lead" + i, { points: [bandW - L * 0.3, y + h / 2, tx - L * 0.2, y + h / 2], stroke: "ink", strokeWidth: 3 }), at[i], "draw", 8);
  const ny = notes[i] ? y + h / 2 - L * 0.5 : y + h / 2;
  appear(text("name" + i, { x: tx, y: ny, text: nm, size: fitSize(nm, L, room), anchor: "start", color: "ink", weight: 800 }), at[i] + 3);
  if (notes[i]) appear(text("note" + i, { x: tx, y: ny + L * 1.0, text: notes[i], size: fitSize(notes[i], L * 0.85, room), anchor: "start", color: "accent", weight: 700 }), at[i] + 6);
  y += h;
});
// A probe that sinks through the layers, one band per moment, when asked.
if (String(args.probe) === "1") {
  const p = path("probe", { x: bandW * 0.5, y: L * 0.3, points: [0, 0, -L * 0.35, -L * 0.7, L * 0.35, -L * 0.7, 0, 0], fill: "ink", stroke: "ink", strokeWidth: 3, closed: 1 });
  appear(p, at[0]);
  names.forEach((_, i) => { key(p, "y", at[i], i ? tops[i - 1] + hs[i - 1] * 0.5 : L * 0.3); key(p, "y", at[i] + 14, tops[i] + hs[i] * 0.5, "smooth"); });
}
