// Bodies circling a centre on their own rings, each taking the time its period gives, so faster inner ones lap slower
// outer ones: planets and moons, electrons in shells, satellites, anything that goes round something else.
const centre = String(args.centre || "");
const names = items(args.bodies).map(String).slice(0, 6);
const periods = items(args.periods).map(Number);
const n = names.length;
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
const R = Math.min(W, H) / 2 - L * 0.9;
const cx = W / 2, cy = H / 2;
const core = Math.max(L * 0.8, R * 0.16, centre ? textWidth(centre, L * 0.9) / 2 + L * 0.3 : 0);
path("core", { x: cx, y: cy, points: circle(0, 0, core, 40), fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
if (centre) text("centre", { x: cx, y: cy, text: centre, size: fitSize(centre, L * 0.9, W * 0.5), color: "ink", weight: 800 });
const at = beats(n, args.when, names);
// Rings from just outside the core to the edge; a body's angle advances at TAU per period, from its own start.
const speedUp = Number(args.speed) || 1;
names.forEach((nm, i) => {
  const r = core + L * 1.7 + ((R - core - L * 1.7) * i) / Math.max(1, n - 1);
  path("ring" + i, { x: cx, y: cy, points: circle(0, 0, r, 72), stroke: "ink", strokeWidth: 2, fill: "none", opacity: 0.6 });
  const p = Math.max(0.2, periods[i] || i + 1);
  const a0 = -Math.PI / 2 + i * 1.3;
  const turn = (f) => a0 + (TAU * Math.max(0, f - at[i]) * speedUp) / (p * fps * 2);
  const size = clamp(L * 0.28 + i * L * 0.02, L * 0.24, L * 0.45);
  const b = path("body" + i, { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r, points: circle(0, 0, size, 20), fill: i % 2 ? "accent" : "ink", stroke: "ink", strokeWidth: 3, closed: 1 });
  appear(b, at[i], "pop");
  anim(b, "x", at[i], T1, (t, f) => cx + Math.cos(turn(f)) * r, 2);
  anim(b, "y", at[i], T1, (t, f) => cy + Math.sin(turn(f)) * r, 2);
  // The name rides along just outside its body, on a small card of the surface's colour so the rings never cross it.
  const w = textWidth(nm, L * 0.85);
  const card = path("card" + i, { x: 0, y: 0, points: rect(-w / 2 - L * 0.15, -L * 0.5, w + L * 0.3, L * 1.0), fill: "paper", stroke: "none", closed: 1 });
  const t = text("name" + i, { x: 0, y: 0, text: nm, size: L * 0.85, color: "ink", weight: 700 });
  for (const id of [card, t]) {
    appear(id, at[i] + 4);
    anim(id, "x", at[i], T1, (q, f) => clamp(cx + Math.cos(turn(f)) * r, w / 2 + L * 0.2, W - w / 2 - L * 0.2), 2);
    anim(id, "y", at[i], T1, (q, f) => clamp(cy + Math.sin(turn(f)) * r - size - L * 0.65, L * 0.5, H - L * 0.5), 2);
  }
});
