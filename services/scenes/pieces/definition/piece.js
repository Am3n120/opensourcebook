// A dictionary-style entry built up as it is said: the term large, how it sounds and what kind of word it is, then
// its meaning, then an example in use with the term picked out. A word, a concept, a term of art, a legal term.
const term = String(args.term || "");
const say = String(args.sounds || "");
const kind = String(args.kind || "");
const meaning = String(args.meaning || "");
const example = String(args.example || "");
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const big = fitSize(term, L * 2.1, W);
// Words are made smaller until they fit their lines, rather than cut: an example that loses its last line loses the term.
const fit = (s, size, maxW, most) => { let k = size; while (k > size * 0.6 && wrapText(s, k, maxW).length > most) k *= 0.94; return k; };
const mSize = fit(meaning, L, W - L * 0.6, 5);
const eSize = example ? fit(example, L * 0.9, W - L * 1.2, 3) : L * 0.9;
const mLines = wrapText(meaning, mSize, W - L * 0.6).slice(0, 5);
const eLines = example ? wrapText(example, eSize, W - L * 1.2).slice(0, 3) : [];
const total = big * 1.1 + (say || kind ? L * 1.3 : 0) + L * 0.9 + mLines.length * L * 1.2 + (eLines.length ? L * 0.9 + eLines.length * L * 1.1 : 0);
let y = Math.max(big * 0.6, (H - total) / 2 + big * 0.55);
const at = beats(3, args.when, [term, meaning.split(" ").slice(0, 3).join(" "), example.split(" ").slice(0, 3).join(" ")]);
appear(text("term", { x: 0, y, text: term, size: big, anchor: "start", color: "accent", weight: 800 }), at[0], "fade", 10);
y += big * 0.75;
if (say || kind) {
  const line = [say ? `/${say}/` : "", kind].filter(Boolean).join("   ");
  appear(text("sounds", { x: 0, y: y + L * 0.35, text: line, size: fitSize(line, L * 0.85, W), anchor: "start", color: "ink", opacity: 0.85 }), at[0] + 8);
  y += L * 1.3;
}
appear(path("rule", { points: [0, y, W, y], stroke: "ink", strokeWidth: 4 }), at[1] - 6, "draw", 12);
y += L * 0.9;
mLines.forEach((l, k) => appear(text("meaning" + k, { x: L * 0.3, y: y + k * L * 1.2, text: l, size: mSize, anchor: "start", color: "ink" }), at[1] + k * 3));
y += mLines.length * L * 1.2;
if (eLines.length) {
  y += L * 0.5;
  // The example, set off by a bar down its left, with the term in it in the accent.
  appear(path("bar", { points: [L * 0.3, y - L * 0.5, L * 0.3, y + (eLines.length - 1) * L * 1.1 + L * 0.5], stroke: "accent", strokeWidth: 8 }), at[2], "draw", 10);
  const stem = term.toLowerCase().slice(0, Math.max(3, term.length - 2));
  eLines.forEach((l, k) => {
    let x = L * 0.8;
    l.split(" ").forEach((w, j) => {
      const on = w.toLowerCase().replace(/[^\p{L}]/gu, "").startsWith(stem);
      appear(text(`ex${k}-${j}`, { x, y: y + k * L * 1.1, text: w, size: eSize, anchor: "start", color: on ? "accent" : "ink", weight: on ? 800 : 400, opacity: on ? 1 : 0.9 }), at[2] + 4);
      x += textWidth(w + " ", eSize);
    });
  });
}
