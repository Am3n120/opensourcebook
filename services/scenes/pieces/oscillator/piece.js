// A pendulum or a mass on a spring, stepped by its real equation of motion with damping, so its swing slows and dies
// away as a real one does; a trace of its position over time can run beside it.
const kind = String(args.kind || "pendulum");
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const period = Math.max(0.3, Number(args.period) || 2); // seconds for one swing there and back
const damping = clamp(Number(args.damping) || 0, 0, 2);
const start = clamp(Number(args.start) || 0.8, 0.05, 1);
const go = beats(1, args.when, undefined)[0];
const trace = String(args.trace) === "1";
const w0 = TAU / period;
// The motion: x'' = -w0² x - 2ζw0 x', stepped finely, sampled each frame. x runs from -1 to 1 of the swing.
const pos = [];
let x = start, v = 0;
const dt = 1 / fps / 8;
for (let f = 0; f <= frames; f++) {
  pos.push(f < go ? start : x);
  if (f >= go) for (let k = 0; k < 8; k++) { const a = -w0 * w0 * x - 2 * damping * 0.1 * w0 * v; v += a * dt; x += v * dt; }
}
const at = (f) => pos[clamp(Math.round(f), 0, pos.length - 1)];
const area = trace ? { w: W * 0.45, h: H } : { w: W, h: H };
if (kind === "spring") {
  // A ceiling, a coil from it, and a weight at its end that bobs up and down.
  const cx = area.w / 2, top = L * 0.6, rest = H * 0.55, swing = H * 0.18 * 1;
  path("ceiling", { points: [cx - L * 2.2, top, cx + L * 2.2, top], stroke: "ink", strokeWidth: 8 });
  for (let k = 0; k < 6; k++) path("hatch" + k, { points: [cx - L * 2 + k * L * 0.8, top, cx - L * 2.3 + k * L * 0.8, top - L * 0.35], stroke: "ink", strokeWidth: 3 });
  const coil = (y) => { const p = [cx, top]; const n = 14; for (let i = 1; i < n; i++) p.push(cx + (i % 2 ? -1 : 1) * L * 0.7, top + L * 0.4 + ((y - top - L * 0.8) * i) / n); p.push(cx, y - L * 0.4, cx, y); return p; };
  const spring = path("spring", { points: coil(rest - start * swing), stroke: "ink", strokeWidth: 6, fill: "none" });
  const s = L * 1.3;
  const mass = path("mass", { x: cx, y: rest - start * swing, points: rect(-s / 2, 0, s, s), fill: "accent", stroke: "ink", strokeWidth: 5, closed: 1 });
  anim(spring, "points", T0, T1, (t, f) => coil(rest + at(f) * swing * -1), 1);
  anim(mass, "y", T0, T1, (t, f) => rest - at(f) * swing, 1);
  path("restline", { points: [cx + s * 0.8, rest + s / 2, cx + s * 1.8, rest + s / 2], stroke: "ink", strokeWidth: 3, opacity: 0.4 });
  text("restName", { x: cx + s * 1.9, y: rest + s / 2, text: String(args.restName || "rest"), size: L * 0.9, anchor: "start", color: "ink", opacity: 0.8 });
} else {
  // A pivot, a rod and a bob that swings through its arc, with the arc it sweeps drawn faintly.
  const cx = area.w / 2, top = L * 0.6;
  const len = Math.min(H - L * 2.6, area.w * 0.9);
  const maxA = (Math.PI / 4) * 1;
  path("beam", { points: [cx - L * 1.6, top, cx + L * 1.6, top], stroke: "ink", strokeWidth: 8 });
  path("sweep", { points: arc(cx, top, len, Math.PI / 2 - maxA * start, Math.PI / 2 + maxA * start, 32), stroke: "ink", strokeWidth: 3, fill: "none", opacity: 0.3 });
  path("plumb", { points: [cx, top, cx, top + len], stroke: "ink", strokeWidth: 2, opacity: 0.3 });
  const g = group("arm", { x: cx, y: top, rotate: start * maxA * (180 / Math.PI) });
  path("rod", { parent: g, points: [0, 0, 0, len], stroke: "ink", strokeWidth: 6 });
  path("bob", { parent: g, points: circle(0, len, L * 0.75), fill: "accent", stroke: "ink", strokeWidth: 5, closed: 1 });
  path("pivot", { x: cx, y: top, points: circle(0, 0, L * 0.22), fill: "ink", closed: 1 });
  anim(g, "rotate", T0, T1, (t, f) => at(f) * maxA * (180 / Math.PI) * -1, 1);
}
if (trace) {
  // Position over time, drawn as it happens, so the slowing swing shows as a shrinking curve.
  const x0 = W * 0.52, w = W - x0, mid = H * 0.5, hh = H * 0.32;
  path("taxis", { points: [x0, mid, W, mid], stroke: "ink", strokeWidth: 3, opacity: 0.5 });
  path("tup", { points: [x0, mid - hh - L * 0.3, x0, mid + hh + L * 0.3], stroke: "ink", strokeWidth: 3, opacity: 0.5 });
  text("tname", { x: x0 + w / 2, y: mid + hh + L * 1.0, text: String(args.traceName || "position over time"), size: fitSize(String(args.traceName || "position over time"), L * 0.9, w * 0.95), color: "ink" });
  const pts = [];
  for (let f = T0; f <= T1; f += 2) pts.push(x0 + ((f - T0) / Math.max(1, T1 - T0)) * w, mid - at(f) * hh);
  const tr = path("trace", { points: pts.length >= 4 ? pts : [x0, mid, W, mid], stroke: "accent", strokeWidth: 6, fill: "none" });
  anim(tr, "drawn", T0, T1, (t) => t, 3);
}
