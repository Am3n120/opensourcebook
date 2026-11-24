// Particles in a box moving by simple rules: straight lines, bouncing off the walls, faster when hotter. The speed can
// change on a word (heating, cooling), a wall can open to let them spread, and a count of how many are on each side
// can be kept: gases and temperature, diffusion, crowds, molecules, random motion.
const n = clamp(Math.round(Number(args.count) || 60), 4, 300);
const speeds = items(args.speeds).map(Number).filter((v) => v >= 0);
const U = Math.min(W, H);
const L = clamp(U * 0.07, 40, 90);
const half = String(args.start) === "left";
const open = String(args.wall) === "1";
const at = beats(Math.max(1, speeds.length) + (open ? 1 : 0), args.when, undefined);
const box = { x: 4, y: L * 0.2, w: W - 8, h: H - L * (open ? 2.2 : 0.6) };
path("box", { x: box.x, y: box.y, points: rect(0, 0, box.w, box.h), stroke: "ink", strokeWidth: 7, fill: "none", closed: 1 });
const r = clamp(Math.sqrt((box.w * box.h) / n) * 0.14, 6, L * 0.4);
// The wall down the middle, which lifts on its moment when it is there.
const openAt = open ? at[at.length - 1] : T1 + 1;
if (half || open) {
  const wall = path("wall", { points: [box.x + box.w / 2, box.y, box.x + box.w / 2, box.y + box.h], stroke: "ink", strokeWidth: 7 });
  if (open) { key(wall, "opacity", openAt, 1); key(wall, "opacity", openAt + 10, 0, "smooth"); }
}
// Speed at a frame: each change eases in over a second.
const speedAt = (f) => {
  let v = speeds[0] ?? 1;
  for (let i = 1; i < speeds.length; i++) if (f >= at[i]) v = lerp(speeds[i - 1], speeds[i], clamp((f - at[i]) / fps, 0, 1));
  return v;
};
const P = Array.from({ length: n }, () => {
  const a = random() * TAU;
  return { x: box.x + r + random() * ((half ? box.w / 2 : box.w) - r * 2 - (half ? 8 : 0)), y: box.y + r + random() * (box.h - r * 2), vx: Math.cos(a), vy: Math.sin(a), tr: [] };
});
// Step the motion frame by frame, keeping every particle's place every other frame.
const base = Math.min(box.w, box.h) * 0.012;
let leftCount = [];
for (let f = T0; f <= T1; f++) {
  const v = speedAt(f) * base;
  const wallUp = (half || open) && f < openAt + 5;
  let left = 0;
  for (const p of P) {
    p.x += p.vx * v; p.y += p.vy * v;
    const lo = box.x + r, hi = box.x + box.w - r;
    if (p.x < lo) { p.x = lo; p.vx = Math.abs(p.vx); }
    if (p.x > hi) { p.x = hi; p.vx = -Math.abs(p.vx); }
    if (p.y < box.y + r) { p.y = box.y + r; p.vy = Math.abs(p.vy); }
    if (p.y > box.y + box.h - r) { p.y = box.y + box.h - r; p.vy = -Math.abs(p.vy); }
    if (wallUp) {
      const mid = box.x + box.w / 2;
      if (p.x0 === undefined) p.x0 = p.x < mid;
      if (p.x0 && p.x > mid - r) { p.x = mid - r; p.vx = -Math.abs(p.vx); }
      if (!p.x0 && p.x < mid + r) { p.x = mid + r; p.vx = Math.abs(p.vx); }
    }
    if (p.x < box.x + box.w / 2) left++;
    if ((f - T0) % 2 === 0) p.tr.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
  }
  leftCount.push(left);
}
P.forEach((p, i) => {
  const d = path("p" + i, { x: p.tr[0], y: p.tr[1], points: circle(0, 0, r, 10), fill: "accent", stroke: "ink", strokeWidth: Math.max(1.5, r * 0.2), closed: 1 });
  for (let k = 0; k * 2 < p.tr.length; k++) {
    key(d, "x", T0 + k * 2, p.tr[k * 2], "linear");
    key(d, "y", T0 + k * 2, p.tr[k * 2 + 1], "linear");
  }
});
// The counts on each side, under the box, when the wall is there to spread past.
if (open || half) {
  const lt = text("leftCount", { x: box.x + box.w * 0.25, y: box.y + box.h + L * 1.0, text: "", size: L, color: "ink", weight: 800 });
  const rt = text("rightCount", { x: box.x + box.w * 0.75, y: box.y + box.h + L * 1.0, text: "", size: L, color: "ink", weight: 800 });
  for (let f = T0; f <= T1; f += 6) {
    const l = leftCount[f - T0];
    key(lt, "text", f, String(l), "step");
    key(rt, "text", f, String(n - l), "step");
  }
}
