// Things joined by their relations, laid out by a small spring simulation so linked things sit near each other:
// who knows whom, what feeds what, ideas that connect. Each thing is a rounded tag with its name, each link a line or
// an arrow that may carry a word, and things arrive as they are named.
// links="Sun>Plants:feeds|Plants>Rabbits|Rabbits>Foxes"; ">" draws an arrow, "-" a plain line.
const raw = items(args.links).map(String);
const edges = [];
const names = [];
const add = (s) => { if (!names.includes(s)) names.push(s); return names.indexOf(s); };
for (const r of raw) {
  const m = /^(.+?)\s*([->])\s*(.+?)(?::(.+))?$/.exec(r);
  if (!m) continue;
  edges.push({ a: add(m[1].trim()), b: add(m[3].trim()), arrow: m[2] === ">", word: (m[4] || "").trim() });
}
for (const s of items(args.alone).map(String)) add(s);
const n = Math.max(1, Math.min(names.length, 12));
const lit = items(args.highlight).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.07, 44, 96);
const size = L * 0.9;
const tagW = names.slice(0, n).map((s) => Math.min(textWidth(s, size), W * 0.44) + L * 0.9);
const tagH = L * 1.45;
// Spring layout in a unit box: links pull, everything pushes apart, tags may not overlap, walls keep it inside.
const pts = names.slice(0, n).map((_, i) => ({ x: 0.5 + Math.cos((TAU * i) / n + 0.3) * 0.35, y: 0.5 + Math.sin((TAU * i) / n + 0.3) * 0.35 }));
const aspect = H / W;
const ideal = n <= 4 ? 0.5 : n <= 7 ? 0.36 : 0.28;
for (let it = 0; it < 500; it++) {
  const cool = 1 - it / 500;
  const f = pts.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = pts[i].x - pts[j].x, dy = (pts[i].y - pts[j].y) * aspect, d = Math.max(0.01, Math.hypot(dx, dy));
    const push = (ideal * ideal) / d;
    f[i].x += (dx / d) * push; f[i].y += (dy / d) * push; f[j].x -= (dx / d) * push; f[j].y -= (dy / d) * push;
  }
  for (const e of edges) {
    if (e.a >= n || e.b >= n) continue;
    const dx = pts[e.b].x - pts[e.a].x, dy = (pts[e.b].y - pts[e.a].y) * aspect, d = Math.max(0.01, Math.hypot(dx, dy));
    const pull = (d * d) / ideal;
    f[e.a].x += (dx / d) * pull; f[e.a].y += (dy / d) * pull; f[e.b].x -= (dx / d) * pull; f[e.b].y -= (dy / d) * pull;
  }
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(f[i].x, f[i].y) || 1, s = Math.min(m, 0.05 * cool + 0.002);
    pts[i].x = clamp(pts[i].x + (f[i].x / m) * s, 0, 1);
    pts[i].y = clamp(pts[i].y + (f[i].y / m) * s / aspect, 0, 1);
  }
}
// Into the box, then pushed apart until no two tags touch.
const P = pts.map((p, i) => ({ x: lerp(tagW[i] / 2, W - tagW[i] / 2, p.x), y: lerp(tagH / 2 + L * 0.2, H - tagH / 2 - L * 0.2, p.y) }));
for (let it = 0; it < 200; it++) {
  let moved = false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ox = (tagW[i] + tagW[j]) / 2 + L * 0.5 - Math.abs(P[i].x - P[j].x);
    const oy = tagH + L * 0.7 - Math.abs(P[i].y - P[j].y);
    if (ox > 0 && oy > 0) {
      moved = true;
      if (oy < ox) { const s = (P[i].y < P[j].y ? -1 : 1) * oy / 2; P[i].y += s; P[j].y -= s; }
      else { const s = (P[i].x < P[j].x ? -1 : 1) * ox / 2; P[i].x += s; P[j].x -= s; }
    }
  }
  for (let i = 0; i < n; i++) { P[i].x = clamp(P[i].x, tagW[i] / 2, W - tagW[i] / 2); P[i].y = clamp(P[i].y, tagH / 2, H - tagH / 2); }
  if (!moved) break;
}
const at = beats(n, args.when, names);
// Where a line from a tag's middle toward a point leaves the tag's edge.
const edge = (i, tx, ty) => {
  const dx = tx - P[i].x, dy = ty - P[i].y;
  const t = 1 / Math.max(Math.abs(dx) / (tagW[i] / 2 + L * 0.15), Math.abs(dy) / (tagH / 2 + L * 0.15), 1e-6);
  return { x: P[i].x + dx * Math.min(1, t), y: P[i].y + dy * Math.min(1, t) };
};
edges.forEach((e, k) => {
  if (e.a >= n || e.b >= n) return;
  const A = edge(e.a, P[e.b].x, P[e.b].y), B = edge(e.b, P[e.a].x, P[e.a].y);
  const f = Math.max(at[e.a], at[e.b]) + 4;
  appear(path("link" + k, { points: [A.x, A.y, B.x, B.y], stroke: "ink", strokeWidth: 5, fill: "none" }), f, "draw", 12);
  if (e.arrow) {
    const rot = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
    appear(path("tip" + k, { x: B.x, y: B.y, rotate: rot, points: [-L * 0.45, -L * 0.3, 0, 0, -L * 0.45, L * 0.3], stroke: "ink", strokeWidth: 5, fill: "none" }), f + 10);
  }
  const d = Math.hypot(B.x - A.x, B.y - A.y);
  if (e.word && d > textWidth(e.word, size) + L) {
    // The word sits on the middle of its link, on a card of the surface's colour.
    const w = textWidth(e.word, size), mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    appear(path("card" + k, { x: mx - w / 2 - L * 0.2, y: my - L * 0.6, points: rect(0, 0, w + L * 0.4, L * 1.2), fill: "paper", stroke: "none", closed: 1 }), f + 8);
    appear(text("word" + k, { x: mx, y: my, text: e.word, size, color: "accent", weight: 700 }), f + 8);
  }
});
for (let i = 0; i < n; i++) {
  const on = lit.includes(names[i]);
  const w = tagW[i], h = tagH, r = h / 2;
  const pill = arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, 12).concat(arc(-w / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, 12));
  appear(path("tag" + i, { x: P[i].x, y: P[i].y, points: pill, fill: on ? "accent" : "paper", stroke: on ? "accent" : "ink", strokeWidth: 5, closed: 1 }), at[i], "pop");
  appear(text("name" + i, { x: P[i].x, y: P[i].y, text: names[i], size: fitSize(names[i], size, w - L * 0.8), color: on ? "paper" : "ink", weight: 700 }), at[i] + 3);
}
