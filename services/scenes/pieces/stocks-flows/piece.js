// Containers joined by pipes, with amounts that flow from one to another by the rule each pipe gives (a share of what
// is in its source each second), stepped for real so the levels move as they would: money between accounts, water
// between tanks, people between groups (susceptible, sick, recovered), stock in a warehouse, energy changing form.
const names = items(args.stocks).map(String).slice(0, 4);
const start = items(args.amounts).map(Number);
const flows = items(args.flows).map(String).map((s) => { const m = /^(.+?)>(.+?):([\d.]+)(?::(.+))?$/.exec(s); return m ? { a: names.indexOf(m[1].trim()), b: names.indexOf(m[2].trim()), rate: Number(m[3]), word: (m[4] || "").trim() } : null; }).filter((f) => f && f.a >= 0 && f.b >= 0);
const n = Math.max(1, names.length);
const unit = String(args.unit || "");
const U = Math.min(W, H);
const L = clamp(U * 0.075, 42, 96);
const go = beats(1, args.when, undefined)[0];
// Step the amounts: each second every flow moves rate × its source's amount, in small steps.
let amt = names.map((_, i) => start[i] ?? 0);
const total = amt.reduce((a, b) => a + b, 0) || 1;
const series = [];
for (let f = 0; f <= frames; f++) {
  series.push(amt.slice());
  if (f < go) continue;
  for (let k = 0; k < 4; k++) {
    const d = amt.map(() => 0);
    for (const fl of flows) { const m = (fl.rate * amt[fl.a]) / fps / 4; d[fl.a] -= m; d[fl.b] += m; }
    amt = amt.map((v, i) => Math.max(0, v + d[i]));
  }
}
// Tanks down the frame, one per row: its name above it, its contents filling from the left, its amount beside it.
const rh = H / n;
const th = Math.min(L * 1.8, rh - L * 3.2);
const tx0 = L * 0.2, tw = W * 0.6;
const pos = names.map((_, i) => ({ y: rh * i + L * 1.3 + th / 2 }));
const top = Math.max(...amt.concat(start), total / n) * 1.05;
const dec = start.every(Number.isInteger) && total >= 20 ? 0 : 1;
names.forEach((nm, i) => {
  const y = pos[i].y;
  text("name" + i, { x: tx0, y: y - th / 2 - L * 0.65, text: nm, size: fitSize(nm, L, W * 0.9), anchor: "start", color: "ink", weight: 800 });
  const level = path("level" + i, { x: tx0, y: y - th / 2, points: rect(0, 0, tw, th), fill: i % 2 ? "accent" : "highlight", stroke: "none", closed: 1, scaleX: Math.max(0.001, (series[0][i] || 0) / top) });
  anim(level, "scaleX", T0, T1, (t, f) => Math.max(0.001, series[Math.min(series.length - 1, f)][i] / top), 3);
  path("tank" + i, { x: tx0, y: y - th / 2, points: rect(0, 0, tw, th), stroke: "ink", strokeWidth: 6, fill: "none", closed: 1 });
  const v = text("amount" + i, { x: tx0 + tw + L * 0.4, y, text: (series[0][i] || 0).toFixed(dec) + unit, size: L, anchor: "start", color: "ink", weight: 800 });
  anim(v, "text", T0, T1, (t, f) => series[Math.min(series.length - 1, f)][i].toFixed(dec) + unit, 6);
});
// Pipes: a down (or up) arrow between tanks with its word beside it, and a drop of colour running along while it flows.
flows.forEach((fl, k) => {
  const down = fl.b > fl.a;
  const x = tx0 + tw * (down ? 0.18 : 0.5) + k * L * 0.25;
  const y0 = down ? pos[fl.a].y + th / 2 : pos[fl.a].y - th / 2 - L * 1.2;
  const y1 = down ? pos[fl.b].y - th / 2 - L * 1.3 : pos[fl.b].y + th / 2;
  const pts = [x, y0, x, y1];
  path("pipe" + k, { points: pts, stroke: "ink", strokeWidth: 6, fill: "none" });
  path("tip" + k, { x, y: y1, rotate: down ? 90 : -90, points: [-L * 0.4, -L * 0.3, 0, 0, -L * 0.4, L * 0.3], stroke: "ink", strokeWidth: 6, fill: "none" });
  const blob = path("flow" + k, { x, y: y0, points: circle(0, 0, L * 0.18, 10), fill: "accent", stroke: "none", closed: 1, opacity: 0 });
  key(blob, "opacity", go, 1, "step");
  anim(blob, "y", go, T1, (t, f) => lerp(y0, y1, ((f - go) % fps) / fps), 2);
  if (fl.word) text("word" + k, { x: x + L * 0.5, y: (y0 + y1) / 2, text: fl.word, size: fitSize(fl.word, L * 0.9, W - x - L), anchor: "start", color: "accent", weight: 700 });
});
