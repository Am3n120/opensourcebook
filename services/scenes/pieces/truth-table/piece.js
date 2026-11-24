// A truth table worked out for real: every combination of the inputs, row by row as the voice goes, and each output
// column computed from its rule (and, or, not, xor, implies), the true cells marked: logic, conditions, rules of a game.
const ins = items(args.inputs).map(String).slice(0, 4);
const outs = items(args.outputs).map(String).slice(0, 3);
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
// Each rule is read by a small parser: input names, not, and, or, xor, implies, and brackets.
const rule = (src) => {
  const toks = String(src).match(/\(|\)|[^\s()]+/g) || [];
  let i = 0;
  const atom = (env) => {
    const t = toks[i++];
    if (t === "(") { const v = imp(env); i++; return v; }
    if (t && t.toLowerCase() === "not") return !atom(env);
    return Boolean(env[t]);
  };
  const and = (env) => { let v = atom(env); while (toks[i] && toks[i].toLowerCase() === "and") { i++; const r = atom(env); v = v && r; } return v; };
  const xor = (env) => { let v = and(env); while (toks[i] && toks[i].toLowerCase() === "xor") { i++; const r = and(env); v = v !== r; } return v; };
  const or = (env) => { let v = xor(env); while (toks[i] && toks[i].toLowerCase() === "or") { i++; const r = xor(env); v = v || r; } return v; };
  const imp = (env) => { const v = or(env); if (toks[i] && toks[i].toLowerCase() === "implies") { i++; const r = imp(env); return !v || r; } return v; };
  return (env) => { i = 0; return imp(env); };
};
const fns = outs.map(rule);
const n = ins.length;
const rows = Array.from({ length: 1 << n }, (_, r) => ins.map((_, k) => Boolean((r >> (n - 1 - k)) & 1)));
const yes = String(args.true || "T"), no = String(args.false || "F");
const heads = ins.concat(outs);
const cols = heads.length;
const outW = (s) => Math.max(L * 1.8, ...String(s).split(" ").map((w) => textWidth(w, L * 0.85) + L * 0.6), Math.min(textWidth(s, L * 0.85) / 2 + L * 0.6, W / 3));
const cellW = Math.max(textWidth(yes, L * 0.9), textWidth(no, L * 0.9)) + L * 0.6;
const widths = heads.map((h, c) => Math.max(cellW, outW(h)));
const sum = widths.reduce((a, b) => a + b, 0);
const colW = widths.map((w) => (w * W) / Math.max(W, sum));
const tableW = colW.reduce((a, b) => a + b, 0);
const x0 = (W - tableW) / 2;
const headH = L * 2.4;
const rowH = Math.min(L * 1.6, (H - headH) / rows.length);
const y0 = (H - headH - rowH * rows.length) / 2;
const xs = [x0];
for (let c = 0; c < cols; c++) xs.push(xs[c] + colW[c]);
// Headers wrap onto two lines rather than shrink.
heads.forEach((h, c) => {
  const ls = wrapText(h, L * 0.85, colW[c] - L * 0.3).slice(0, 2);
  ls.forEach((l, k) => text(`head${c}-${k}`, { x: xs[c] + colW[c] / 2, y: y0 + headH / 2 + (k - (ls.length - 1) / 2) * L * 0.9, text: l, size: fitSize(l, L * 0.85, colW[c] - L * 0.2), color: c < n ? "ink" : "accent", weight: 800 }));
});
path("headRule", { points: [x0, y0 + headH, x0 + tableW, y0 + headH], stroke: "ink", strokeWidth: 5 });
path("split", { points: [xs[n], y0, xs[n], y0 + headH + rowH * rows.length], stroke: "ink", strokeWidth: 5 });
const at = beats(rows.length, args.when, undefined);
rows.forEach((vals, r) => {
  const y = y0 + headH + rowH * (r + 0.5);
  const env = Object.fromEntries(ins.map((name, k) => [name, vals[k]]));
  const outsV = fns.map((f) => f(env));
  const f = at[r];
  vals.forEach((v, c) => appear(text(`in${r}-${c}`, { x: xs[c] + colW[c] / 2, y, text: v ? yes : no, size: L * 0.9, color: "ink", weight: 600, opacity: v ? 1 : 0.85 }), f));
  outsV.forEach((v, j) => {
    const c = n + j;
    if (v) appear(path(`true${r}-${j}`, { x: xs[c] + colW[c] / 2, y, points: circle(0, 0, Math.min(rowH, colW[c]) * 0.36, 24), fill: "none", stroke: "accent", strokeWidth: 6, closed: 1 }), f + 8, "draw", 10);
    appear(text(`out${r}-${j}`, { x: xs[c] + colW[c] / 2, y, text: v ? yes : no, size: L * 0.9, color: v ? "accent" : "ink", weight: v ? 800 : 400 }), f + 6, v ? "pop" : "fade");
  });
});
