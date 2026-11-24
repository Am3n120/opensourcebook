// Stages around a ring joined by curved arrows, each stage arriving as it is named, then a marker that travels
// round and round: anything that repeats and comes back to its start.
const names = items(args.stages).map(String);
const n = Math.max(2, Math.min(names.length, 8));
const U = Math.min(W, H);
const L = clamp(U * 0.08, 46, 110);
// No stage sits level with the middle when half the stages is even, so every name can run outward clear of the ring.
const turn0 = (n / 2) % 2 === 0 ? Math.PI / n : 0;
const ang = (i) => -Math.PI / 2 + turn0 + (TAU * i) / n;
const node = L * 0.42;
const side = (i) => Math.abs(Math.cos(ang(i))) >= 0.3;
const wrapW = Math.min(W * 0.36, L * 6);
const lines = names.slice(0, n).map((s) => wrapText(s, L * 0.9, wrapW).slice(0, 2));
// Names run outward from their dot; the ring is as wide as the widest name on each side allows.
let R = H / 2 - L * 3.4;
for (let i = 0; i < n; i++) {
  if (!side(i)) continue;
  const w = Math.max(...lines[i].map((l) => textWidth(l, L * 0.9)));
  R = Math.min(R, (W / 2 - node - L * 0.45 - w) / Math.abs(Math.cos(ang(i))));
}
R = Math.max(L * 2.2, Math.min(R, W / 2 - node - L * 0.3));
// On a tall frame the ring stretches into an upright oval, using the height the names do not need.
const RY = Math.max(R, Math.min(H / 2 - L * 3.2, R * 1.7));
const cx = W / 2, cy = H / 2;
const P = (t) => ({ x: cx + Math.cos(t) * R, y: cy + Math.sin(t) * RY });
const ell = (a0, a1, k) => { const p = []; for (let j = 0; j <= k; j++) { const q = P(a0 + ((a1 - a0) * j) / k); p.push(q.x, q.y); } return p; };
const at = beats(n, args.when, names);
// The ring is there from the start, quiet, so the shape of the cycle is seen before its stages are named.
path("ring", { points: ell(0, TAU, 72), stroke: "ink", strokeWidth: 3, fill: "none", opacity: 0.6 });
for (let i = 0; i < n; i++) path("slot" + i, { x: P(ang(i)).x, y: P(ang(i)).y, points: circle(0, 0, node), fill: "paper", stroke: "ink", strokeWidth: 3, closed: 1, opacity: 0.6 });
for (let i = 0; i < n; i++) {
  const a = ang(i);
  const { x, y } = P(a);
  // The arrow to the next stage follows the ring, leaving room round each stage's dot.
  const gap = (node * 2.4) / Math.hypot(R * Math.sin(a), RY * Math.cos(a));
  const a0 = a + gap, a1 = ang(i + 1) - (node * 2.4) / Math.hypot(R * Math.sin(ang(i + 1)), RY * Math.cos(ang(i + 1)));
  const arrow = path("arc" + i, { points: ell(a0, a1, 24), stroke: "ink", strokeWidth: 6, fill: "none" });
  const h = P(a1);
  const dir = Math.atan2(Math.cos(a1) * RY, -Math.sin(a1) * R);
  const head = path("head" + i, { x: h.x, y: h.y, rotate: (dir * 180) / Math.PI, points: [-L * 0.4, -L * 0.3, 0, 0, -L * 0.4, L * 0.3], stroke: "ink", strokeWidth: 6, fill: "none" });
  const next = at[(i + 1) % n] > at[i] ? at[(i + 1) % n] : at[i] + 12;
  appear(arrow, next - 10, "draw", 14);
  appear(head, next + 2);
  appear(path("stage" + i, { x, y, points: circle(0, 0, node), fill: "accent", stroke: "ink", strokeWidth: 5, closed: 1 }), at[i], "pop");
  // The name runs outward from its dot: beside it on the sides, above or below it at the top and bottom.
  const c = Math.cos(a), s = Math.sin(a);
  const k0 = lines[i].length - 1;
  const anchor = side(i) ? (c > 0 ? "start" : "end") : "middle";
  const tx = side(i) ? x + (c > 0 ? 1 : -1) * (node + L * 0.3) : x;
  const ty0 = side(i) ? y - (k0 * L * 1.05) / 2 + (s > 0 ? L * 0.35 : -L * 0.35) : s < 0 ? y - node - L * 0.6 - k0 * L * 1.05 : y + node + L * 0.65;
  lines[i].forEach((l, k) => appear(text(`name${i}-${k}`, { x: tx, y: ty0 + k * L * 1.05, text: l, size: L * 0.9, anchor, color: "ink", weight: 700 }), at[i] + 6));
}
if (args.middle) {
  const mid = wrapText(String(args.middle), L, R * 1.3).slice(0, 3);
  mid.forEach((l, k) => appear(text("middle" + k, { x: cx, y: cy + (k - (mid.length - 1) / 2) * L * 1.15, text: l, size: L, color: "accent", weight: 700 }), at[n - 1] + 16));
}
// A marker that runs round the cycle after the last stage, one turn every few seconds.
if (args.run !== "0" && args.run !== 0) {
  const start = at[n - 1] + 20;
  const p0 = P(ang(0));
  const runner = path("runner", { x: p0.x, y: p0.y, points: circle(0, 0, node * 0.55), fill: "highlight", stroke: "ink", strokeWidth: 4, closed: 1, opacity: 0 });
  appear(runner, start);
  const turn = fps * (Number(args.turn) || 4);
  anim(runner, "x", start, T1, (t, f) => P(ang(0) + (TAU * (f - start)) / turn).x, 2);
  anim(runner, "y", start, T1, (t, f) => P(ang(0) + (TAU * (f - start)) / turn).y, 2);
}
