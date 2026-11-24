// Fraction strips: a whole bar, then one strip per fraction cut into equal parts with the parts it takes shaded, each
// as it is said, all the same length so equal amounts line up: equivalent fractions, comparing, adding parts.
const fr = items(args.fractions).map(String).map((s) => s.split("/").map(Number)).filter((p) => p.length === 2 && p[1] > 0 && p[1] <= 24 && p[0] >= 0);
const n = Math.min(fr.length, 7);
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const labelW = L * 2.4;
const x0 = labelW, w = W - labelW;
const rows = n + (String(args.whole) === "0" ? 0 : 1);
const rowH = Math.min(L * 1.9, H / rows);
const barH = rowH * 0.62;
const y0 = (H - rows * rowH) / 2 + rowH / 2;
const at = beats(n, args.when, fr.map(([a, b]) => `${a}/${b}`));
let r = 0;
if (String(args.whole) !== "0") {
  path("whole", { x: x0, y: y0 - barH / 2, points: rect(0, 0, w, barH), fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
  text("wholeName", { x: x0 + w / 2, y: y0, text: "1", size: L, color: "ink", weight: 800 });
  r = 1;
}
let ends = [];
fr.slice(0, n).forEach(([a, b], k) => {
  const y = y0 + (r + k) * rowH;
  const cw = w / b;
  const f = at[k];
  // The label, then the cells: shaded ones fill one after another from the strip's moment.
  appear(text("label" + k, { x: labelW - L * 0.4, y, text: `${a}/${b}`, size: L, anchor: "end", color: "accent", weight: 800 }), f);
  for (let c = 0; c < b; c++) {
    const on = c < a;
    const cell = path(`cell${k}-${c}`, { x: x0 + c * cw, y: y - barH / 2, points: rect(0, 0, cw, barH), fill: on ? "highlight" : "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
    appear(cell, f + (on ? c * 3 : 0), on ? "pop" : "fade", 8);
  }
  ends.push(a / b);
});
// Where shaded parts end at the same place, a guide shows the fractions are equal.
const same = ends.length > 1 && ends.every((e) => Math.abs(e - ends[0]) < 1e-9) && ends[0] > 0;
if (same && String(args.guide) !== "0") {
  const gx = x0 + w * ends[0];
  const f = at[n - 1] + 18;
  appear(path("guide", { points: [gx, y0 - barH * 0.8, gx, y0 + (r + n - 1) * rowH + barH * 0.8], stroke: "accent", strokeWidth: 6, fill: "none" }), f, "draw", 16);
}
