// Two axes crossing into four quadrants, each named in its corner, with things dropped into place as they are named:
// urgent and important, cost and benefit, risk and reward, any two measures at once.
const axes = items(args.axes).map(String); // "low x|high x|low y|high y"
const quads = items(args.quadrants).map(String); // top-left, top-right, bottom-left, bottom-right
const names = items(args.labels).map(String);
const xs = items(args.x).map(Number).map((v) => (v > 1 ? v / 100 : v));
const ys = items(args.y).map(Number).map((v) => (v > 1 ? v / 100 : v));
const n = Math.min(names.length, xs.length, ys.length, 10);
const U = Math.min(W, H);
const L = clamp(U * 0.075, 44, 96);
const side = Math.min(W - L * 0.4, H - L * 3.6);
const x0 = (W - side) / 2, y0 = L * 1.6;
const cx = x0 + side / 2, cy = y0 + side / 2;
// The four quadrants, the one named by highlight drawn warmer.
const pick = String(args.highlight || "");
quads.slice(0, 4).forEach((q, k) => {
  const qx = x0 + (k % 2) * side / 2, qy = y0 + Math.floor(k / 2) * side / 2;
  if (q && q === pick) path("warm" + k, { points: rect(qx, qy, side / 2, side / 2), fill: "highlight", stroke: "none", closed: 1, opacity: 0.4 });
  if (q) text("quad" + k, { x: qx + (k % 2 ? side / 2 - L * 0.3 : L * 0.3), y: qy + (k < 2 ? L * 0.7 : side / 2 - L * 0.7), text: q, size: fitSize(q, L * 0.85, side / 2 - L * 0.6), anchor: k % 2 ? "end" : "start", color: "accent", weight: 800 });
});
path("xaxis", { points: [x0, cy, x0 + side, cy], stroke: "ink", strokeWidth: 5 });
path("yaxis", { points: [cx, y0, cx, y0 + side], stroke: "ink", strokeWidth: 5 });
path("box", { points: rect(x0, y0, side, side), stroke: "ink", strokeWidth: 3, fill: "none", closed: 1, opacity: 0.6 });
// Axis names: the y axis at its top and bottom ends, the x axis at its left and right ends below the square.
if (axes[3]) text("yhi", { x: cx, y: y0 - L * 0.7, text: axes[3], size: fitSize(axes[3], L * 0.85, W), color: "ink", weight: 700 });
if (axes[2]) text("ylo", { x: cx, y: y0 + side + L * 0.7, text: axes[2], size: fitSize(axes[2], L * 0.85, W), color: "ink", weight: 700 });
if (axes[0]) text("xlo", { x: x0, y: y0 + side + L * 1.8, text: "← " + axes[0], size: fitSize("← " + axes[0], L * 0.85, W / 2 - L * 0.2), anchor: "start", color: "ink", weight: 700 });
if (axes[1]) text("xhi", { x: x0 + side, y: y0 + side + L * 1.8, text: axes[1] + " →", size: fitSize(axes[1] + " →", L * 0.85, W / 2 - L * 0.2), anchor: "end", color: "ink", weight: 700 });
// Things: a dot at (x, y), its name beside it on whichever side has room.
const at = beats(n, args.when, names);
for (let i = 0; i < n; i++) {
  const px = x0 + clamp(xs[i], 0.04, 0.96) * side, py = y0 + (1 - clamp(ys[i], 0.04, 0.96)) * side;
  appear(path("dot" + i, { x: px, y: py, points: circle(0, 0, L * 0.3), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 }), at[i], "pop");
  // The name stays inside the dot's own quadrant: beside the dot on the side with room, and moved off the
  // quadrant's own name when it would sit on it.
  const lo0 = px < cx ? x0 : cx, hi0 = px < cx ? cx : x0 + side;
  const size = fitSize(names[i], L * 0.85, Math.max(hi0 - px, px - lo0) - L * 0.65);
  const w = textWidth(names[i], size);
  const lo = px < cx ? x0 : cx, hi = px < cx ? cx : x0 + side;
  const right = px + L * 0.45 + w <= hi - L * 0.15 || px - L * 0.45 - w < lo + L * 0.15;
  const a = right ? px + L * 0.45 : px - L * 0.45 - w;
  let ly = py;
  const k = (py < cy ? 0 : 2) + (px < cx ? 0 : 1);
  const qy = y0 + Math.floor(k / 2) * side / 2 + (k < 2 ? L * 0.7 : side / 2 - L * 0.7);
  if (quads[k] && Math.abs(ly - qy) < L * 1.1) ly = qy + (k < 2 ? L * 1.15 : -L * 1.15);
  if (Math.abs(ly - cy) < L * 0.6) ly = cy + (py < cy ? -L * 0.6 : L * 0.6);
  appear(text("name" + i, { x: a, y: ly, text: names[i], size, anchor: "start", color: "ink", weight: 700 }), at[i] + 4);
}
