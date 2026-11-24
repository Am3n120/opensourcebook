// A grid of cells shaded by their values, rows and columns named, filling in row by row as the voice goes, with the
// highest cell ringed: when something peaks across hours and days, regions by month, results by group and test.
// values="1,3,5;2,6,9" (rows split by ;); rows and cols name them.
const rowsV = String(args.values || "").split(";").map((r) => r.split(",").map(Number)).filter((r) => r.length && r.every(Number.isFinite)).slice(0, 10);
const rn = items(args.rows).map(String), cn = items(args.cols).map(String);
const nr = rowsV.length, nc = Math.max(1, ...rowsV.map((r) => r.length));
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
const labW = Math.min(W * 0.32, Math.max(L, ...rn.map((s) => textWidth(s, L * 0.9))) + L * 0.4);
const headH = L * 1.5;
const cw = (W - labW) / nc;
const ch = Math.min(cw * 1.1, (H - headH - L * 1.6) / Math.max(1, nr));
const y0 = (H - headH - ch * nr - L * 1.4) / 2 + headH;
const all = rowsV.flat();
const lo = Math.min(...all), hi = Math.max(...all);
const at = beats(nr, args.when, rn);
cn.slice(0, nc).forEach((c, j) => text("col" + j, { x: labW + cw * (j + 0.5), y: y0 - headH / 2, text: c, size: fitSize(c, L * 0.85, cw - 4), color: "ink", weight: 700 }));
let best = null;
rowsV.forEach((r, i) => {
  if (rn[i]) appear(text("row" + i, { x: labW - L * 0.3, y: y0 + ch * (i + 0.5), text: rn[i], size: fitSize(rn[i], L * 0.9, labW - L * 0.4), anchor: "end", color: "ink", weight: 700 }), at[i]);
  r.forEach((v, j) => {
    const t = hi > lo ? (v - lo) / (hi - lo) : 1;
    // One colour carries the scale: faint for the lowest, full for the highest.
    const cell = path(`cell${i}-${j}`, { x: labW + cw * j, y: y0 + ch * i, points: rect(2, 2, cw - 4, ch - 4), fill: "accent", stroke: "none", closed: 1, opacity: 0 });
    key(cell, "opacity", T0, 0);
    key(cell, "opacity", at[i] + j * 2, 0, "step");
    key(cell, "opacity", at[i] + j * 2 + 8, 0.1 + 0.9 * t, "smooth");
    if (!best || v > best.v) best = { v, i, j };
  });
});
for (let i = 0; i <= nr; i++) path("hr" + i, { points: [labW, y0 + ch * i, W, y0 + ch * i], stroke: "ink", strokeWidth: 2, opacity: 0.6 });
for (let j = 0; j <= nc; j++) path("vr" + j, { points: [labW + cw * j, y0, labW + cw * j, y0 + ch * nr], stroke: "ink", strokeWidth: 2, opacity: 0.6 });
if (best && String(args.peak) !== "0") {
  const f = at[nr - 1] + nc * 2 + 16;
  appear(path("peak", { x: labW + cw * (best.j + 0.5), y: y0 + ch * (best.i + 0.5), points: circle(0, 0, Math.min(cw, ch) * 0.6, 28), stroke: "ink", strokeWidth: 7, fill: "none" }), f, "draw", 12);
  const word = String(args.peakName || best.v);
  appear(text("peakName", { x: W / 2, y: y0 + ch * nr + L * 1.0, text: word, size: fitSize(word, L, W), color: "accent", weight: 800 }), f + 6);
}
