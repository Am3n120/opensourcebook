// A hierarchy as an indented tree, read top to bottom: each thing under the one it belongs to, joined by elbow lines,
// branches arriving as they are named. Families, classifications, organisations, parts of parts, folders.
// links="Parent>Child|Parent>Child2|Child>Grandchild"; the first parent named is the root.
const pairs = items(args.links).map(String).map((s) => s.split(">").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
const lit = items(args.highlight).map(String);
const kids = new Map();
for (const [p, c] of pairs) {
  if (!kids.has(p)) kids.set(p, []);
  kids.get(p).push(c);

}
const root = pairs.length ? pairs[0][0] : String(args.root || "Whole");
// Depth-first: each row is a node with its depth and its parent's row.
const rows = [];
const walk = (name, depth, parent) => {
  if (rows.length > 24 || rows.some((r) => r.name === name)) return;
  rows.push({ name, depth, parent });
  const me = rows.length - 1;
  for (const c of kids.get(name) || []) walk(c, depth + 1, me);
};
walk(root, 0, -1);
const depthMax = Math.max(...rows.map((r) => r.depth));
const U = Math.min(W, H);
const step = Math.min(H / rows.length, U * 0.16);
const L = clamp(Math.min(step * 0.62, U * 0.085), 40, 110);
const indent = Math.min(L * 1.6, (W * 0.45) / Math.max(1, depthMax));
const y0 = Math.max(step / 2, (H - step * rows.length) / 2 + step / 2);
const at = beats(rows.length, args.when, rows.map((r) => r.name));
// A parent's branch arrives no earlier than the parent.
for (let i = 1; i < rows.length; i++) at[i] = Math.max(at[i], at[rows[i].parent] + 6);
rows.forEach((r, i) => {
  const x = r.depth * indent + L * 0.35, y = y0 + i * step;
  // Faint from the start: where every branch will go, so the tree's shape is seen before its names.
  if (r.parent >= 0) {
    const p = rows[r.parent];
    path("ghost" + i, { points: [p.depth * indent + L * 0.35, y0 + r.parent * step + L * 0.32, p.depth * indent + L * 0.35, y, x - L * 0.3, y], stroke: "ink", strokeWidth: 2, fill: "none", opacity: 0.55 });
  }
  path("slot" + i, { x, y, points: circle(0, 0, L * 0.22), fill: "paper", stroke: "ink", strokeWidth: 3, closed: 1, opacity: 0.6 });
  const on = lit.includes(r.name);
  const dot = path("dot" + i, { x, y, points: r.depth ? circle(0, 0, L * 0.22) : rect(-L * 0.3, -L * 0.3, L * 0.6, L * 0.6), fill: on || !r.depth ? "accent" : "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
  appear(dot, at[i], "pop");
  const size = fitSize(r.name, r.depth ? L : L * 1.1, W - x - L * 0.7);
  appear(text("name" + i, { x: x + L * 0.6, y, text: r.name, size, anchor: "start", color: on ? "accent" : "ink", weight: r.depth === 0 || on ? 800 : r.depth === 1 ? 700 : 400 }), at[i] + 3);
  if (r.parent >= 0) {
    const p = rows[r.parent];
    const px = p.depth * indent + L * 0.35, py = y0 + r.parent * step;
    appear(path("branch" + i, { points: [px, py + L * 0.32, px, y, x - L * 0.3, y], stroke: "ink", strokeWidth: 4, fill: "none" }), at[i] - 6, "draw", 10);
  }
});
