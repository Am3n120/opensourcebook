// A ranked list whose rows slide into their new order when the values change: a league table, a before-and-after
// ranking, things sorted by a measure. Rows first appear in the order given, then reorder by their values on a word.
const names = items(args.labels).map(String);
const first = items(args.values).map(Number);
const then = items(args.then).map(Number);
const n = Math.min(names.length, 8);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const row = Math.min(H / n, U * 0.2);
const L = clamp(Math.min(row * 0.42, U * 0.085), 40, 100);
const y0 = (H - row * n) / 2 + row / 2;
const rankOf = (vals) => {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (!vals.length) return idx;
  idx.sort((a, b) => (args.order === "up" ? (vals[a] ?? 0) - (vals[b] ?? 0) : (vals[b] ?? 0) - (vals[a] ?? 0)));
  const r = new Array(n);
  idx.forEach((item, pos) => (r[item] = pos));
  return r;
};
// Without new values the list starts in the given order and settles into rank order; with them, ranked then re-ranked.
const startRank = then.length ? rankOf(first) : Array.from({ length: n }, (_, i) => i);
const endRank = rankOf(then.length ? then : first);
const at = beats(n + 1, args.when, names.concat([String(args.cue || "")]));
const move = Math.min(at[n], T1 - 56);
const top0 = Math.max(...first.map(Math.abs), 1e-9), top1 = Math.max(...(then.length ? then : first).map(Math.abs), 1e-9);
const top = Math.max(top0, top1);
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) + unit;
const numW = textWidth("8.", L);
const barX = numW + L * 0.5 + Math.min(W * 0.4, Math.max(...names.slice(0, n).map((s) => textWidth(s, L))) + L * 0.4);
const barW = Math.max(L, W - barX - textWidth(fmt(top), L * 0.9) - L * 0.5);
for (let r = 0; r < n; r++) text("rank" + r, { x: numW, y: y0 + r * row, text: r + 1 + ".", size: L, anchor: "end", color: "ink", weight: 800, opacity: 0.85 });
for (let i = 0; i < n; i++) {
  const g = group("row" + i, { x: 0, y: y0 + startRank[i] * row });
  const lit = String(args.highlight || "") === names[i];
  text("name" + i, { parent: g, x: numW + L * 0.5, y: 0, text: names[i], size: fitSize(names[i], L, barX - numW - L * 0.8), anchor: "start", color: lit ? "accent" : "ink", weight: 700 });
  const v0 = then.length ? first[i] ?? 0 : first[i] ?? 0, v1 = then.length ? then[i] ?? 0 : v0;
  const bar = path("bar" + i, { parent: g, x: barX, y: -row * 0.18, points: rect(0, 0, barW, row * 0.36), fill: lit ? "accent" : "highlight", stroke: "ink", strokeWidth: 3, closed: 1, scaleX: Math.max(0.001, Math.abs(v0) / top0) });
  const val = text("value" + i, { parent: g, x: barX + (Math.abs(v0) / top0) * barW + L * 0.3, y: 0, text: fmt(v0), size: L * 0.9, anchor: "start", color: "ink" });
  // Every row is there from the start, quiet, and comes forward when it is named.
  key(g, "opacity", T0, 0.55);
  key(g, "opacity", at[i], 0.55, "step");
  key(g, "opacity", at[i] + 10, 1, "smooth");
  if (then.length) {
    key(bar, "scaleX", move, Math.max(0.001, Math.abs(v0) / top0));
    key(bar, "scaleX", move + 20, Math.max(0.001, Math.abs(v1) / top1), "smooth");
    key(val, "x", move, barX + (Math.abs(v0) / top0) * barW + L * 0.3);
    key(val, "x", move + 20, barX + (Math.abs(v1) / top1) * barW + L * 0.3, "smooth");
    anim(val, "text", move, move + 20, (t) => fmt(Math.round(lerp(v0, v1, smooth(t)) * 10) / 10), 2);
  }
  // The row slides to its new place, rising rows a beat before falling ones so they cross cleanly.
  const d = endRank[i] - startRank[i];
  if (d) {
    const f = move + 20 + (d < 0 ? 0 : 6);
    key(g, "y", f, y0 + startRank[i] * row);
    key(g, "y", f + 24, y0 + endRank[i] * row, "smooth");
    key(g, "x", f, 0);
    key(g, "x", f + 12, d < 0 ? L * 0.6 : -L * 0.2, "smooth");
    key(g, "x", f + 24, 0, "smooth");
  }
}
