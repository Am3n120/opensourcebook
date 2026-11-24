// Two or three overlapping sets, each arriving as it is named, with what belongs only to one written in its own part
// and what they share written in the overlap: what two things have in common and what sets them apart.
const sets = items(args.sets).map(String).slice(0, 3);
const n = Math.max(2, sets.length);
const only = [args.onlyA, args.onlyB, args.onlyC].map((v) => items(v).map(String));
const both = items(args.shared).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.075, 44, 100);
const at = beats(n + 1, args.when, sets.concat([both[0] || ""]));
// Circles: two side by side across the width, or three in a triangle, overlapping by a third.
// Two sets on a tall frame stack one above the other, so each part is wide enough for its words.
const tall = n === 2 && H > W * 1.15;
const r = tall ? Math.min(W * 0.44, (H - L * 3) / 3.04) : n === 2 ? Math.min(W * 0.36, (H - L * 3) / 2) : Math.min(W * 0.3, (H - L * 3) * 0.3);
const cy = n === 2 ? H / 2 + L * 0.6 : H / 2 + L * 0.4;
const centres = tall ? [{ x: W / 2, y: H / 2 - r * 0.52 }, { x: W / 2, y: H / 2 + r * 0.52 }] : n === 2 ? [{ x: W / 2 - r * 0.52, y: cy }, { x: W / 2 + r * 0.52, y: cy }] : [{ x: W / 2 - r * 0.58, y: cy - r * 0.4 }, { x: W / 2 + r * 0.58, y: cy - r * 0.4 }, { x: W / 2, y: cy + r * 0.62 }];
const fills = ["highlight", "accent", "paper"];
centres.forEach((c, i) => {
  const shape = path("set" + i, { x: c.x, y: c.y, points: circle(0, 0, r, 64), fill: fills[i], stroke: "ink", strokeWidth: 6, closed: 1, opacity: 0 });
  // Translucent, so where they overlap is seen as overlap.
  key(shape, "opacity", T0, 0);
  key(shape, "opacity", at[i], 0, "step");
  key(shape, "opacity", at[i] + 12, 0.35, "smooth");
  const outline = path("rim" + i, { x: c.x, y: c.y, points: circle(0, 0, r, 64), stroke: "ink", strokeWidth: 6, fill: "none" });
  appear(outline, at[i], "draw", 16);
  // The set's name above its circle (below for the third), on the surface.
  const name = sets[i] || "";
  const ny = (n === 3 && i === 2) || (tall && i === 1) ? c.y + r + L * 0.75 : c.y - r - L * 0.7;
  const nx = tall ? c.x : n === 2 ? c.x + (i ? r * 0.25 : -r * 0.25) : c.x + (i === 0 ? -r * 0.3 : i === 1 ? r * 0.3 : 0);
  appear(text("name" + i, { x: clamp(nx, textWidth(name, L) / 2, W - textWidth(name, L) / 2), y: ny, text: name, size: fitSize(name, L, W * 0.48), color: "ink", weight: 800 }), at[i] + 4);
});
// Words in each part: a set's own words away from the overlap, the shared ones in the middle.
// Each item wraps onto lines of its own rather than shrinking, so it stays readable in a narrow part.
const lines = (list, x, y, w, size, id, f) => {
  const rowsOf = list.slice(0, 4).map((s) => wrapText(s, size, w).slice(0, 2));
  const total = rowsOf.reduce((a, r) => a + r.length, 0);
  let k = 0;
  rowsOf.forEach((r, j) => r.forEach((l) => {
    appear(text(`${id}${j}-${k}`, { x, y: y + (k - (total - 1) / 2) * size * 1.15, text: l, size: fitSize(l, size, w * 1.15), color: "ink", weight: 700 }), f + j * 4);
    k++;
  }));
};
if (tall) {
  lines(only[0], W / 2, H / 2 - r * 1.02, r * 1.4, L * 0.9, "a", at[0] + 8);
  lines(only[1], W / 2, H / 2 + r * 1.02, r * 1.4, L * 0.9, "b", at[1] + 8);
  lines(both, W / 2, H / 2, r * 1.3, L * 0.9, "both", at[2]);
} else if (n === 2) {
  lines(only[0], centres[0].x - r * 0.48, cy, r * 0.9, L * 0.9, "a", at[0] + 8);
  lines(only[1], centres[1].x + r * 0.48, cy, r * 0.9, L * 0.9, "b", at[1] + 8);
  lines(both, W / 2, cy, r * 0.8, L * 0.9, "both", at[2]);
} else {
  lines(only[0], centres[0].x - r * 0.4, centres[0].y - r * 0.15, r * 0.9, L * 0.8, "a", at[0] + 8);
  lines(only[1], centres[1].x + r * 0.4, centres[1].y - r * 0.15, r * 0.9, L * 0.8, "b", at[1] + 8);
  lines(only[2], centres[2].x, centres[2].y + r * 0.42, r * 1.1, L * 0.8, "c", at[2] + 8);
  lines(both, W / 2, cy - r * 0.05, r * 0.5, L * 0.8, "both", at[3]);
}
