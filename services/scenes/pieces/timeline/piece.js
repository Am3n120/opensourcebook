// A timeline running down the frame: a line that draws itself to each event as it is said, a dot, its date and what
// happened. Gaps between events follow the real time between them when the dates are numbers.
const dates = items(args.dates).map(String);
const events = items(args.events).map(String);
const n = Math.max(1, Math.min(Math.max(dates.length, events.length), 10));
const lit = items(args.highlight).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const dateW = Math.max(...dates.slice(0, n).map((d) => textWidth(d, L)), L);
const lx = Math.min(dateW + L * 0.8, W * 0.4);
const tx = lx + L * 0.9, tw = W - tx;
const lines = events.slice(0, n).map((e) => wrapText(e, L * 0.9, tw).slice(0, 3));
const need = lines.map((l) => Math.max(1, l.length) * L * 1.1 + L * 0.7);
// Where each event sits: by its year when every date is a number and the gaps leave room, else evenly.
const years = dates.slice(0, n).map((d) => Number(String(d).replace(/[^\d.-]/g, "")));
const numeric = years.length === n && years.every((y) => Number.isFinite(y)) && n > 1 && years[n - 1] !== years[0];
const free = H - need.reduce((a, b) => a + b, 0) - L;
let ys = [];
if (numeric && args.even !== "1") {
  const span = years[n - 1] - years[0];
  let y = L * 0.6;
  for (let i = 0; i < n; i++) {
    ys.push(y);
    if (i < n - 1) y += need[i] + Math.max(0, free) * ((years[i + 1] - years[i]) / span);
  }
} else {
  const gap = Math.max(0, free) / Math.max(1, n - 1);
  let y = L * 0.6;
  for (let i = 0; i < n; i++) { ys.push(y); y += need[i] + gap; }
}
const at = beats(n, args.when, events.map((e, i) => (dates[i] ? dates[i] + " " + e : e)));
const end = ys[n - 1] + need[n - 1] * 0.4;
// The rail and an empty stop for every event are there from the start, so the scene opens on the shape of the story.
path("rail", { points: [lx, ys[0] - L * 0.4, lx, end], stroke: "ink", strokeWidth: 4, opacity: 0.6 });
for (let i = 0; i < n; i++) path("stop" + i, { x: lx, y: ys[i] + L * 0.1, points: circle(0, 0, L * 0.3), fill: "paper", stroke: "ink", strokeWidth: 3, closed: 1, opacity: 0.6 });
const line = path("line", { points: [lx, ys[0], lx, end], stroke: "accent", strokeWidth: 8 });
key(line, "drawn", T0, 0);
for (let i = 0; i < n; i++) {
  key(line, "drawn", at[i], i ? (ys[i - 1] - ys[0]) / (end - ys[0]) : 0, "step");
  key(line, "drawn", at[i] + 14, (ys[i] - ys[0]) / (end - ys[0]), "smooth");
  const on = lit.includes(dates[i]) || lit.includes(events[i]);
  appear(path("dot" + i, { x: lx, y: ys[i] + L * 0.1, points: circle(0, 0, L * (on ? 0.42 : 0.3)), fill: on ? "accent" : "paper", stroke: "ink", strokeWidth: 5, closed: 1 }), at[i] + 10, "pop");
  // Dates stand along the rail from the start, quiet, and come forward when the line reaches them.
  if (dates[i]) {
    const d = text("date" + i, { x: lx - L * 0.6, y: ys[i] + L * 0.1, text: dates[i], size: fitSize(dates[i], L, lx - L * 0.7), anchor: "end", color: "ink", weight: 700, opacity: 0.6 });
    key(d, "opacity", at[i] + 10, 0.6);
    key(d, "opacity", at[i] + 18, 1, "smooth");
    if (on) { key(d, "color", T0, "ink"); key(d, "color", at[i] + 12, "accent", "step"); }
  }
  lines[i].forEach((l, k) => appear(text(`event${i}-${k}`, { x: tx, y: ys[i] + L * 0.1 + k * L * 1.1, text: l, size: L * 0.9, anchor: "start", color: "ink", weight: on ? 700 : 400 }), at[i] + 14));
}
