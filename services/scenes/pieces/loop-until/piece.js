// A loop that goes round until it passes: the steps down the left of a tall loop, a check under it, a marker that runs
// round once per try, a count of the rounds and what each try found on the right, and on the last try the way out
// below opens and the thing goes on to what comes after.
const steps = items(args.steps).map(String).slice(0, 5);
const k = Math.max(1, steps.length);
const check = String(args.check || "Passes?");
const exit = String(args.exit || "Done");
const again = String(args.again || "no");
const done = String(args.done || "yes");
const rounds = clamp(Math.round(Number(args.rounds) || 3), 1, 8);
const notes = String(args.notes || "").split("|").map((s) => s.trim());
const counter = String(args.counter === undefined ? "Round" : args.counter).trim();
const U = Math.min(W, H);
const L = clamp(U * 0.085, 44, 100);
const node = L * 0.36;

// The check under the loop on the left, and what comes after it beside it on the right, with the way out between.
const qMax = W * 0.56, oMax = W * 0.3;
const qLines = wrapText(check, L * 0.85, qMax - L * 1.5).slice(0, 3);
const qW = Math.min(qMax, Math.max(...qLines.map((l) => textWidth(l, L * 0.85))) + L * 1.5);
const qH = qLines.length * L * 0.95 + L * 0.8;
const oLines = wrapText(exit, L * 0.85, oMax - L * 0.5).slice(0, 3);
const oW = Math.min(oMax, Math.max(...oLines.map((l) => textWidth(l, L * 0.85))) + L * 0.5);
const oH = oLines.length * L * 0.95 + L * 0.8;
const below = node + L * 0.3 + Math.max(qH, oH);
// The loop: down the left past the steps, along the bottom through the check, up the right and back along the top.
const xl = L * 0.55, xr = W - L * 0.55, yt = L * 0.45, yb = Math.max(yt + L * 4, H - below);
const cx = L * 0.1 + qW / 2; // the check sits under this point of the loop
const ox = W - oW / 2 - L * 0.05;
const r = L * 0.9;
const loop = [];
const arcPts = (x, y, a0, a1) => { for (let j = 0; j <= 10; j++) { const a = lerp(a0, a1, j / 10); loop.push(x + Math.cos(a) * r, y + Math.sin(a) * r); } };
loop.push(cx, yb);
arcPts(xr - r, yb - r, Math.PI / 2, 0); // bottom right, going up
arcPts(xr - r, yt + r, 0, -Math.PI / 2); // top right, going left
arcPts(xl + r, yt + r, -Math.PI / 2, -Math.PI); // top left, going down
arcPts(xl + r, yb - r, -Math.PI, -Math.PI * 1.5); // bottom left, going right
loop.push(cx, yb);
const len = [0];
for (let j = 2; j < loop.length; j += 2) len.push(len[len.length - 1] + Math.hypot(loop[j] - loop[j - 2], loop[j + 1] - loop[j - 1]));
const total = len[len.length - 1];
const posAt = (d) => {
  const target = (((d % 1) + 1) % 1) * total;
  let j = 0;
  while (j < len.length - 1 && len[j + 1] < target) j++;
  const t = len[j + 1] > len[j] ? (target - len[j]) / (len[j + 1] - len[j]) : 0;
  return { x: lerp(loop[j * 2], loop[j * 2 + 2] ?? loop[j * 2], t), y: lerp(loop[j * 2 + 1], loop[j * 2 + 3] ?? loop[j * 2 + 1], t) };
};
// Where each step sits down the left side, as a share of the way round from the check.
const leftTop = len[0] + (xr - r - cx) + (Math.PI / 2) * r + (yb - yt - 2 * r) + (Math.PI / 2) * r + (xr - xl - 2 * r) + (Math.PI / 2) * r;
const wordsOf = (j) => wrapText(steps[j], L * 0.85, W * 0.56 - (xl + node + L * 0.35)).slice(0, 3).length;
// The first and last steps keep their words clear of the top and bottom of the loop.
const SY = steps.map((_, j) => lerp(yt + L * 0.55 + (wordsOf(0) - 1) * L * 0.5, yb - L * 0.75 - (wordsOf(k - 1) - 1) * L * 0.5, k === 1 ? 0.5 : j / (k - 1)));
const stepD = SY.map((y) => (leftTop + (y - (yt + r))) / total);

const nameX = xl + node + L * 0.35;
const nameW = W * 0.56 - nameX;
const names = steps.map((s) => wrapText(s, L * 0.85, nameW).slice(0, 3));
const sideX = W * 0.56 + L * 0.2;
const sideW = xr - L * 0.35 - sideX;
const sideCX = sideX + sideW / 2;

// When things happen: each try reaches the check on its moment, then the thing goes out.
const labels = Array.from({ length: rounds }, (_, i) => notes[i] || (i === rounds - 1 ? done : again)).concat([exit]);
const firstStep = said(steps[0]) !== undefined ? said(steps[0]) : T0;
const at = beats(rounds + 1, args.when, labels, Math.min(T1 - 10, firstStep + fps * 1.5));
const stepAt = steps.map((s, j) => {
  const heard = said(s);
  const even = Math.round(lerp(T0, at[0] - 12, j / Math.max(1, k)));
  return heard !== undefined && heard < at[0] ? heard : even;
});
for (let j = 1; j < k; j++) stepAt[j] = Math.max(stepAt[j], stepAt[j - 1] + 6);
const qAt = Math.min(at[0] - 6, said(check) !== undefined ? said(check) : at[0] - 6);

// The loop is there from the start, quiet, with arrows showing which way it goes round.
path("loop", { points: loop, stroke: "ink", strokeWidth: 4, fill: "none", opacity: 0.55 });
[0.17, 0.42, 0.62].forEach((d, j) => {
  const a = posAt(d), b = posAt(d + 0.004);
  const dir = Math.atan2(b.y - a.y, b.x - a.x);
  path("way" + j, { x: a.x, y: a.y, rotate: (dir * 180) / Math.PI, points: [-L * 0.3, -L * 0.26, 0, 0, -L * 0.3, L * 0.26], stroke: "ink", strokeWidth: 5, fill: "none", opacity: 0.55 });
});
const dots = [];
for (let j = 0; j < k; j++) {
  const f = stepAt[j];
  dots.push(appear(path("step" + j, { x: xl, y: SY[j], points: circle(0, 0, node), fill: "accent", stroke: "ink", strokeWidth: 5, closed: 1 }), f, "pop"));
  const k0 = names[j].length - 1;
  names[j].forEach((l, m) => appear(text(`name${j}-${m}`, { x: nameX, y: SY[j] + (m - k0 / 2) * L * 1.0, text: l, size: fitSize(l, L * 0.85, nameW), anchor: "start", color: "ink", weight: 700 }), f + 4));
}
// The bottom of the loop, where each try is checked, and the check itself under it.
path("gate", { x: cx, y: yb, points: circle(0, 0, node), fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
const qy = yb + node + L * 0.3 + Math.max(qH, oH) / 2;
const p = L * 0.55;
const qbox = path("check", { x: cx, y: qy, points: [-qW / 2 + p, -qH / 2, qW / 2 - p, -qH / 2, qW / 2, 0, qW / 2 - p, qH / 2, -qW / 2 + p, qH / 2, -qW / 2, 0, -qW / 2 + p, -qH / 2], fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
key(qbox, "stroke", T0, "ink");
appear(qbox, qAt, "pop");
qLines.forEach((l, m) => appear(text("checkWord" + m, { x: cx, y: qy + (m - (qLines.length - 1) / 2) * L * 0.95, text: l, size: fitSize(l, L * 0.85, qW - L * 1.2), color: "ink", weight: 800 }), qAt + 3));
// The way round again, inside the loop at the bottom right where it turns up, and the way out to the right of the
// check, quiet until a try passes.
const ag = `↺ ${again}`;
appear(text("again", { x: xr - L * 0.45, y: yb - L * 0.75, text: ag, size: fitSize(ag, L * 0.8, W * 0.4), anchor: "end", color: "accent", weight: 800 }), qAt + 6);
const ax0 = cx + qW / 2 + L * 0.1, ax1 = ox - oW / 2 - L * 0.12;
const outArrow = path("out", { points: [ax0, qy, ax1, qy], stroke: "ink", strokeWidth: 6, fill: "none" });
const outTip = path("outTip", { x: ax1, y: qy, points: [-L * 0.36, -L * 0.28, 0, 0, -L * 0.36, L * 0.28], stroke: "ink", strokeWidth: 6, fill: "none" });
const doneWord = text("done", { x: (ax0 + ax1) / 2, y: qy - L * 0.45, text: done, size: fitSize(done, L * 0.8, Math.max(L, ax1 - ax0)), color: "accent", weight: 800 });
const obox = path("exit", { x: ox, y: qy, points: rect(-oW / 2, -oH / 2, oW, oH), fill: "paper", stroke: "accent", strokeWidth: 5, closed: 1 });
const oText = oLines.map((l, m) => text("exitWord" + m, { x: ox, y: qy + (m - (oLines.length - 1) / 2) * L * 0.95, text: l, size: fitSize(l, L * 0.85, oW - L * 0.4), color: "ink", weight: 800 }));
const pass = at[rounds - 1];
for (const id of [outArrow, outTip, doneWord, obox, ...oText]) {
  key(id, "opacity", T0, 0);
  key(id, "opacity", qAt + 6, 0, "step");
  key(id, "opacity", qAt + 14, 0.4, "smooth");
  key(id, "opacity", pass + 4, 0.4);
  key(id, "opacity", pass + 12, 1, "smooth");
}

// The marker: round the loop once per try, stopping at the check.
const start = posAt(stepD[0]);
const mk = path("marker", { x: start.x, y: start.y, points: circle(0, 0, node * 0.7), fill: "highlight", stroke: "ink", strokeWidth: 4, closed: 1 });
appear(mk, stepAt[0], "pop");
const go = (d0, d1, f0, f1) => {
  anim(mk, "x", f0, f1, (t) => posAt(lerp(d0, d1, smooth(t))).x, 2);
  anim(mk, "y", f0, f1, (t) => posAt(lerp(d0, d1, smooth(t))).y, 2);
};
// The first time round it follows the steps as they are named, then on to the check.
for (let j = 1; j < k; j++) go(stepD[j - 1], stepD[j], Math.max(stepAt[j - 1] + 2, stepAt[j] - 14), stepAt[j]);
go(stepD[k - 1], 1, Math.max(stepAt[k - 1] + 2, at[0] - 16), at[0]);
const lapStart = [stepAt[0]];
for (let i = 1; i < rounds; i++) {
  const f0 = at[i - 1] + 14, f1 = Math.max(f0 + 12, at[i]);
  lapStart.push(f0);
  go(0, 0.9999, f0, f1);
  // The steps light as the marker passes them.
  for (let j = 0; j < k; j++) {
    const f = Math.round(lerp(f0, f1, stepD[j]));
    key(dots[j], "strokeWidth", f - 2, 5);
    key(dots[j], "strokeWidth", f + 2, 10, "out");
    key(dots[j], "strokeWidth", f + 10, 5, "smooth");
  }
}
// Each try: the check lights, its mark and note come up on the right, and the round count changes for the next.
const cy = yt + r + (yb - yt - 2 * r) * 0.3;
// What a try found stays up for a moment, then the count moves on to the next try, so the two never disagree.
const shownUntil = (j) => (j >= rounds - 1 ? T1 + 1 : Math.min(at[j + 1] - 8, at[j] + Math.round(Math.max(fps * 0.8, Math.min(fps * 1.8, (at[j + 1] - at[j]) * 0.45)))));
for (let i = 0; i < rounds; i++) {
  const f = at[i], last = i === rounds - 1;
  key(qbox, "stroke", f, "accent", "step");
  key(qbox, "strokeWidth", f, 5);
  key(qbox, "strokeWidth", f + 5, 10, "out");
  key(qbox, "strokeWidth", f + 16, 5, "smooth");
  const until = shownUntil(i);
  const show = (id, a, b) => { key(id, "opacity", T0, 0); key(id, "opacity", a, 0, "step"); key(id, "opacity", a + 6, 1, "smooth"); if (b <= T1) { key(id, "opacity", b - 6, 1); key(id, "opacity", b, 0, "smooth"); } return id; };
  const mark = last ? "✓" : "✗";
  show(text("mark" + i, { x: sideCX, y: cy + L * 1.25, text: mark, size: L * 1.1, color: last ? "accent" : "ink", weight: 800 }), f, until);
  if (notes[i]) wrapText(notes[i], L * 0.85, sideW).slice(0, 2).forEach((l, m) => show(text(`result${i}-${m}`, { x: sideCX, y: cy + L * 2.3 + m * L * 0.95, text: l, size: fitSize(l, L * 0.85, sideW), color: last ? "accent" : "ink", weight: 800 }), f, until));
  if (counter) {
    const c = `${counter} ${i + 1}`;
    show(text("count" + i, { x: sideCX, y: cy, text: c, size: fitSize(c, L * 1.15, sideW, "title"), color: "ink", weight: 800 }), i ? shownUntil(i - 1) : lapStart[0], i < rounds - 1 ? shownUntil(i) : T1 + 1);
  }
}
// Out: the marker is let through the check and goes down to what comes after.
key(mk, "opacity", pass + 2, 1);
key(mk, "opacity", pass + 8, 0, "smooth");
const leave = path("leave", { x: ax0, y: qy, points: circle(0, 0, node * 0.7), fill: "highlight", stroke: "ink", strokeWidth: 4, closed: 1 });
appear(leave, pass + 8, "pop", 8);
const outAt = Math.max(pass + 20, at[rounds]);
key(leave, "x", Math.max(pass + 16, outAt - 18), ax0);
key(leave, "x", outAt, ax1 - node * 0.7, "smooth");
key(obox, "strokeWidth", outAt, 5);
key(obox, "strokeWidth", outAt + 6, 10, "out");
