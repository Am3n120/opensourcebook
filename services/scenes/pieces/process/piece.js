// Framed stages down the frame joined by arrows with a live progress marker riding from step to step as each is
// named: a linear sequence, a pipeline, or a chain of causes and effects.
const names = items(args.steps).map(String).slice(0, 8);
const notes = String(args.notes || "").split("|").map((s) => s.trim()); // empty ones keep their place
const links = String(args.links || "").split("|").map((s) => s.trim());
const n = Math.max(1, names.length);
const numbered = String(args.numbered) !== "0";
const showToken = String(args.token) !== "0";
const U = Math.min(W, H);
const hasLinks = links.slice(0, Math.max(0, n - 1)).some(Boolean);

// Everything is sized from one letter size, shrunk until all framed stage cards and gaps fit the box.
const lay = (L) => {
  const nSize = Math.max(36, L * 0.8);
  const railX = L * 0.55;
  const cardX = L * 1.35;
  const cardW = Math.max(L * 4, W - cardX - L * 0.1);
  const badgeR = numbered ? L * 0.48 : L * 0.24;
  const badgeX = cardX + L * 0.4 + badgeR;
  const tx = badgeX + badgeR + L * 0.35;
  const tw = Math.max(L * 2, cardX + cardW - tx - L * 0.35);
  const blocks = names.map((s, i) => {
    const title = wrapText(s, L * 0.9, tw).slice(0, 2);
    const note = notes[i] ? wrapText(notes[i], nSize, tw).slice(0, 2) : [];
    const tStep = L * 1.02;
    const nStep = nSize * 1.12;
    const noteGap = note.length ? L * 0.14 : 0;
    const contentH = title.length * tStep + noteGap + note.length * nStep;
    const ch = Math.max(badgeR * 2 + L * 0.65, contentH + L * 0.64);
    return { title, note, tStep, nStep, noteGap, contentH, ch };
  });
  const totalCards = blocks.reduce((s, b) => s + b.ch, 0);
  const minGap = hasLinks ? L * 1.1 : L * 0.65;
  const need = totalCards + Math.max(0, n - 1) * minGap + L * 0.5;
  return { L, nSize, railX, cardX, cardW, badgeR, badgeX, tx, tw, blocks, totalCards, minGap, fits: need <= H };
};
let G = lay(clamp(U * 0.08, 42, 92));
for (let k = 0; k < 6 && !G.fits; k++) G = lay(Math.max(36, G.L * 0.92));
const { L, nSize, railX, cardX, cardW, badgeR, badgeX, tx, tw, blocks, totalCards, minGap } = G;

const maxGap = hasLinks ? L * 2.2 : L * 2.0;
const gap = n > 1 ? Math.max(minGap, Math.min(maxGap, (H - L * 0.5 - totalCards) / (n - 1))) : 0;
const usedH = totalCards + Math.max(0, n - 1) * gap;
let y = n === 1 ? (H - blocks[0].ch) / 2 : Math.max(L * 0.25, (H - usedH) / 2);
const centres = [];
const tops = [];
const bottoms = [];
blocks.forEach((b) => {
  tops.push(y);
  centres.push(y + b.ch / 2);
  bottoms.push(y + b.ch);
  y += b.ch + gap;
});

const at = beats(n, args.when, names);
const rounded = (w, h, r) => {
  const cr = Math.min(r, w / 4, h / 4);
  return arc(w / 2 - cr, -h / 2 + cr, cr, -Math.PI / 2, 0, 6).concat(
    arc(w / 2 - cr, h / 2 - cr, cr, 0, Math.PI / 2, 6),
    arc(-w / 2 + cr, h / 2 - cr, cr, Math.PI / 2, Math.PI, 6),
    arc(-w / 2 + cr, -h / 2 + cr, cr, Math.PI, Math.PI * 1.5, 6),
    [w / 2 - cr, -h / 2],
  );
};

// Left progress rail and stop dots from T0 so the beat opens anchored on the track rather than an empty frame.
if (n > 1) {
  path("rail", { points: [railX, centres[0], railX, centres[n - 1]], stroke: "ink", strokeWidth: 6, fill: "none", opacity: 0.22 });
  const trail = path("trail", { points: [railX, centres[0], railX, centres[n - 1]], stroke: "accent", strokeWidth: 7, fill: "none" });
  const span = Math.max(1, centres[n - 1] - centres[0]);
  key(trail, "drawn", T0, 0);
  for (let i = 0; i < n; i++) {
    const frac = (centres[i] - centres[0]) / span;
    if (i === 0) key(trail, "drawn", at[0], 0);
    else {
      const from = Math.max(at[i - 1] + 2, at[i] - Math.round(fps * 0.9));
      key(trail, "drawn", from, (centres[i - 1] - centres[0]) / span);
      key(trail, "drawn", Math.max(from + 2, at[i]), frac, "smooth");
    }
    path("stop" + i, { x: railX, y: centres[i], points: circle(0, 0, L * 0.2), fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
  }
} else {
  path("stop0", { x: railX, y: centres[0], points: circle(0, 0, L * 0.2), fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
}

// Framed stage cards: outlines stand ready quietly from T0 (no early text), then light up with their badge and words when spoken.
blocks.forEach((b, i) => {
  const cy = centres[i];
  const f = at[i];
  const card = path("card" + i, { x: cardX + cardW / 2, y: cy, points: rounded(cardW, b.ch, L * 0.28), fill: "paper", stroke: "ink", strokeWidth: 3, opacity: 0.55, closed: 1 });
  key(card, "opacity", T0, 0.55);
  key(card, "stroke", T0, "ink");
  key(card, "strokeWidth", T0, 3);
  key(card, "opacity", f, 1, "smooth");
  key(card, "stroke", f, "accent", "step");
  key(card, "strokeWidth", f, 8, "out");
  if (i + 1 < n) {
    const settle = Math.max(f + 8, at[i + 1]);
    key(card, "stroke", settle, "ink", "step");
    key(card, "strokeWidth", settle, 5, "out");
  }

  appear(path("badge" + i, { x: badgeX, y: cy, points: circle(0, 0, badgeR), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 }), f + 1, "pop");
  if (numbered) appear(text("num" + i, { x: badgeX, y: cy, text: String(i + 1), size: L * 0.88, color: "paper", weight: 800 }), f + 2);

  let ly = cy - b.contentH / 2 + b.tStep / 2;
  b.title.forEach((l, k) => {
    appear(text(`step${i}-${k}`, { x: tx, y: ly, text: l, size: fitSize(l, L * 0.9, tw), anchor: "start", color: "ink", weight: 800 }), f + 3);
    ly += b.tStep;
  });
  ly += b.noteGap - b.tStep / 2 + b.nStep / 2;
  b.note.forEach((l, k) => {
    appear(text(`note${i}-${k}`, { x: tx, y: ly, text: l, size: fitSize(l, nSize, tw), anchor: "start", color: "ink", opacity: 0.82, weight: 600 }), f + 6);
    ly += b.nStep;
  });
});

// Connector arrows centered under the cards, with optional transition word beside each arrow.
const ax = cardX + cardW * 0.5;
const wordRoom = Math.max(L * 2, cardX + cardW - (ax + L * 0.35) - L * 0.1);
for (let i = 0; i < n - 1; i++) {
  const y0 = bottoms[i] + L * 0.08;
  const y1 = tops[i + 1] - L * 0.08;
  if (y1 - y0 < L * 0.35) continue;
  const gf = at[i + 1];
  appear(path("link" + i, { points: [ax, y0, ax, y1], stroke: "ink", strokeWidth: 5, fill: "none" }), gf - 8, "draw", 10);
  appear(path("tip" + i, { x: ax, y: y1, points: [-L * 0.26, -L * 0.32, 0, 0, L * 0.26, -L * 0.32], stroke: "ink", strokeWidth: 5, fill: "none" }), gf);
  if (links[i] && y1 - y0 > L * 0.7) {
    appear(text("word" + i, { x: ax + L * 0.35, y: (y0 + y1) / 2, text: links[i], size: fitSize(links[i], Math.max(36, L * 0.82), wordRoom), anchor: "start", color: "accent", weight: 800 }), gf - 4);
  }
}

// Live progress marker riding the left rail from step to step as each stage is spoken.
if (showToken && n > 1) {
  const tok = path("token", { x: railX, y: centres[0], points: circle(0, 0, L * 0.3), fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
  appear(tok, at[0], "pop");
  for (let i = 1; i < n; i++) {
    const to = Math.max(at[i - 1] + 8, at[i]);
    const from = Math.max(at[i - 1] + 2, to - Math.round(fps * 0.9));
    if (to > from) anim(tok, "y", from, to, (t) => lerp(centres[i - 1], centres[i], smooth(t)), 2);
  }
}
