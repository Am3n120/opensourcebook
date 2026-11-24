// A month (or a run of weeks) as a calendar grid, with days marked as they are said: a schedule, a deadline, how
// often something happens, a cycle across days, a plan for a month. Marked days take a ring, a fill or a span.
const days = clamp(Math.round(Number(args.days) || 30), 7, 42);
const start = clamp(Math.round(Number(args.start) || 0), 0, 6); // the weekday the first day falls on, 0 = first column
const heads = items(args.weekdays).map(String);
const marks = items(args.marks).map(String).map((m) => { const k = m.indexOf(":"); const range = (k > 0 ? m.slice(0, k) : m).split("-").map(Number); return { from: range[0], to: range[1] ?? range[0], name: k > 0 ? m.slice(k + 1).trim() : "" }; }).filter((m) => m.from >= 1);
const U = Math.min(W, H);
const L = clamp(U * 0.07, 40, 90);
const weeks = Math.ceil((start + days) / 7);
const cw = W / 7;
const legend = marks.filter((m) => m.name).length;
const headH = L * 1.3;
const ch = Math.min(cw * 1.05, (H - headH - legend * L * 1.3 - L * 0.4) / weeks);
const y0 = headH;
const cell = (d) => { const i = start + d - 1; return { x: (i % 7) * cw, y: y0 + Math.floor(i / 7) * ch }; };
(heads.length >= 7 ? heads : ["M", "T", "W", "T", "F", "S", "S"]).slice(0, 7).forEach((h, c) => text("wd" + c, { x: c * cw + cw / 2, y: headH / 2, text: h, size: fitSize(h, L * 0.8, cw - 6), color: "ink", weight: 800, opacity: 0.85 }));
path("rule", { points: [0, headH, W, headH], stroke: "ink", strokeWidth: 4 });
for (let d = 1; d <= days; d++) {
  const c = cell(d);
  path("box" + d, { x: c.x, y: c.y, points: rect(3, 3, cw - 6, ch - 6), fill: "paper", stroke: "ink", strokeWidth: 2, closed: 1, opacity: 0.6 });
  text("n" + d, { x: c.x + cw * 0.5, y: c.y + ch * 0.5, text: String(d), size: Math.min(L * 0.85, ch * 0.42), color: "ink" });
}
const at = beats(marks.length, args.when, marks.map((m) => m.name || String(m.from)));
const styleOf = ["ring", "fill", "ring", "fill"];
marks.forEach((m, k) => {
  const f = at[k];
  const kind = String(args.style || "") || (m.to > m.from ? "fill" : styleOf[k % 4]);
  for (let d = m.from; d <= Math.min(m.to, days); d++) {
    const c = cell(d);
    if (kind === "fill") {
      // A band behind the run of days, its numbers drawn again on top in an ink that reads there.
      appear(path(`band${k}-${d}`, { x: c.x, y: c.y, points: rect(3, ch * 0.18, cw - 6, ch * 0.64), fill: k % 2 ? "highlight" : "accent", stroke: "none", closed: 1, opacity: 0.85 }), f + (d - m.from) * 2);
      key("n" + d, "opacity", T0, 1);
      key("n" + d, "opacity", f + (d - m.from) * 2, 0, "step");
      appear(text(`on${k}-${d}`, { x: c.x + cw * 0.5, y: c.y + ch * 0.5, text: String(d), size: Math.min(L * 0.85, ch * 0.42), color: "ink", weight: 800 }), f + (d - m.from) * 2);
    } else {
      appear(path(`ring${k}-${d}`, { x: c.x + cw / 2, y: c.y + ch / 2, points: circle(0, 0, Math.min(cw, ch) * 0.4, 24), stroke: "accent", strokeWidth: 6, fill: "none" }), f + (d - m.from) * 2, "draw", 10);
    }
  }
});
// The marks' names under the grid, each beside a sample of its mark.
let ly = y0 + weeks * ch + L * 0.9;
marks.forEach((m, k) => {
  if (!m.name) return;
  const kind = String(args.style || "") || (m.to > m.from ? "fill" : styleOf[k % 4]);
  const sw = kind === "fill" ? path("key" + k, { x: L * 0.2, y: ly - L * 0.35, points: rect(0, 0, L * 0.9, L * 0.7), fill: k % 2 ? "highlight" : "accent", stroke: "none", closed: 1 }) : path("key" + k, { x: L * 0.65, y: ly, points: circle(0, 0, L * 0.36, 20), stroke: "accent", strokeWidth: 5, fill: "none" });
  appear(sw, at[k]);
  appear(text("name" + k, { x: L * 1.5, y: ly, text: m.name, size: fitSize(m.name, L * 0.9, W - L * 1.6), anchor: "start", color: "ink", weight: 700 }), at[k] + 4);
  ly += L * 1.3;
});
