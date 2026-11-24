// A quotation set large between big quotation marks, the words that matter swept with the accent as they are said,
// and who said it beneath: a source's own words, a line of a speech, a clause of a text, a saying.
const ws = String(args.text || "").split(/\s+/).filter(Boolean);
const keys = items(args.emphasis).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.1, 50, 120);
// The largest size at which the quote fits in about two thirds of the box.
let size = L * 1.25, lines = [];
for (let k = 0; k < 12; k++) {
  lines = wrapText(ws.join(" "), size, W - L * 0.4);
  if (lines.length * size * 1.3 <= H * 0.62 || size <= L * 0.8) break;
  size *= 0.92;
}
const lineH = size * 1.3;
const by = String(args.by || "");
const total = lines.length * lineH + (by ? L * 2 : 0);
const y0 = Math.max(L * 1.2 + Math.min(L * 3, size * 2.4) * 0.9, (H - total) / 2 + size * 0.6);
// Opening and closing marks, large and quiet, in the accent.
const q = Math.min(L * 3, size * 2.4);
appear(text("open", { x: 0, y: y0 - size * 0.5 - q * 0.55, text: "“", size: q, anchor: "start", color: "accent", weight: 800, opacity: 0.85 }), T0);
// Lines of words, each word its own part so the emphasised ones can be swept.
const plain = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const keyWords = keys.map((k) => k.split(/\s+/).map(plain));
const at = beats(keys.length, args.when, keys);
let wi = 0;
const spans = [];
lines.forEach((l, li) => {
  let x = L * 0.4;
  const y = y0 + li * lineH;
  for (const w of l.split(" ")) {
    const ww = textWidth(w, size);
    text(`w${wi}`, { x, y, text: w, size, anchor: "start", color: "ink", weight: 600 });
    spans.push({ i: wi, w, x, ww, y });
    x += ww + textWidth(" ", size);
    wi++;
  }
});
// Each emphasised phrase: its words turn to the accent and a stroke sweeps under them, line by line.
let from = 0;
keyWords.forEach((kw, k) => {
  for (let i = from; i + kw.length <= spans.length; i++) {
    if (!kw.every((w, j) => plain(spans[i + j].w) === w)) continue;
    from = i + kw.length;
    for (let j = 0; j < kw.length; j++) {
      const s = spans[i + j];
      key(`w${s.i}`, "color", T0, "ink");
      key(`w${s.i}`, "color", at[k] + j * 3, "accent", "step");
      const under = path(`sweep${k}-${j}`, { points: [s.x - (j ? textWidth(" ", size) : 0), s.y + size * 0.62, s.x + s.ww, s.y + size * 0.62], stroke: "accent", strokeWidth: Math.max(6, size * 0.1), fill: "none" });
      appear(under, at[k] + j * 3, "draw", 6);
    }
    break;
  }
});
const last = spans[spans.length - 1];
if (last) text("close", { x: Math.min(W - q * 0.4, last.x + last.ww + size * 0.15), y: last.y - size * 0.25 + q * 0.25, text: "”", size: q * 0.7, anchor: "start", color: "accent", weight: 800, opacity: 0.85 });
if (by) {
  const t = "— " + by;
  appear(text("by", { x: W, y: y0 + lines.length * lineH + L * 0.6, text: t, size: fitSize(t, L * 0.8, W), anchor: "end", color: "ink", weight: 400 }), T0 + 10);
}
