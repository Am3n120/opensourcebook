// A sentence set large across lines, with chosen words underlined by a bracket and named beneath, each as it is said:
// parts of speech, the grammar of a sentence, the key terms of a definition, a line of a law or a poem taken apart.
// marks="cat:subject|sat:verb|on the mat:place" names a word or run of words, then what it is.
const sentence = String(args.text || "");
const marks = items(args.marks).map(String).map((m) => { const k = m.lastIndexOf(":"); return k > 0 ? { words: m.slice(0, k).trim(), tag: m.slice(k + 1).trim() } : { words: m.trim(), tag: "" }; });
const U = Math.min(W, H);
const L = clamp(U * 0.1, 50, 130);
const ws = sentence.split(/\s+/).filter(Boolean);
// Lay the words out in lines, leaving room under each line for brackets and their names.
const gap = textWidth(" ", L);
const lineH = L * 3.4;
const placed = [];
let x = 0, line = 0;
for (const w of ws) {
  const ww = textWidth(w, L);
  if (x > 0 && x + ww > W) { x = 0; line++; }
  placed.push({ w, x, ww, line });
  x += ww + gap;
}
const lines = line + 1;
const y0 = Math.max(L * 0.8, (H - lines * lineH) / 2 + L * 0.8);
const plain = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// Each mark finds its run of words in the sentence, after the last one found.
let from = 0;
const runs = marks.map((m) => {
  const want = m.words.split(/\s+/).map(plain);
  for (let i = from; i + want.length <= placed.length; i++) {
    if (want.every((w, k) => plain(placed[i + k].w) === w)) { from = i + want.length; return { ...m, a: i, b: i + want.length - 1 }; }
  }
  return null;
});
const at = beats(marks.length, args.when, marks.map((m) => m.words));
const lineOf = (i) => y0 + placed[i].line * lineH;
placed.forEach((p, i) => {
  const r = runs.findIndex((q) => q && i >= q.a && i <= q.b);
  const t = text("word" + i, { x: p.x, y: lineOf(i), text: p.w, size: L, anchor: "start", color: "ink", weight: 500 });
  if (r >= 0) { key(t, "color", T0, "ink"); key(t, "color", at[r], "accent", "step"); key(t, "weight", T0, 500); key(t, "weight", at[r], 800, "step"); }
});
// Brackets under each run (split where a run crosses a line), their names centred under them, staggered when close.
const taken = [];
runs.forEach((q, k) => {
  if (!q) return;
  const segs = [];
  for (let i = q.a; i <= q.b; i++) {
    const s = segs[segs.length - 1];
    if (s && placed[i].line === s.line) s.b = i; else segs.push({ a: i, b: i, line: placed[i].line });
  }
  segs.forEach((s, j) => {
    const xa = placed[s.a].x, xb = placed[s.b].x + placed[s.b].ww, y = y0 + s.line * lineH + L * 0.75;
    appear(path(`bracket${k}-${j}`, { points: [xa, y - L * 0.2, xa, y, xb, y, xb, y - L * 0.2], stroke: "accent", strokeWidth: 6, fill: "none" }), at[k], "draw", 12);
  });
  if (q.tag) {
    const s = segs.reduce((m, q2) => (placed[q2.b].x + placed[q2.b].ww - placed[q2.a].x > placed[m.b].x + placed[m.b].ww - placed[m.a].x ? q2 : m));
    const mid = (placed[s.a].x + placed[s.b].x + placed[s.b].ww) / 2;
    const size = fitSize(q.tag, L * 0.75, W);
    const w = textWidth(q.tag, size);
    const a = clamp(mid - w / 2, 0, W - w);
    const y = y0 + s.line * lineH + L * 1.45;
    const level = taken.some((t) => t.line === s.line && t.level === 0 && !(t.b + L * 0.3 < a || t.a - L * 0.3 > a + w)) ? 1 : 0;
    taken.push({ line: s.line, level, a, b: a + w });
    if (level) appear(path(`lead${k}`, { points: [mid, y0 + s.line * lineH + L * 0.8, mid, y + L * 0.95 - L * 0.45], stroke: "accent", strokeWidth: 3 }), at[k] + 4);
    appear(text(`tag${k}`, { x: a + w / 2, y: y + level * L * 0.95, text: q.tag, size, color: "accent", weight: 700 }), at[k] + 6);
  }
});
