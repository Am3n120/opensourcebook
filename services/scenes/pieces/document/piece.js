// A page of a document, its other lines suggested as grey strokes, with the passage that matters written out and
// highlighted as it is read: a clause of a contract, a line of a law, a finding in a paper, a sentence in a letter.
const title = String(args.title || "");
const passage = String(args.passage || "");
const note = String(args.note || "");
const U = Math.min(W, H);
const L = clamp(U * 0.08, 44, 100);
const pw = Math.min(W, H * 0.78), ph = Math.min(H, pw * 1.32);
const px = (W - pw) / 2, py = (H - ph) / 2;
const m = pw * 0.09;
const at = beats(2, args.when, [passage.split(" ").slice(0, 3).join(" "), note]);
// The sheet, with a folded corner.
const fold = pw * 0.12;
path("sheet", { points: [px, py, px + pw - fold, py, px + pw, py + fold, px + pw, py + ph, px, py + ph, px, py], fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
path("fold", { points: [px + pw - fold, py, px + pw - fold, py + fold, px + pw, py + fold], stroke: "ink", strokeWidth: 4, fill: "none" });
let y = py + m + L * 0.4;
if (title) { text("title", { x: px + m, y, text: title, size: fitSize(title, L * 0.95, pw - m * 2 - fold), anchor: "start", color: "ink", weight: 800 }); y += L * 1.5; }
// The passage, set where it falls on the page (a share of the way down), between grey lines of other text.
const lines = wrapText(passage, L * 0.85, pw - m * 2).slice(0, 6);
const lineH = L * 1.15;
const bodyTop = y, bodyBottom = py + ph - m;
const where = clamp(Number(args.where) || 0.45, 0, 1);
const pTop = bodyTop + (bodyBottom - bodyTop - lines.length * lineH) * where;
let k = 0;
for (let yy = bodyTop; yy < bodyBottom - lineH * 0.5; yy += lineH * 0.9) {
  if (yy > pTop - lineH * 0.7 && yy < pTop + lines.length * lineH) continue;
  const len = (pw - m * 2) * (0.55 + 0.45 * Math.abs(Math.sin(k * 2.3 + 0.7)));
  path("grey" + k, { points: [px + m, yy, px + m + len, yy], stroke: "ink", strokeWidth: L * 0.22, opacity: 0.2 });
  k++;
}
// The highlighter goes across each line of the passage in turn as it is read, then its words are there to read.
lines.forEach((l, i) => {
  const yy = pTop + i * lineH + lineH * 0.5;
  const w = textWidth(l, L * 0.85);
  // A band of the highlight colour wiped across from the left; the words on it take whichever ink reads on it.
  const hl = path("mark" + i, { x: px + m - L * 0.15, y: yy, points: rect(0, -lineH * 0.42, w + L * 0.3, lineH * 0.84), fill: "highlight", stroke: "none", closed: 1, opacity: 0.8, scaleX: 0 });
  key(hl, "scaleX", T0, 0);
  key(hl, "scaleX", at[0] + i * 10, 0, "step");
  key(hl, "scaleX", at[0] + i * 10 + 12, 1, "smooth");
  appear(text("line" + i, { x: px + m, y: yy, text: l, size: L * 0.85, anchor: "start", color: "ink", weight: 600 }), at[0] + i * 10 + 4);
});
// A note in the margin, joined to the passage, when there is one.
if (note) {
  const nl = wrapText(note, L * 0.85, pw * 0.8).slice(0, 3);
  const ny = pTop + lines.length * lineH + L * 1.2;
  const room = py + ph - ny;
  const below = room > nl.length * L + L;
  const y0 = below ? ny : pTop - L * 0.6 - nl.length * L;
  appear(path("noteBar", { points: [px + m * 0.4, y0 - L * 0.4, px + m * 0.4, y0 + (nl.length - 1) * L + L * 0.4], stroke: "accent", strokeWidth: 8 }), at[1], "draw", 10);
  nl.forEach((l, j) => appear(text("note" + j, { x: px + m, y: y0 + j * L, text: l, size: L * 0.85, anchor: "start", color: "accent", weight: 800 }), at[1] + 4));
}
