// A ladder of powers of ten, bottom to top, with things placed at their size: scale, orders of magnitude, how far
// apart the small and the huge are. Each thing arrives as it is named.
const names = items(args.labels).map(String);
const vals = items(args.values).map(Number).filter((v) => v > 0);
const n = Math.min(names.length || vals.length, vals.length, 10);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const logs = vals.slice(0, n).map((v) => Math.log10(v));
const lo = Math.floor(Math.min(...logs)), hi = Math.ceil(Math.max(...logs, lo + 1));
const top = L * 0.9, bottom = H - L * 0.9;
const Y = (lg) => lerp(bottom, top, (lg - lo) / (hi - lo || 1));
const ax = textWidth("10" + "00" + unit, L * 0.85) + L * 0.8;
path("axis", { points: [ax, top - L * 0.3, ax, bottom + L * 0.3], stroke: "ink", strokeWidth: 6 });
const sup = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const pow = (p) => "10" + (p < 0 ? "⁻" : "") + String(Math.abs(p)).split("").map((d) => sup[Number(d)]).join("");
const every = Math.max(1, Math.ceil(((hi - lo) * L * 1.2) / (bottom - top)));
for (let p = lo; p <= hi; p++) {
  const y = Y(p);
  path("tick" + (p - lo), { points: [ax - L * 0.3, y, ax + L * 0.3, y], stroke: "ink", strokeWidth: 4 });
  if ((p - lo) % every === 0) text("pow" + (p - lo), { x: ax - L * 0.45, y, text: pow(p) + unit, size: L * 0.85, anchor: "end", color: "ink", opacity: 0.85 });
  // Faint steps between powers, closer together toward the top of each decade, as a log scale has them.
  if (p < hi) for (let k = 2; k < 10; k += 1) {
    const yy = Y(p + Math.log10(k));
    path(`minor${p - lo}-${k}`, { points: [ax - L * 0.12, yy, ax + L * 0.12, yy], stroke: "ink", strokeWidth: 2, opacity: 0.35 });
  }
}
// Things: a dot on the axis and the name beside it, nudged apart when two sit close.
const order = logs.map((lg, i) => i).sort((a, b) => logs[a] - logs[b]);
const placed = [];
for (const i of order) {
  let y = Y(logs[i]);
  for (const q of placed) if (Math.abs(q - y) < L * 1.15) y = q - L * 1.15;
  placed.push(y);
  const at = beats(n, args.when, names)[i];
  const dot = path("dot" + i, { x: ax, y: Y(logs[i]), points: circle(0, 0, L * 0.3), fill: "accent", stroke: "ink", strokeWidth: 3 });
  appear(dot, at, "pop");
  const lx = ax + L * 1.1;
  if (Math.abs(y - Y(logs[i])) > 2) appear(path("lead" + i, { points: [ax + L * 0.3, Y(logs[i]), lx - L * 0.2, y], stroke: "ink", strokeWidth: 2, opacity: 0.6 }), at);
  const label = names[i] ?? "";
  const size = fitSize(label, L, W - lx);
  appear(text("name" + i, { x: lx, y, text: label, size, anchor: "start", color: "ink", weight: 700 }), at + 4);
}
if (args.span === "1" || args.span === 1) {
  const a = order[0], b = order[order.length - 1];
  const times = Math.round(logs[b] - logs[a]);
  const f = beats(n, args.when, names).reduce((m, x) => Math.max(m, x), 0) + 20;
  const bx = W - L * 0.8;
  appear(path("brace", { points: [bx - L * 0.4, Y(logs[a]), bx, Y(logs[a]), bx, Y(logs[b]), bx - L * 0.4, Y(logs[b])], stroke: "accent", strokeWidth: 6, fill: "none" }), f, "draw", 18);
  appear(text("span", { x: bx - L * 0.6, y: (Y(logs[a]) + Y(logs[b])) / 2, text: `×${pow(times)}`, size: L * 1.1, anchor: "end", color: "accent", weight: 700 }), f + 10);
}
