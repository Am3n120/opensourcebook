const names = items(args.labels).map(String);
const vals = items(args.values).map(Number).filter((v) => v >= 0);
const n = Math.max(1, Math.min(vals.length, 8));
const total = vals.slice(0, n).reduce((a, b) => a + b, 0) || 1;
const lit = items(args.highlight).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.08, 40, 96);
const legendH = n * L * 1.5;
const r = Math.max(L * 2, Math.min(W * 0.42, (H - legendH - L * 1.2) / 2));
const cx = W / 2, cy = r + L * 0.3;
const hole = Number(args.ring) ? r * 0.55 : 0;
const fills = ["accent", "highlight", "paper", "soft", "ink"];
const fillOf = (i) => (lit.length ? (lit.includes(names[i]) ? "accent" : i % 2 ? "paper" : "highlight") : fills[i % fills.length]);
const at = beats(n, args.when, names);
let a = -Math.PI / 2;
for (let i = 0; i < n; i++) {
  const share = vals[i] / total;
  const b = a + share * TAU;
  const steps = Math.max(2, Math.ceil(share * 64));
  const outer = arc(0, 0, r, a, b, steps);
  const inner = hole ? arc(0, 0, hole, b, a, steps) : [0, 0];
  const s = path("slice" + i, { x: cx, y: cy, points: outer.concat(inner, outer.slice(0, 2)), fill: fillOf(i), stroke: "ink", strokeWidth: 4, closed: 1 });
  appear(s, at[i], "pop", 14);
  const pct = Math.round(share * 100) + "%";
  // The legend: a swatch, the name and the share, one row each under the circle.
  const ly = cy + r + L * 1.3 + i * L * 1.5;
  const sw = path("swatch" + i, { x: L * 0.2, y: ly - L * 0.4, points: rect(0, 0, L * 0.8, L * 0.8), fill: fillOf(i), stroke: "ink", strokeWidth: 3, closed: 1 });
  appear(sw, at[i]);
  const label = names[i] ?? "";
  const pw = textWidth(pct, L);
  appear(text("pct" + i, { x: W, y: ly, text: pct, size: L, anchor: "end", color: "ink", weight: 700 }), at[i] + 4);
  appear(text("name" + i, { x: L * 1.4, y: ly, text: label, size: fitSize(label, L, W - L * 2.2 - pw), anchor: "start", color: "ink", weight: lit.includes(names[i]) ? 700 : 400 }), at[i] + 4);
  a = b;
}
if (hole && args.middle) appear(text("middle", { x: cx, y: cy, text: String(args.middle), size: fitSize(String(args.middle), L * 1.3, hole * 1.7), color: "ink", weight: 700 }), at[n - 1] + 10);
