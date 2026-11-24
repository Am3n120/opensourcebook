const lo = Number(args.min), hi = Number(args.max);
const vals = items(args.values).map(Number).filter((v) => Number.isFinite(v));
const zones = items(args.zones).map(String);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const L = clamp(U * 0.075, 40, 90);
// Zone names sit outside the band, on the surface, so they read in every style.
const zw = Math.max(0, ...zones.map((z) => textWidth(z, L * 0.9)));
const r = Math.max(L * 3, Math.min(W / 2 - (zones.length ? zw * 0.7 + L * 0.5 : L * 0.3), H - L * 5.8));
const cx = W / 2, cy = Math.max(0, (H - (r + L * 5.8)) / 2) + r + L * 1.8;
const A0 = Math.PI, A1 = Math.PI * 2; // a half dial, left to right over the top
const ang = (v) => lerp(A0, A1, clamp((v - lo) / (hi - lo || 1), 0, 1));
const dec = [lo, hi].concat(vals).every((v) => Number.isInteger(v)) ? 0 : 1;
const fmt = (v) => v.toFixed(dec) + unit;
const nz = Math.max(1, zones.length);
const zoneFill = (z) => (nz === 1 ? "highlight" : z === nz - 1 ? "accent" : z === 0 ? "paper" : "highlight");
for (let z = 0; z < nz; z++) {
  const a = lerp(A0, A1, z / nz), b = lerp(A0, A1, (z + 1) / nz);
  path("zone" + z, { x: cx, y: cy, points: arc(0, 0, r, a, b, 24).concat(arc(0, 0, r * 0.76, b, a, 24)), fill: zoneFill(z), stroke: "ink", strokeWidth: 4, closed: 1 });
  if (zones[z]) {
    const m = (a + b) / 2, side = Math.cos(m);
    const rr = r + L * 0.45;
    text("zname" + z, { x: cx + side * rr, y: cy + Math.sin(m) * rr - (Math.abs(side) < 0.4 ? L * 0.3 : 0), text: zones[z], size: L * 0.9, anchor: side > 0.4 ? "start" : side < -0.4 ? "end" : "middle", color: "ink", weight: 700 });
  }
}
for (let t = 0; t <= 10; t++) {
  const a = lerp(A0, A1, t / 10);
  path("tick" + t, { x: cx, y: cy, points: [Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7, Math.cos(a) * r * (t % 5 ? 0.64 : 0.58), Math.sin(a) * r * (t % 5 ? 0.64 : 0.58)], stroke: "ink", strokeWidth: t % 5 ? 3 : 5 });
}
text("lo", { x: cx - r * 0.88, y: cy + L * 0.75, text: fmt(lo), size: L * 0.9, color: "ink" });
text("hi", { x: cx + r * 0.88, y: cy + L * 0.75, text: fmt(hi), size: L * 0.9, color: "ink" });
// The needle, drawn pointing right (angle 0) and turned to each value as its moment comes.
const needle = path("needle", { x: cx, y: cy, points: [-r * 0.1, -L * 0.18, r * 0.68, 0, -r * 0.1, L * 0.18, -r * 0.1, -L * 0.18], fill: "ink", stroke: "ink", strokeWidth: 3, closed: 1, rotate: (ang(lo) * 180) / Math.PI });
path("hub", { x: cx, y: cy, points: circle(0, 0, L * 0.38), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 });
const at = beats(vals.length, args.when, vals.map(String));
const readout = text("value", { x: cx, y: cy + L * 1.8, text: fmt(lo), size: L * 1.5, color: "ink", weight: 700 });
if (args.label) text("label", { x: cx, y: cy + L * 3.3, text: String(args.label), size: fitSize(String(args.label), L * 0.9, W), color: "ink" });
key(needle, "rotate", T0, (ang(lo) * 180) / Math.PI);
vals.forEach((v, i) => {
  const from = i ? vals[i - 1] : lo;
  key(needle, "rotate", at[i], (ang(from) * 180) / Math.PI);
  key(needle, "rotate", at[i] + 24, (ang(v) * 180) / Math.PI, "overshoot");
  // The readout counts with the needle.
  anim(readout, "text", at[i], at[i] + 24, (t) => lerp(from, v, smooth(t)).toFixed(dec) + unit, 3);
});
