// Two columns side by side, each point arriving as it is said, with a mark for which side it is on: for and against,
// pros and cons, then and now, myth and fact. A verdict can be written under both at the end.
const heads = items(args.sides).map(String);
const left = items(args.left).map(String), right = items(args.right).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.092, 48, 110);
const col = (W - L * 0.8) / 2;
const marks = String(args.marks || "plus") === "check" ? ["✓", "✗"] : String(args.marks) === "none" ? ["", ""] : ["+", "−"];
const wrapW = col - (marks[0] ? L * 1.1 : L * 0.2);
const wrapAll = (list) => list.slice(0, 6).map((s) => wrapText(s, L * 0.85, wrapW).slice(0, 3));
const lw = wrapAll(left), rw = wrapAll(right);
// The points in the order they come, alternating sides as the words go back and forth.
const order = [];
for (let i = 0; i < Math.max(lw.length, rw.length); i++) { if (lw[i]) order.push([0, i]); if (rw[i]) order.push([1, i]); }
const at = beats(2 + order.length, args.when, heads.concat(order.map(([s, i]) => (s ? right : left)[i])));
const headY = L * 0.8;
const xs = [0, col + L * 0.8];
heads.slice(0, 2).forEach((h, s) => {
  appear(text("head" + s, { x: xs[s] + col / 2, y: headY, text: h, size: fitSize(h, L * 1.1, col), color: s ? "ink" : "accent", weight: 800 }), at[s]);
  appear(path("rule" + s, { points: [xs[s], headY + L * 0.8, xs[s] + col, headY + L * 0.8], stroke: s ? "ink" : "accent", strokeWidth: 6 }), at[s], "draw", 12);
});
// Each side fills down from under its heading; a point takes as many lines as it needs.
const ys = [headY + L * 1.9, headY + L * 1.9];
const verdict = String(args.verdict || "");
order.forEach(([s, i], k) => {
  const lines = (s ? rw : lw)[i];
  const f = at[2 + k];
  const y = ys[s];
  if (marks[s]) appear(text(`mark${s}-${i}`, { x: xs[s] + L * 0.4, y, text: marks[s], size: L * 1.05, color: s ? "ink" : "accent", weight: 800 }), f, "pop");
  lines.forEach((l, j) => appear(text(`point${s}-${i}-${j}`, { x: xs[s] + (marks[s] ? L * 1.0 : 0), y: y + j * L * 1.02, text: l, size: L * 0.85, anchor: "start", color: "ink" }), f + 3));
  ys[s] += lines.length * L * 1.02 + L * 0.65;
});
// The line between the sides runs down as far as the points go, and stops above the verdict.
appear(path("divider", { points: [W / 2, headY - L * 0.4, W / 2, Math.max(ys[0], ys[1]) - L * 0.3], stroke: "ink", strokeWidth: 3 }), at[0], "draw", 20);
if (verdict) {
  const vy = Math.max(ys[0], ys[1]) + L * 0.4;
  const vl = wrapText(verdict, L, W * 0.9).slice(0, 2);
  const f = (order.length ? at[1 + order.length] : at[1]) + 24;
  vl.forEach((l, k) => appear(text("verdict" + k, { x: W / 2, y: vy + k * L * 1.15, text: l, size: L, color: "accent", weight: 800 }), f, "pop"));
}
