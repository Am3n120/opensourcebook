// A field of dots scattered at random, some of one kind and the rest another, then a sample drawn from it with its
// share counted as the dots are picked: sampling, surveys, estimating a share, random chance, prevalence.
const total = clamp(Math.round(Number(args.total) || 200), 10, 900);
const share = clamp(Number(args.share) > 1 ? Number(args.share) / 100 : Number(args.share), 0, 1);
const take = clamp(Math.round(Number(args.sample) || 0), 0, total);
const names = items(args.names).map(String);
const U = Math.min(W, H);
const L = clamp(U * 0.075, 44, 96);
const fieldH = H - L * 3.2;
const r = clamp(Math.sqrt((W * fieldH) / total) * 0.28, 4, L * 0.4);
const at = beats(3, args.when, [names[0] || "", "sample", ""]);
// Dots placed by a jittered grid, so they spread evenly but look random; which ones are the first kind is random.
const cols = Math.max(1, Math.round(Math.sqrt((total * W) / fieldH)));
const rows = Math.ceil(total / cols);
const cw = W / cols, ch = fieldH / rows;
const kind = Array.from({ length: total }, (_, i) => i < Math.round(total * share));
for (let i = total - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [kind[i], kind[j]] = [kind[j], kind[i]]; }
const P = Array.from({ length: total }, (_, i) => ({ x: ((i % cols) + 0.5 + (random() - 0.5) * 0.7) * cw, y: (Math.floor(i / cols) + 0.5 + (random() - 0.5) * 0.7) * ch }));
for (let i = 0; i < total; i++) {
  const d = path("d" + i, { x: P[i].x, y: P[i].y, points: circle(0, 0, r, 12), fill: "paper", stroke: "ink", strokeWidth: Math.max(1.5, r * 0.25), closed: 1 });
  // The first kind colours in on its moment, in a quick ripple.
  if (kind[i]) { key(d, "fill", T0, "paper"); key(d, "fill", at[0] + Math.floor(random() * 12), "accent", "step"); }
}
// The sample: a random handful ringed one after another, with the count of each kind running beneath.
if (take) {
  const order = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const picked = order.slice(0, take);
  const span = Math.max(take * 2, Math.min(90, (T1 - at[1]) * 0.6));
  let hits = 0;
  const count = text("count", { x: W / 2, y: fieldH + L * 1.6, text: "", size: L, color: "ink", weight: 800 });
  const label = (h, n) => `${h} of ${n}${names[0] ? " " + names[0] : ""} · ${Math.round((h / Math.max(1, n)) * 100)}%`;
  picked.forEach((i, k) => {
    const f = Math.round(at[1] + (k / take) * span);
    appear(path("ring" + k, { x: P[i].x, y: P[i].y, points: circle(0, 0, r * 1.9, 16), stroke: "ink", strokeWidth: Math.max(3, r * 0.35), fill: "none" }), f, "pop", 6);
    if (kind[i]) hits++;
    key(count, "text", f, label(hits, k + 1), "step");
  });
  key(count, "text", T0, "");
} else if (names.length) {
  appear(text("key", { x: W / 2, y: fieldH + L * 1.6, text: `${Math.round(share * total)} of ${total} ${names[0]}`, size: fitSize(`${Math.round(share * total)} of ${total} ${names[0]}`, L, W), color: "accent", weight: 800 }), at[0] + 14);
}
