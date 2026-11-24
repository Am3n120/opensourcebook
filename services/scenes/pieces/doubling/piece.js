// Growth by repeated multiplying, made countable: dots that split or multiply step by step, each step on its word,
// with the count beside them and, if asked, a straight line of adding for contrast: bacteria, compound interest,
// rumours, chain letters, populations, exponential growth.
const steps = clamp(Math.round(Number(args.steps) || 5), 1, 9);
const factor = clamp(Number(args.factor) || 2, 1.1, 5);
const start = clamp(Math.round(Number(args.start) || 1), 1, 20);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
const counts = [start];
for (let s = 1; s <= steps; s++) counts.push(Math.round(counts[s - 1] * factor));
const shown = Math.min(counts[steps], 512);
const at = beats(steps, args.when, undefined);
const fieldH = H - L * 3.4;
const cols = Math.max(1, Math.round(Math.sqrt((shown * W) / fieldH)));
const cw = W / cols, ch = fieldH / Math.ceil(shown / cols);
const r = Math.max(3, Math.min(cw, ch) * 0.36);
// Every dot has a place in a filled-in grid; dot k is born at the first step whose count passes k, near its parent.
const bornAt = (k) => { for (let s = 0; s <= steps; s++) if (k < Math.min(512, counts[s])) return s; return steps + 1; };
for (let k = 0; k < shown; k++) {
  const x = (k % cols + 0.5) * cw, y = (Math.floor(k / cols) + 0.5) * ch;
  const s = bornAt(k);
  const d = path("d" + k, { x, y, points: circle(0, 0, r, 12), fill: s === 0 ? "accent" : "highlight", stroke: "ink", strokeWidth: Math.max(1.5, r * 0.18), closed: 1 });
  if (s > 0) {
    const f = at[s - 1] + Math.floor((k / shown) * 10);
    // It grows out of its parent's place.
    const parent = Math.floor(k / factor);
    const px = (parent % cols + 0.5) * cw, py = (Math.floor(parent / cols) + 0.5) * ch;
    key(d, "opacity", T0, 0); key(d, "opacity", f, 0, "step"); key(d, "opacity", f + 4, 1, "smooth");
    key(d, "x", f, px); key(d, "x", f + 12, x, "smooth");
    key(d, "y", f, py); key(d, "y", f + 12, y, "smooth");
  }
}
// The count under the field, ticking up with each step, and the step's multiplication written beside it.
const count = text("count", { x: W / 2, y: fieldH + L * 1.3, text: counts[0] + unit, size: L * 1.4, color: "accent", weight: 800 });
const sum = text("rule", { x: W / 2, y: fieldH + L * 2.6, text: "", size: L * 0.85, color: "ink", weight: 700 });
for (let s = 1; s <= steps; s++) {
  key(count, "text", at[s - 1] + 8, counts[s].toLocaleString() + unit, "step");
  key(sum, "text", at[s - 1] + 8, `${counts[s - 1]} × ${Math.round(factor * 100) / 100} = ${counts[s]}`, "step");
}
key(sum, "text", T0, "");
if (counts[steps] > 512) appear(text("more", { x: W / 2, y: fieldH + L * 3.5, text: `(showing 512 of ${counts[steps]})`, size: L * 0.85, color: "ink", opacity: 0.85 }), at[steps - 1] + 8);
