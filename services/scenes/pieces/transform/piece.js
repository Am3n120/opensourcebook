// One thing passing down a line of stages, each of which changes it: it slides from stage to stage and changes shape
// and fill on the way, leaving a copy of what it was at each stage, so the viewer sees it become what it ends as.
const steps = items(args.stages).map(String).slice(0, 6);
const states = items(args.states).map(String).slice(0, 6);
const n = Math.max(2, Math.max(steps.length, states.length));
const shapes = items(args.shapes).map((s) => String(s).toLowerCase());
const stamp = String(args.stamp || "").trim();
const sizes = items(args.sizes).map(Number).filter((v) => Number.isFinite(v) && v > 0);
const top = Math.max(1, ...sizes);
const scaleAt = (i) => (sizes.length ? (sizes[Math.min(i, sizes.length - 1)] / top) : 1);
const U = Math.min(W, H);
const rowH = H / n;
const L = clamp(Math.min(U * 0.088, rowH * 0.36), 40, 100);
const R = clamp(Math.min(rowH * 0.43, L * 1.7, W * 0.13), L * 0.6, L * 1.9);
// The words: what is done at each stage on the left, what the thing is after it on the right, the thing between.
const stepW = W * 0.3;
const cx = stepW + L * 0.5 + R;
const nameX = cx + R + L * 0.45;
const nameW = W - nameX - L * 0.1;
const Y = Array.from({ length: n }, (_, i) => rowH * (i + 0.5));

// Shapes as a radius at each of K angles, so any one can turn into any other.
const K = 72;
const ang = (k) => -Math.PI / 2 + (TAU * k) / K;
const box = (a, hw, hh) => Math.min(hw / Math.max(1e-6, Math.abs(Math.cos(a))), hh / Math.max(1e-6, Math.abs(Math.sin(a))));
const form = {
  rough: (a) => 0.86 + 0.12 * Math.sin(5 * a + 1.3) + 0.07 * Math.sin(11 * a + 0.4) + 0.05 * Math.sin(17 * a),
  round: () => 0.92,
  square: (a) => box(a, 0.8, 0.8) * 0.98,
  sheet: (a) => box(a, 0.66, 0.92),
  wide: (a) => box(a, 0.98, 0.55),
  tall: (a) => box(a, 0.55, 0.98),
  drop: (a) => { const t = a + Math.PI / 2; return 0.62 + 0.36 * Math.abs(Math.sin(t / 2)) ** 0.8; },
  star: (a) => 0.62 + 0.36 * Math.max(0, Math.cos(5 * (a + Math.PI / 2))) ** 1.5,
  hexagon: (a) => { const s = TAU / 6; const t = ((a % s) + s) % s - s / 2; return 0.86 / Math.cos(t); },
  heart: (a) => { const t = a + Math.PI / 2; return 0.55 + 0.3 * Math.abs(Math.sin(t)) ** 0.6 + 0.12 * Math.cos(t); },
};
// Unless shapes are given, the thing starts rough and ends clean, a little more finished at each stage.
const radii = Array.from({ length: n }, (_, i) => {
  const name = shapes[i] && form[shapes[i]] ? shapes[i] : "";
  const k = n > 1 ? i / (n - 1) : 1;
  return Array.from({ length: K }, (_, j) => (name ? form[name](ang(j)) : lerp(form.rough(ang(j)), form.round(ang(j)), smooth(k))));
});
const pts = (r, scale) => { const out = []; for (let j = 0; j <= K; j++) { const a = ang(j % K); out.push(Math.cos(a) * R * scale * r[j % K], Math.sin(a) * R * scale * r[j % K]); } return out; };
const mix = (a, b, t) => a.map((v, j) => lerp(v, b[j], t));
const fillOf = (i) => lerp(0.2, 1, n > 1 ? i / (n - 1) : 1);

const at = beats(n, args.when, Array.from({ length: n }, (_, i) => states[i] || steps[i]));
// What the thing starts as is there from the opening, so the scene opens on it.
if (!items(args.when).length) at[0] = T0;
// The line the thing travels down is there from the start, quiet, with a mark at each stage; it fills in as it goes.
path("track", { points: [cx, Y[0], cx, Y[n - 1]], stroke: "ink", strokeWidth: L * 0.3, fill: "none", opacity: 0.14 });
const slots = Array.from({ length: n }, (_, i) => path("slot" + i, { x: cx, y: Y[i], points: circle(0, 0, L * 0.26), fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1, opacity: 0.5 }));
const rail = path("rail", { points: [cx, Y[0], cx, Y[n - 1]], stroke: "accent", strokeWidth: 6, fill: "none" });
key(rail, "drawn", T0, 0);
for (let i = 1; i < n; i++) { key(rail, "drawn", Math.max(T0, at[i] - 20), (i - 1) / (n - 1)); key(rail, "drawn", at[i], i / (n - 1), "smooth"); }

for (let i = 0; i < n; i++) {
  const f = at[i];
  // What is done here, on the left, with an arrow in to the line.
  if (steps[i]) {
    const lines = wrapText(steps[i], L * 0.82, stepW).slice(0, 2);
    lines.forEach((l, k) => appear(text(`step${i}-${k}`, { x: stepW, y: Y[i] + (k - (lines.length - 1) / 2) * L * 0.92, text: l, size: fitSize(l, L * 0.82, stepW), anchor: "end", color: "accent", weight: 800 }), f - 6));
  }
  // A copy of what the thing was at each stage stays there, quieter, once it has moved on.
  const copy = path("was" + i, { x: cx, y: Y[i], points: pts(radii[i], scaleAt(i)), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1, fillOpacity: fillOf(i) });
  key(slots[i], "opacity", T0, 0.5);
  key(slots[i], "opacity", f, 0, "step");
  key(copy, "opacity", T0, 0);
  key(copy, "opacity", f, 0, "step");
  key(copy, "opacity", f + 1, 1, "step");
  if (i < n - 1) { key(copy, "opacity", at[i + 1] - Math.round(fps * 0.9), 1); key(copy, "opacity", at[i + 1] - Math.round(fps * 0.5), 0.5, "smooth"); }
  // What it is now, on the right.
  if (states[i]) {
    const lines = wrapText(states[i], L * 0.95, nameW).slice(0, 2);
    lines.forEach((l, k) => {
      const id = text(`state${i}-${k}`, { x: nameX, y: Y[i] + (k - (lines.length - 1) / 2) * L * 1.05, text: l, size: fitSize(l, L * 0.95, nameW), anchor: "start", color: "ink", weight: 800 });
      appear(id, f + 2);
      if (i < n - 1) { key(id, "opacity", at[i + 1] - Math.round(fps * 0.5), 1); key(id, "opacity", at[i + 1], 0.6, "smooth"); }
    });
  }
}

// The thing itself: it slides down the line in the second before each stage is named, changing as it goes.
const thing = path("thing", { x: cx, y: Y[0], points: pts(radii[0], scaleAt(0)), fill: "accent", stroke: "ink", strokeWidth: 6, closed: 1, fillOpacity: fillOf(0) });
appear(thing, at[0], "pop");
for (let i = 1; i < n; i++) {
  const to = Math.max(at[i - 1] + 10, at[i]), from = Math.max(at[i - 1] + 4, to - Math.round(fps * 0.9));
  anim(thing, "y", from, to, (t) => lerp(Y[i - 1], Y[i], smooth(t)), 2);
  anim(thing, "points", from, to, (t) => pts(mix(radii[i - 1], radii[i], smooth(t)), lerp(scaleAt(i - 1), scaleAt(i), smooth(t)) * (1 + 0.08 * Math.sin(Math.PI * t))), 2);
  anim(thing, "fillOpacity", from, to, (t) => lerp(fillOf(i - 1), fillOf(i), smooth(t)), 3);
}
// A stamp across the finished thing, if one is given: what it ends as, in a word.
if (stamp) {
  const sw = fitSize(stamp, L * 0.8, R * scaleAt(n - 1) * 1.9 - L * 0.6, "title");
  const g = group("stamp", { x: cx, y: Y[n - 1], rotate: -10 });
  const w = textWidth(stamp, sw, "title") + L * 0.6, h = sw * 1.5;
  path("stampEdge", { parent: g, points: rect(-w / 2, -h / 2, w, h), fill: "paper", stroke: "ink", strokeWidth: 6, closed: 1 });
  text("stampWord", { parent: g, x: 0, y: 0, text: stamp, size: sw, color: "ink", weight: 800 });
  appear(g, at[n - 1] + 14, "pop", 10);
}
