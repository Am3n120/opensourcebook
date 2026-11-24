// A decision tree read top to bottom: a question, its answers as branches, and where each answer leads (another
// question or an outcome), one path lighting up as the voice follows it: diagnosis, eligibility, troubleshooting,
// a legal test, choosing what to do.
// steps="Is it raining?>yes:Take an umbrella|Is it raining?>no:Is it cold?|Is it cold?>yes:Wear a coat|Is it cold?>no:Just go"
const raw = items(args.steps).map(String);
const edges = raw.map((s) => { const m = /^(.+?)>(.+?):(.+)$/.exec(s); return m ? { from: m[1].trim(), say: m[2].trim(), to: m[3].trim() } : null; }).filter(Boolean);
const kids = new Map();
for (const e of edges) { if (!kids.has(e.from)) kids.set(e.from, []); kids.get(e.from).push(e); }
const root = edges.length ? edges[0].from : String(args.root || "Question?");
const follow = items(args.path).map(String); // the answers taken, in order
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
// Lay the tree out: depth down the frame, leaves spread across, each node over the middle of its children.
const nodes = [];
const place = (name, depth, seen) => {
  const me = { name, depth, kids: [], x: 0 };
  nodes.push(me);
  if (seen.has(name) || depth > 4) return me;
  seen.add(name);
  for (const e of kids.get(name) || []) { const c = place(e.to, depth + 1, seen); c.say = e.say; me.kids.push(c); }
  return me;
};
const tree = place(root, 0, new Set());
let leafX = 0;
const spread = (nd) => { if (!nd.kids.length) { nd.x = leafX++; return; } nd.kids.forEach(spread); nd.x = (nd.kids[0].x + nd.kids[nd.kids.length - 1].x) / 2; };
spread(tree);
const leaves = Math.max(1, leafX), depth = Math.max(...nodes.map((d) => d.depth)) + 1;
const colW = W / leaves, rowH = Math.min(H / depth, L * 4.6);
const boxW = Math.min(colW * 2, W) - L * 0.4;
const X = (nd) => (nd.x + 0.5) * colW;
const Yd = (nd) => (H - rowH * depth) / 2 + rowH * (nd.depth + 0.4);
// The path the voice follows: from the root, the answer named at each step.
const onPath = new Set([tree]);
let cur = tree;
for (const a of follow) { const nx = cur.kids.find((c) => c.say.toLowerCase() === a.toLowerCase()); if (!nx) break; onPath.add(nx); cur = nx; }
const pathNodes = [...onPath];
const at = beats(pathNodes.length, args.when, pathNodes.map((nd, i) => (i ? nd.say : nd.name)));
const when = new Map(pathNodes.map((nd, i) => [nd, at[i]]));
nodes.forEach((nd, i) => {
  const outcome = !nd.kids.length;
  const w = Math.min(nd.depth ? Math.min(colW * (nd.kids.length || 1), boxW) - L * 0.3 : W - L * 0.4, textWidth(nd.name, L * 0.85) + L * 1.0);
  const lines = wrapText(nd.name, L * 0.85, Math.max(L * 2, w - L * 0.6)).slice(0, 3);
  const h = lines.length * L * 1.0 + L * 0.7;
  const x = X(nd), y = Yd(nd);
  const lit = onPath.has(nd);
  const f = when.get(nd);
  // Questions are rounded boxes; outcomes are pills; the path's ones fill in as the voice reaches them.
  const r = outcome ? h / 2 : L * 0.3;
  const shape = arc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, 6).concat(arc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, 6), arc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, 6), arc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, 6));
  const box = path("node" + i, { x, y, points: shape, fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
  if (lit && f !== undefined) { key(box, "stroke", T0, "ink"); key(box, "stroke", f, "accent", "step"); key(box, "strokeWidth", f, 4); key(box, "strokeWidth", f + 6, 9, "out"); }
  lines.forEach((l, k) => text(`name${i}-${k}`, { x, y: y + (k - (lines.length - 1) / 2) * L * 1.0, text: l, size: fitSize(l, L * 0.85, w - L * 0.4), color: "ink", weight: outcome ? 800 : 700 }));
  nd.box = { x, y, h };
});
nodes.forEach((nd, i) => nd.kids.forEach((c, j) => {
  const a = nd.box, b = c.box;
  const pts = [a.x, a.y + a.h / 2, a.x, (a.y + a.h / 2 + b.y - b.h / 2) / 2, b.x, (a.y + a.h / 2 + b.y - b.h / 2) / 2, b.x, b.y - b.h / 2];
  const lit = onPath.has(c);
  const ln = path(`edge${i}-${j}`, { points: pts, stroke: "ink", strokeWidth: 4, fill: "none" });
  if (lit) { key(ln, "stroke", T0, "ink"); key(ln, "stroke", Math.max(T0, when.get(c) - 6), "accent", "step"); key(ln, "strokeWidth", Math.max(T0, when.get(c) - 6), 4); key(ln, "strokeWidth", when.get(c), 8, "smooth"); }
  const sy = pts[5] + (b.y - b.h / 2 - pts[5]) / 2;
  text(`say${i}-${j}`, { x: b.x + L * 0.25, y: sy, text: c.say, size: L * 0.85, anchor: "start", color: lit ? "accent" : "ink", weight: 800 });
}));
