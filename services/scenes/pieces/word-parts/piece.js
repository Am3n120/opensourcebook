// A word built from its parts: each part arrives as a tile with its meaning under it, then the tiles slide together
// into the whole word: roots, prefixes and suffixes, compound words, how a term was made.
const parts = items(args.parts).map(String);
const means = items(args.meanings).map(String);
const n = Math.max(1, Math.min(parts.length, 6));
const U = Math.min(W, H);
const L = clamp(U * 0.1, 50, 130);
// Tiles side by side when they fit across, else down the frame.
const widths = parts.slice(0, n).map((p) => textWidth(p, L * 1.15) + L * 0.7);
const gap = L * 0.5;
const across = widths.reduce((a, b) => a + b, 0) + gap * (n - 1) <= W;
const total = widths.reduce((a, b) => a + b, 0);
const wordSize = fitSize(parts.join(""), L * 1.6, W);
const at = beats(n + 1, args.when, parts.concat([String(args.whole || parts.join(""))]));
const joinAt = at[n];
const tileH = L * 1.7;
const yTiles = H * 0.3;
// Where each tile sits apart, and where its letters land in the whole word.
const wordW = textWidth(parts.join(""), wordSize);
let wx = (W - wordW) / 2;
let ax = (W - total - gap * (n - 1)) / 2;
const meanSize = L * 0.75;
for (let i = 0; i < n; i++) {
  const w = widths[i];
  const apartX = across ? ax + w / 2 : W / 2;
  const apartY = across ? yTiles : yTiles + (i - (n - 1) / 2) * (tileH + L * 1.6);
  const partW = textWidth(parts[i], wordSize);
  const g = group("part" + i, { x: apartX, y: apartY });
  const tile = path("tile" + i, { parent: g, points: rect(-w / 2, -tileH / 2, w, tileH), fill: "paper", stroke: i % 2 ? "accent" : "ink", strokeWidth: 6, closed: 1 });
  const t = text("text" + i, { parent: g, x: 0, y: 0, text: parts[i], size: L * 1.15, color: "ink", weight: 800 });
  // The parts are there from the start, quiet, and come forward one by one as they are named.
  key(g, "opacity", T0, 0.55);
  key(g, "opacity", at[i], 0.55, "step");
  key(g, "opacity", at[i] + 8, 1, "smooth");
  key(g, "scaleX", at[i], 1); key(g, "scaleX", at[i] + 6, 1.12, "out"); key(g, "scaleX", at[i] + 16, 1, "spring");
  key(g, "scaleY", at[i], 1); key(g, "scaleY", at[i] + 6, 1.12, "out"); key(g, "scaleY", at[i] + 16, 1, "spring");
  // The meaning under its tile, while the parts are apart.
  const m = means[i] ? wrapText(means[i], meanSize, Math.max(w, L * 3.2)).slice(0, 2) : [];
  m.forEach((l, k) => {
    const id = text(`mean${i}-${k}`, { x: apartX, y: apartY + tileH / 2 + L * 0.7 + k * meanSize * 1.1, text: l, size: meanSize, color: "accent", weight: 700 });
    appear(id, at[i] + 6);
    key(id, "opacity", joinAt, 1);
    key(id, "opacity", joinAt + 10, 0, "smooth");
  });
  // Joining: the tiles fade, the parts slide into the whole word and grow to its size.
  const to = wx + partW / 2;
  const toY = H * 0.62;
  key(g, "x", joinAt, apartX); key(g, "x", joinAt + 24, to, "smooth");
  key(g, "y", joinAt, apartY); key(g, "y", joinAt + 24, toY, "smooth");
  key(tile, "opacity", joinAt, 1); key(tile, "opacity", joinAt + 14, 0, "smooth");
  key(t, "size", joinAt, L * 1.15); key(t, "size", joinAt + 24, wordSize, "smooth");
  // Once together, the parts give way to the word written whole, so it is spaced as the font spaces it.
  key(g, "opacity", joinAt + 22, 1); key(g, "opacity", joinAt + 28, 0, "smooth");
  wx += partW;
  ax += w + gap;
}
appear(text("word", { x: W / 2, y: H * 0.62, text: parts.slice(0, n).join(""), size: wordSize, color: "accent", weight: 800 }), joinAt + 28, "fade", 8);
if (args.whole) {
  const ws = wrapText(String(args.whole), L * 0.85, W).slice(0, 2);
  ws.forEach((l, k) => appear(text("whole" + k, { x: W / 2, y: H * 0.62 + wordSize * 0.9 + k * L, text: l, size: L * 0.85, color: "ink" }), joinAt + 30));
}
