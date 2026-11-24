// A probability tree that grows branch by branch as each outcome is said, the chance on each branch, and the chance
// of each whole path worked out by multiplying along it: two-stage chances, tests and false alarms, repeated draws.
// first="Rain:0.3|Dry:0.7", second="Late:0.6|On time:0.4" (one set for every first branch, or one set per branch
// split by ;).
const parse = (s) => String(s || "").split("|").map((p) => { const k = p.lastIndexOf(":"); return { name: p.slice(0, k).trim(), p: Number(p.slice(k + 1)) }; }).filter((x) => x.name && Number.isFinite(x.p));
const first = parse(args.first).slice(0, 3);
const seconds = String(args.second || "").split(";").map(parse);
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 104);
const second = first.map((_, i) => (seconds[i] && seconds[i].length ? seconds[i] : seconds[0] || []).slice(0, 3));
const leaves = second.reduce((s, b) => s + Math.max(1, b.length), 0);
const rowH = Math.min(L * 3.4, (H - L) / Math.max(1, leaves));
const resW = textWidth("0.000", L * 0.95) + L * 0.4;
const x0 = L * 0.4, x1 = (W - resW) * 0.36, x2 = (W - resW) * 0.7, xr = W - resW * 0.45;
const top = (H - rowH * leaves) / 2 + rowH / 2;
const fmt = (v) => String(Math.round(v * 1000) / 1000);
const labels = first.map((b) => b.name).concat(...second.map((s) => s.map((b) => b.name)));
const at = beats(first.length + second.reduce((s, b) => s + b.length, 0), args.when, labels);
// The root is there from the start, with every branch faint, so the scene opens on the shape of the tree and each
// branch is drawn over its ghost as it is named.
path("root", { x: x0, y: H / 2, points: circle(0, 0, L * 0.28), fill: "ink", closed: 1 });
let leaf = 0, k = first.length;
const pick = String(args.highlight || "");
first.forEach((b, i) => {
  const kids = second[i];
  const span = Math.max(1, kids.length);
  const y = top + (leaf + (span - 1) / 2) * rowH;
  const f = at[i];
  path(`g1-${i}`, { points: [x0, H / 2, x1, y], stroke: "ink", strokeWidth: 2, opacity: 0.55 });
  appear(path(`b1-${i}`, { points: [x0, H / 2, x1, y], stroke: "ink", strokeWidth: 5 }), f, "draw", 12);
  appear(path(`n1-${i}`, { x: x1, y, points: circle(0, 0, L * 0.24), fill: "accent", stroke: "ink", strokeWidth: 3, closed: 1 }), f + 10, "pop");
  // The name above an upper node and below a lower one, left of the branches leaving it.
  appear(text(`name1-${i}`, { x: x1 - L * 0.2, y: y + (y <= H / 2 ? -L * 0.85 : L * 0.85), text: b.name, size: fitSize(b.name, L * 0.85, x1 - x0), anchor: "end", color: "ink", weight: 800 }), f + 10);
  // A chance sits beside the middle of its branch, pushed off the line on its outer side.
  const off = (xa, ya, xb, yb, d) => {
    const len = Math.hypot(xb - xa, yb - ya) || 1, ux = (xb - xa) / len, uy = (yb - ya) / len;
    const [nx, ny] = Math.abs(yb - ya) < 1 ? [0, -1] : yb < ya ? [uy, -ux] : [-uy, ux];
    return { x: (xa + xb) / 2 + nx * d, y: (ya + yb) / 2 + ny * d };
  };
  const q1 = off(x0, H / 2, x1, y, L * 0.6);
  appear(text(`p1-${i}`, { x: q1.x, y: q1.y, text: fmt(b.p), size: L * 0.85, color: "accent", weight: 700 }), f + 6);
  kids.forEach((c, j) => {
    const yy = top + (leaf + j) * rowH;
    const g = at[k++];
    const on = pick === `${b.name}>${c.name}`;
    path(`g2-${i}-${j}`, { points: [x1, y, x2, yy], stroke: "ink", strokeWidth: 2, opacity: 0.55 });
    appear(path(`b2-${i}-${j}`, { points: [x1, y, x2, yy], stroke: on ? "accent" : "ink", strokeWidth: on ? 7 : 4 }), g, "draw", 10);
    const q2 = off(x1, y, x2, yy, L * 0.55);
    appear(text(`p2-${i}-${j}`, { x: q2.x, y: q2.y, text: fmt(c.p), size: L * 0.8, color: "accent", weight: 700 }), g + 6);
    appear(text(`name2-${i}-${j}`, { x: x2 + L * 0.3, y: yy, text: c.name, size: fitSize(c.name, L * 0.85, xr - resW * 0.5 - x2 - L * 0.5), anchor: "start", color: "ink", weight: 700 }), g + 8);
    // The path's chance, multiplied along it.
    appear(text(`r-${i}-${j}`, { x: xr, y: yy, text: fmt(b.p * c.p), size: L * 0.95, color: on ? "accent" : "ink", weight: 800 }), g + 14);
  });
  leaf += span;
});
