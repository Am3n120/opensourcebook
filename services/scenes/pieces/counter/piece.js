// A large number that counts from one value to the next as each is said, with what it counts under it and a bar that
// fills toward a goal when one is given.
const vals = items(args.values).map(Number).filter((v) => Number.isFinite(v));
const start = Number(args.from) || 0;
const unit = String(args.unit || "");
const before = String(args.prefix || "");
const goal = Number(args.goal) || 0;
const U = Math.min(W, H);
const L = clamp(U * 0.08, 42, 100);
const dec = [start].concat(vals).every((v) => Number.isInteger(v)) ? 0 : 1;
const grouped = (v) => {
  const s = Math.abs(v).toFixed(dec);
  const [whole, part] = s.split(".");
  return (v < 0 ? "−" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, String(args.thousands || ",")) + (part ? "." + part : "");
};
const fmt = (v) => before + grouped(v) + unit;
const widest = fmt(Math.max(Math.abs(start), ...vals.map(Math.abs)));
const big = fitSize(widest, L * 3, W * 0.96);
const label = String(args.label || "");
const lines = label ? wrapText(label, L, W * 0.9).slice(0, 3) : [];
const h = big * 1.1 + lines.length * L * 1.25 + (goal ? L * 2.4 : 0);
const y0 = Math.max(big * 0.6, (H - h) / 2 + big * 0.55);
const at = beats(vals.length, args.when, vals.map(String));
const num = text("number", { x: W / 2, y: y0, text: fmt(start), size: big, color: "accent", weight: 800 });
let prev = start;
vals.forEach((v, i) => {
  const from = prev;
  const span = clamp(Math.round(Math.log10(Math.abs(v - from) + 10) * 14), 18, 60);
  anim(num, "text", at[i], at[i] + span, (t) => fmt(lerp(from, v, 1 - Math.pow(1 - t, 3))), 2);
  key(num, "scaleX", at[i] + span, 1);
  key(num, "scaleX", at[i] + span + 6, 1.08, "out");
  key(num, "scaleX", at[i] + span + 16, 1, "spring");
  key(num, "scaleY", at[i] + span, 1);
  key(num, "scaleY", at[i] + span + 6, 1.08, "out");
  key(num, "scaleY", at[i] + span + 16, 1, "spring");
  prev = v;
});
lines.forEach((l, k) => text("label" + k, { x: W / 2, y: y0 + big * 0.9 + k * L * 1.2, text: l, size: L, color: "ink" }));
if (goal) {
  const by = y0 + big * 0.9 + lines.length * L * 1.25 + L * 0.6;
  const bw = W * 0.86, bx = (W - bw) / 2;
  path("track", { x: bx, y: by, points: rect(0, 0, bw, L * 0.7), fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
  const fill = path("fill", { x: bx, y: by, points: rect(0, 0, bw, L * 0.7), fill: "highlight", stroke: "ink", strokeWidth: 4, closed: 1, scaleX: clamp(start / goal, 0.001, 1) });
  let p = start;
  vals.forEach((v, i) => {
    key(fill, "scaleX", at[i], clamp(p / goal, 0.001, 1));
    key(fill, "scaleX", at[i] + 30, clamp(v / goal, 0.001, 1), "out");
    p = v;
  });
  text("goal", { x: bx + bw, y: by + L * 1.45, text: (args.goalName ? String(args.goalName) + " " : "") + fmt(goal), size: L * 0.9, anchor: "end", color: "ink" });
}
