// A travelling wave drawn from its rule (height = amplitude × sin(kx − ωt)), with its wavelength and amplitude
// marked, that can change its wavelength or amplitude as the words say; optionally a second wave and their sum.
const lengths = items(args.wavelength).map(Number).filter((v) => v > 0);
const amps = items(args.amplitude).map(Number).filter((v) => v >= 0);
const U = Math.min(W, H);
const L = clamp(U * 0.085, 46, 110);
const second = Number(args.second) > 0 ? Number(args.second) : 0;
const rows = second ? 3 : 1;
const band = (H - L * 1.2) / rows;
const at = beats(Math.max(lengths.length, amps.length), args.when, undefined);
const N = 120;
const speed = Number(args.speed) || 1;
// The wave's settings at a frame: each change eases in over a second.
const ease = (list, f, base) => {
  let v = list[0] ?? base;
  for (let i = 1; i < list.length; i++) {
    const s = at[i] ?? T1;
    if (f >= s) v = lerp(list[i - 1], list[i], smooth((f - s) / fps));
  }
  return v;
};
const lam = (f) => ease(lengths, f, 0.5) * W; // wavelength as a share of the width
const amp = (f) => ease(amps, f, 0.8) * (band * 0.38);
const phase = (f) => ((f - T0) / fps) * speed * TAU * 0.5;
const wave = (f, lambda, a, ph, mid) => { const p = []; for (let i = 0; i <= N; i++) { const x = (W * i) / N; p.push(x, mid + a * Math.sin((TAU * x) / lambda - ph)); } return p; };
const mid0 = L * 0.6 + band / 2;
path("axis", { points: [0, mid0, W, mid0], stroke: "ink", strokeWidth: 3, opacity: 0.35 });
const w1 = path("wave", { points: wave(T0, lam(T0), amp(T0), 0, mid0), stroke: "accent", strokeWidth: 9, fill: "none" });
anim(w1, "points", T0, T1, (t, f) => wave(f, lam(f), amp(f), phase(f), mid0), 2);
// The wavelength between two crests, and the amplitude from the middle to a crest, following the wave.
if (args.marks !== "0") {
  // Held still while the wave runs under them: one wavelength between two guides, and the crest height.
  const gx = (f) => clamp((W - lam(f)) / 2, 0, W);
  const top = (f) => mid0 - band * 0.38 - L * 0.55;
  const br = path("lambda", { points: [0, 0, 0, 0], stroke: "ink", strokeWidth: 5, fill: "none" });
  anim(br, "points", T0, T1, (t, f) => [gx(f), top(f) + L * 0.3, gx(f), top(f), gx(f) + lam(f), top(f), gx(f) + lam(f), top(f) + L * 0.3], 3);
  text("lambdaName", { x: W / 2, y: top(T0) - L * 0.6, text: String(args.lengthName || "wavelength"), size: L * 0.9, color: "ink" });
  const ar = path("amp", { points: [0, 0, 0, 0], stroke: "ink", strokeWidth: 5, fill: "none" });
  anim(ar, "points", T0, T1, (t, f) => [W - L * 0.6, mid0, W - L * 0.6, mid0 - amp(f), W - L * 0.9, mid0 - amp(f), W - L * 0.3, mid0 - amp(f)], 3);
  // The height's name sits on a card of the surface's own colour, so the wave running behind it never crosses it.
  const hn = String(args.heightName || "amplitude");
  const hw = textWidth(hn, L * 0.9);
  path("ampCard", { x: W - L * 1.0 - hw - L * 0.3, y: mid0 - L * 1.05, points: rect(0, 0, hw + L * 0.6, L * 1.1), fill: "paper", stroke: "ink", strokeWidth: 2, closed: 1 });
  text("ampName", { x: W - L * 1.0, y: mid0 - L * 0.5, text: hn, size: L * 0.9, anchor: "end", color: "ink" });
}
if (second) {
  const mid1 = mid0 + band, mid2 = mid0 + band * 2;
  path("axis2", { points: [0, mid1, W, mid1], stroke: "ink", strokeWidth: 3, opacity: 0.35 });
  path("axis3", { points: [0, mid2, W, mid2], stroke: "ink", strokeWidth: 3, opacity: 0.35 });
  const lam2 = (f) => second * W;
  const w2 = path("wave2", { points: wave(T0, lam2(T0), amp(T0), 0, mid1), stroke: "ink", strokeWidth: 7, fill: "none" });
  anim(w2, "points", T0, T1, (t, f) => wave(f, lam2(f), amp(f), phase(f), mid1), 2);
  const sum = path("sum", { points: [0, mid2, W, mid2], stroke: "accent", strokeWidth: 9, fill: "none" });
  anim(sum, "points", T0, T1, (t, f) => {
    const p = [];
    for (let i = 0; i <= N; i++) { const x = (W * i) / N; p.push(x, mid2 + (amp(f) * Math.sin((TAU * x) / lam(f) - phase(f)) + amp(f) * Math.sin((TAU * x) / lam2(f) - phase(f))) * 0.5); }
    return p;
  }, 2);
  text("sumName", { x: L * 0.2, y: mid2 - band * 0.42, text: String(args.sumName || "together"), size: L * 0.9, anchor: "start", color: "ink" });
}
