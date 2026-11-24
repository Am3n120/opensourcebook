// A coordinate plane with a function drawn from its rule, point by point, and named points marked on it: a graph
// of y against x, how a curve changes when a number in it changes, where two curves meet.
// f="x*x - 2" in plain arithmetic of x (Math functions as sin, cos, sqrt, exp, log, abs, pow; ^ for powers).
const xmin = Number(args.xmin), xmax = Number(args.xmax);
const fns = items(args.f).map(String).slice(0, 3);
const names = items(args.names).map(String);
const pts = items(args.points).map(String).map((p) => p.split(/\s+/).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
const U = Math.min(W, H);
const L = clamp(U * 0.075, 44, 96);
// Each rule is read once into a function of x; only arithmetic, x and Math's functions are allowed in it.
const ALLOWED = /^[\sx0-9.+\-*/^(),]*$/;
const compile = (src) => {
  const words = src.match(/[a-z]+/gi) || [];
  const known = ["x", "sin", "cos", "tan", "sqrt", "exp", "log", "abs", "pow", "min", "max", "PI", "E", "floor", "round"];
  if (!words.every((w) => known.includes(w))) return null;
  const body = src.replace(/\^/g, "**").replace(/\b(sin|cos|tan|sqrt|exp|log|abs|pow|min|max|floor|round)\b/g, "Math.$1").replace(/\bPI\b/g, "Math.PI").replace(/\bE\b/g, "Math.E");
  if (!ALLOWED.test(src.replace(/[a-z]+/gi, ""))) return null;
  // Evaluated by a tiny parser rather than the language's own, so no code can run: numbers, x, + - * / ** and calls.
  const toks = body.match(/Math\.[A-Za-z]+|\d*\.?\d+(?:e[+-]?\d+)?|\*\*|[x+\-*/(),]/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const prim = (X) => {
    const t = take();
    if (t === "(") { const v = sum(X); take(); return v; }
    if (t === "-") return -power(X);
    if (t === "+") return power(X);
    if (t === "x") return X;
    if (t && t.startsWith("Math.")) {
      const name = t.slice(5);
      if (name === "PI" || name === "E") return Math[name];
      take();
      const a = [sum(X)];
      while (peek() === ",") { take(); a.push(sum(X)); }
      take();
      return Math[name](...a);
    }
    return Number(t);
  };
  const power = (X) => { const b = prim(X); if (peek() === "**") { take(); return Math.pow(b, power(X)); } return b; };
  const prod = (X) => { let v = power(X); while (peek() === "*" || peek() === "/" || (peek() && /^[x(M\d.]/.test(peek()))) { const op = peek() === "*" || peek() === "/" ? take() : "*"; const r = power(X); v = op === "/" ? v / r : v * r; } return v; };
  const sum = (X) => { let v = prod(X); while (peek() === "+" || peek() === "-") { const op = take(); const r = prod(X); v = op === "+" ? v + r : v - r; } return v; };
  return (X) => { i = 0; const v = sum(X); return Number.isFinite(v) ? v : NaN; };
};
const fs = fns.map(compile);
const N = 160;
const samples = fs.map((f) => (f ? Array.from({ length: N + 1 }, (_, k) => { const X = lerp(xmin, xmax, k / N); return [X, f(X)]; }) : []));
const ys = samples.flat().map((p) => p[1]).filter((v) => Number.isFinite(v)).concat(pts.map((p) => p[1]), [0]);
let ymin = args.ymin !== "" && args.ymin !== undefined ? Number(args.ymin) : Math.min(...ys);
let ymax = args.ymax !== "" && args.ymax !== undefined ? Number(args.ymax) : Math.max(...ys);
if (ymax - ymin < 1e-9) { ymax += 1; ymin -= 1; }
const padY = (ymax - ymin) * 0.06;
ymin -= args.ymin === "" ? padY : 0; ymax += args.ymax === "" ? padY : 0;
const left = L * 0.4, right = W - L * 0.4, top = L * 0.6 + fns.length * L * 1.1, bottom = H - L * 1.3;
const X = (v) => lerp(left, right, (v - xmin) / (xmax - xmin));
const Y = (v) => lerp(bottom, top, (v - ymin) / (ymax - ymin));
// Grid and axes through zero (or along the edges when zero is outside), with a few numbered ticks.
const nice = (span) => { const raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw); };
const sx = nice(xmax - xmin), sy = nice(ymax - ymin);
const ax = clamp(Y(0), top, bottom), ay = clamp(X(0), left, right);
let g = 0;
for (let v = Math.ceil(xmin / sx) * sx; v <= xmax + 1e-9; v += sx, g++) {
  path("gx" + g, { points: [X(v), top, X(v), bottom], stroke: "ink", strokeWidth: 2, opacity: 0.15 });
  if (Math.abs(v) > sx * 1e-6) text("nx" + g, { x: X(v), y: Math.min(bottom + L * 0.75, ax + L * 0.7), text: String(Math.round(v * 100) / 100), size: L * 0.8, color: "ink", opacity: 0.8 });
}
g = 0;
for (let v = Math.ceil(ymin / sy) * sy; v <= ymax + 1e-9; v += sy, g++) {
  path("gy" + g, { points: [left, Y(v), right, Y(v)], stroke: "ink", strokeWidth: 2, opacity: 0.15 });
  if (Math.abs(v) > sy * 1e-6) text("ny" + g, { x: ay + L * 0.25, y: Y(v) - L * 0.4, text: String(Math.round(v * 100) / 100), size: L * 0.8, anchor: "start", color: "ink", opacity: 0.8 });
}
path("xaxis", { points: [left, ax, right, ax], stroke: "ink", strokeWidth: 5 });
path("yaxis", { points: [ay, top, ay, bottom], stroke: "ink", strokeWidth: 5 });
const at = beats(fs.length + pts.length, args.when, fns.concat(pts.map((p, k) => names[k] || "")));
const inks = ["accent", "ink", "highlight"];
samples.forEach((s, k) => {
  // The curve, split where it leaves the plane or jumps, drawn left to right from its moment.
  const segs = [[]];
  for (const [xv, yv] of s) {
    const ok = Number.isFinite(yv) && yv >= ymin - (ymax - ymin) && yv <= ymax + (ymax - ymin);
    if (ok) segs[segs.length - 1].push(X(xv), clamp(Y(yv), top - L, bottom + L)); else if (segs[segs.length - 1].length) segs.push([]);
  }
  segs.filter((p) => p.length >= 4).forEach((p, j) => appear(path(`curve${k}-${j}`, { points: p, stroke: inks[k], strokeWidth: k ? 6 : 9, fill: "none" }), at[k], "draw", 40));
  const label = names[k] || ("y = " + fns[k]).replace(/\*/g, "·");
  // The curve's name in a key above the plane: a short stroke of its colour, then the name.
  const size = fitSize(label, L * 0.9, W - L * 1.6);
  const ky = L * (0.5 + k * 1.1);
  appear(path("swatch" + k, { points: [left, ky, left + L * 0.9, ky], stroke: inks[k], strokeWidth: k ? 6 : 9 }), at[k] + 30);
  appear(text("fname" + k, { x: left + L * 1.2, y: ky, text: label, size, anchor: "start", color: inks[k] === "highlight" ? "ink" : inks[k], weight: 800 }), at[k] + 30);
});
pts.forEach(([px, py], k) => {
  const f = at[fs.length + k];
  appear(path("pt" + k, { x: X(px), y: Y(py), points: circle(0, 0, L * 0.3), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 }), f, "pop");
  appear(path("drop" + k, { points: [X(px), Y(py), X(px), ax], stroke: "ink", strokeWidth: 3, opacity: 0.5 }), f + 4, "draw", 10);
  const nm = names[fs.length + k] || `(${px}, ${py})`;
  const size = fitSize(nm, L * 0.9, W * 0.5);
  const toRight = X(px) + textWidth(nm, size) + L * 0.6 < right;
  appear(text("ptname" + k, { x: X(px) + (toRight ? L * 0.5 : -L * 0.5), y: Y(py) - L * 0.6, text: nm, size, anchor: toRight ? "start" : "end", color: "ink", weight: 700 }), f + 6);
});
