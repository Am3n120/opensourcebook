// A balance scale whose beam tips as things are set in its pans, each as it is named, by the real sum on each side:
// weighing up, which side wins, an equation kept level, trade-offs and evidence on two sides.
const leftN = items(args.left).map(String), rightN = items(args.right).map(String);
const leftW = items(args.leftWeights).map(Number), rightW = items(args.rightWeights).map(Number);
const U = Math.min(W, H);
const L = clamp(U * 0.075, 44, 100);
const cx = W / 2;
const arm = W * 0.36;
const top = H * 0.3;
const panW = Math.min(W * 0.36, arm * 1.15);
const hang = H * 0.2;
const all = leftN.map((s, i) => ({ side: 0, i, name: s, w: leftW[i] ?? 1 })).concat(rightN.map((s, i) => ({ side: 1, i, name: s, w: rightW[i] ?? 1 })));
const at = beats(all.length, args.when, all.map((x) => x.name));
// The stand, its post and its foot.
path("post", { points: [cx, top, cx, H - L * 0.6], stroke: "ink", strokeWidth: 9 });
path("foot", { points: [cx - L * 1.8, H - L * 0.6, cx + L * 1.8, H - L * 0.6], stroke: "ink", strokeWidth: 9 });
path("pivot", { x: cx, y: top, points: polygon(0, 0, L * 0.45, 3, 0), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 });
// The beam turns about the pivot; each pan hangs from an end and stays level.
const beam = group("beam", { x: cx, y: top });
path("bar", { parent: beam, points: [-arm, 0, arm, 0], stroke: "ink", strokeWidth: 10 });
const tilt = (f) => {
  let l = 0, r = 0;
  for (let k = 0; k < all.length; k++) if (f >= at[k] + 6) all[k].side ? (r += all[k].w) : (l += all[k].w);
  const total = l + r;
  return total ? clamp(((r - l) / total) * 22, -18, 18) : 0;
};
// Tip with a little overshoot each time weight lands.
const angleAt = (f) => {
  let a = tilt(T0), prev = a, since = 0;
  for (let k = 0; k < all.length; k++) if (f >= at[k] + 6) { prev = a; a = tilt(at[k] + 6); since = at[k] + 6; }
  const t = clamp((f - since) / 24, 0, 1);
  return since ? lerp(prev, a, 1 - Math.pow(1 - t, 3) * Math.cos(t * 6)) : a;
};
anim(beam, "rotate", T0, T1, (t, f) => angleAt(f), 2);
const ends = [-1, 1];
const pans = ends.map((s, side) => {
  const g = group("pan" + side, { x: cx + s * arm, y: top });
  path("strings" + side, { parent: g, points: [-panW / 2, hang, 0, 0, panW / 2, hang], stroke: "ink", strokeWidth: 3, fill: "none" });
  path("dish" + side, { parent: g, points: arc(0, 0, panW / 2, 0, Math.PI, 20).map((v, k) => (k % 2 ? hang + v * (L * 0.9) / (panW / 2) : v)), fill: "paper", stroke: "ink", strokeWidth: 6, closed: 1 });
  anim(g, "x", T0, T1, (t, f) => cx + s * arm * Math.cos((angleAt(f) * Math.PI) / 180), 2);
  anim(g, "y", T0, T1, (t, f) => top + s * arm * Math.sin((angleAt(f) * Math.PI) / 180), 2);
  return g;
});
// The things in each pan, stacked as blocks sized by weight, their names beside the pan.
const stack = [0, 0], count = [0, 0];
all.forEach((x, k) => {
  const bh = L * (0.7 + Math.min(1.2, x.w / Math.max(...all.map((y) => y.w)) * 0.8));
  const bw = Math.min(panW * 0.75, Math.max(L * 1.6, textWidth(x.name, L * 0.75) + L * 0.6));
  const y = hang - stack[x.side] - bh;
  stack[x.side] += bh + 4;
  const b = path(`thing${x.side}-${x.i}`, { parent: pans[x.side], points: rect(-bw / 2, y, bw, bh), fill: x.side ? "accent" : "highlight", stroke: "ink", strokeWidth: 4, closed: 1 });
  key(b, "y", T0, -H);
  key(b, "y", at[k], -H, "step");
  key(b, "y", at[k] + 10, 0, "bounce");
  appear(b, at[k]);
  const label = text(`name${x.side}-${x.i}`, { parent: pans[x.side], x: 0, y: hang + L * 1.75 + count[x.side]++ * L * 1.05, text: x.name, size: fitSize(x.name, L * 0.85, panW * 1.1), color: "ink", weight: 700 });
  appear(label, at[k] + 8);
});
