// A table whose cells fill in as they are said, row by row or column by column, with one row picked out: comparing
// things on several features, a timetable, results, a grid of cases.
// rows="Name|Feature 1|Feature 2;Item A|yes|no;Item B|no|yes": rows split by ;, cells by |, the first row is the header.
const rows = String(args.rows || "").split(";").map((r) => r.split("|").map((c) => c.trim())).filter((r) => r.some(Boolean)).slice(0, 9);
const nr = rows.length, nc = Math.max(1, ...rows.map((r) => r.length));
const U = Math.min(W, H);
const L = clamp(U * 0.09, 46, 110);
const marks = { yes: "✓", no: "✗", "✓": "✓", "✗": "✗" };
const shown = (s) => marks[String(s).toLowerCase()] || s;
// Columns as wide as their longest body cell needs (headers may wrap onto two lines), shared out over the width.
const need = Array.from({ length: nc }, (_, c) => Math.max(L * 1.6, ...rows.slice(1).map((r) => textWidth(shown(r[c] || ""), L * 0.9) + L * 0.6), ...String(rows[0][c] || "").split(/\s+/).map((w) => textWidth(w, L * 0.8) + L * 0.4)));
const sum = need.reduce((a, b) => a + b, 0);
const colW = need.map((w) => (w * W) / sum);
const size = L * Math.min(1, Math.max(0.8, W / sum));
const head = rows[0].map((h, c) => wrapText(h, size * 0.85, colW[c] - L * 0.3).slice(0, 2));
const headH = Math.max(...head.map((l) => l.length)) * size + L * 0.5;
const rowH = Math.min(L * 1.9, (H - headH) / Math.max(1, nr - 1));
const y0 = Math.max(0, (H - headH - rowH * (nr - 1)) / 2);
const xs = [0];
for (let c = 0; c < nc; c++) xs.push(xs[c] + colW[c]);
const rowY = (i) => y0 + headH + rowH * (i - 1);
const byColumn = String(args.fill) === "columns";
const cells = [];
for (let i = 1; i < nr; i++) for (let c = 0; c < nc; c++) cells.push([i, c]);
if (byColumn) cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
const groups = byColumn ? nc : nr - 1;
const labels = byColumn ? rows[0] : rows.slice(1).map((r) => r[0]);
const at = beats(groups, args.when, labels);
const pick = String(args.highlight || "");
// The header in the accent over a strong rule, then faint rules between rows and columns.
head.forEach((lines, c) => lines.forEach((l, k) => text(`head${c}-${k}`, { x: xs[c] + colW[c] / 2, y: y0 + headH - L * 0.3 - (lines.length - k - 0.5) * size, text: l, size: fitSize(l, size * 0.85, colW[c] - L * 0.2), color: "accent", weight: 800 })));
path("headRule", { points: [0, y0 + headH, W, y0 + headH], stroke: "ink", strokeWidth: 6 });
for (let i = 2; i < nr; i++) path(`rule${i}`, { points: [0, rowY(i), W, rowY(i)], stroke: "ink", strokeWidth: 2, opacity: 0.6 });
for (let c = 1; c < nc; c++) path(`col${c}`, { points: [xs[c], y0, xs[c], rowY(nr)], stroke: "ink", strokeWidth: 2, opacity: 0.6 });
cells.forEach(([i, c], k) => {
  const g = byColumn ? c : i - 1;
  const order = cells.slice(0, k).filter(([ii, cc]) => (byColumn ? cc === c : ii === i)).length;
  const f = at[g] + order * 5;
  const word = shown(rows[i][c] || "");
  const on = pick && rows[i][0] === pick;
  if (on && c === 0) appear(path(`pick${i}`, { points: rect(L * 0.08, rowY(i) + rowH * 0.08, W - L * 0.16, rowH * 0.84), fill: "none", stroke: "accent", strokeWidth: 7, closed: 1 }), f - 2, "draw", 14);
  const tick = word === "✓" || word === "✗";
  appear(text(`cell${i}-${c}`, { x: xs[c] + colW[c] / 2, y: rowY(i) + rowH / 2, text: word, size: fitSize(word, tick ? size * 1.15 : size * 0.9, colW[c] - L * 0.3), color: word === "✓" ? "accent" : "ink", weight: c === 0 || on ? 700 : 400 }), f, tick ? "pop" : "fade");
});
