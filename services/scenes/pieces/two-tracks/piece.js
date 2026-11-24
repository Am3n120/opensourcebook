// Two tracks side by side that must meet: a line down the middle splits in two, each side goes through its own steps
// under its own heading, and the two come together at a point where they join, then go on as one. A marker travels
// each track as its steps are said, and the two markers meet at the join.
const cells = (v) => items(v).map(String);
const before = cells(args.start).slice(0, 3);
const left = cells(args.left).slice(0, 5);
const right = cells(args.right).slice(0, 5);
const after = cells(args.then).slice(0, 3);
const heads = cells(args.sides);
const join = String(args.join || "Join");
const thing = String(args.thing || "").trim();
const together = String(args.together) === "1";
const U = Math.min(W, H);
const rows = Math.max(1, left.length, right.length);

// The headings take the lines they need over their tracks.
const headLines = (L) => Math.max(0, ...heads.slice(0, 2).map((h) => Math.min(2, wrapText(h, L * 0.95, W / 2 - L * 1.25).length)));
const headRoom = (L) => (heads.length ? headLines(L) * L * 1.07 + L * 0.45 : L * 0.4);
const lay = (L) => {
  const rowB = L * 1.75, rowT = L * 1.95, bend = L * 1.5;
  const parts = [L * 0.55, thing ? L * 1.5 : 0, before.length * rowB, bend, headRoom(L), rows * rowT, bend, L * 1.9, (after.length ? (after.length - 1) * rowB + L * 0.9 : 0)];
  const need = parts.reduce((s, x) => s + x, 0);
  return { L, rowB, rowT, bend, need, fits: need <= H };
};
let G = lay(clamp(U * 0.085, 40, 100));
for (let k = 0; k < 8 && !G.fits; k++) G = lay(Math.max(30, G.L * 0.93));
const { L, rowB, rowT, bend } = G;
const node = L * 0.34;
const cx = W / 2, d = L * 0.75;
const XL = cx - d, XR = cx + d;

// Down the frame: the thing's name, the shared steps, the split, the headings, the two tracks, the join, what follows.
let y = L * 0.55;
const top = y;
const thingY0 = y;
if (thing) y += L * 1.5;
const BY0 = before.map(() => { const v = y; y += rowB; return v; });
const forkY0 = before.length ? BY0[BY0.length - 1] : thing ? thingY0 : y - L * 0.3;
const trackTop0 = forkY0 + bend;
const firstY0 = trackTop0 + headRoom(L) + rowT * 0.35;
const spanY0 = rowT * (rows - 1);
const trackEnd0 = firstY0 + spanY0 + rowT * 0.45;
const joinY0 = trackEnd0 + bend;
const AY0 = after.map((_, i) => joinY0 + L * 1.9 + i * rowB);
// The parts are spread down the whole height they are given, the words keeping their size.
const bottom0 = (after.length ? AY0[AY0.length - 1] : joinY0) + L * 0.9;
const k = Math.max(1, (H - top) / Math.max(1, bottom0 - top));
const sy = (v) => top + (v - top) * k;
const thingY = sy(thingY0), BY = BY0.map(sy), forkY = sy(forkY0), trackTop = sy(trackTop0), trackEnd = sy(trackEnd0), joinY = sy(joinY0), AY = AY0.map(sy);
const headY = trackTop + L * 0.1 + (headLines(L) * L * 1.07) / 2;
const firstY = sy(firstY0), spanY = spanY0 * k;
const LY = left.map((_, i) => firstY + (left.length > 1 ? (spanY * i) / (left.length - 1) : spanY / 2));
const RY = right.map((_, i) => firstY + (right.length > 1 ? (spanY * i) / (right.length - 1) : spanY / 2));

// The words: shared parts to the right of the middle line, each track's steps to its outer side.
const sideW = cx - d - node - L * 0.45;
const midX = cx + node + L * 0.35, midW = W - midX - L * 0.1;
const label = (id, s, x, yy, w, anchor, size, color, weight, f) => {
  const ls = wrapText(s, size, w).slice(0, 2);
  ls.forEach((l, k) => appear(text(`${id}-${k}`, { x, y: yy + (k - (ls.length - 1) / 2) * size * 1.12, text: l, size: fitSize(l, size, w), anchor, color, weight }), f));
};

// When: in the order they are said, the shared steps, then one track and the other (or the two in turn, together=1),
// then the join and what follows.
const order = [];
before.forEach((s, i) => order.push(["b", i, s]));
if (together) for (let i = 0; i < rows; i++) { if (left[i]) order.push(["l", i, left[i]]); if (right[i]) order.push(["r", i, right[i]]); }
else { left.forEach((s, i) => order.push(["l", i, s])); right.forEach((s, i) => order.push(["r", i, s])); }
order.push(["j", 0, join]);
after.forEach((s, i) => order.push(["a", i, s]));
const at = beats(order.length, args.when, order.map((o) => o[2]));
const when = {};
order.forEach((o, k) => (when[o[0] + o[1]] = at[k]));
// Where it all starts is there from the opening, so the scene opens on it.
if (!items(args.when).length && before.length) when.b0 = T0;
const jAt = when.j0;
const lFirst = left.length ? when.l0 : jAt - 12, rFirst = right.length ? when.r0 : jAt - 12;
const splitAt = Math.max(T0, Math.min(lFirst, rFirst) - 16);
const headAt = (s) => (s ? rFirst : lFirst) - 8;

// The lines: the middle down to the fork, two tracks, the two coming back together, the middle on from the join.
const S = (x0, y0, x1, y1) => { const p = []; for (let j = 0; j <= 16; j++) { const t = j / 16; p.push(lerp(x0, x1, smooth(t)), lerp(y0, y1, t)); } return p; };
const lineTo = (id, pts, f, color) => appear(path(id, { points: pts, stroke: color || "ink", strokeWidth: 6, fill: "none" }), f, "draw", 14);
const topY = thing ? thingY : before.length ? BY[0] : forkY;
if (before.length > 1 || (thing && before.length)) lineTo("stem", [cx, topY, cx, forkY], T0);
lineTo("forkL", S(cx, forkY, XL, trackTop).concat([XL, trackTop + 1]), splitAt);
lineTo("forkR", S(cx, forkY, XR, trackTop).concat([XR, trackTop + 1]), splitAt);
lineTo("trackL", [XL, trackTop, XL, trackEnd], lFirst - 10);
lineTo("trackR", [XR, trackTop, XR, trackEnd], rFirst - 10);
lineTo("meetL", S(XL, trackEnd, cx, joinY), jAt - 14, "accent");
lineTo("meetR", S(XR, trackEnd, cx, joinY), jAt - 14, "accent");
if (after.length) lineTo("stemAfter", [cx, joinY, cx, AY[AY.length - 1]], jAt + 6);

// The nodes and their words.
if (thing) {
  const pw = Math.min(textWidth(thing, L * 0.85, "title") + L * 0.9, W * 0.7), ph = L * 1.1;
  const pill = arc(pw / 2 - ph / 2, 0, ph / 2, -Math.PI / 2, Math.PI / 2, 10).concat(arc(-pw / 2 + ph / 2, 0, ph / 2, Math.PI / 2, Math.PI * 1.5, 10));
  appear(path("thing", { x: cx, y: thingY, points: pill, fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 }), T0, "pop");
  appear(text("thingName", { x: cx, y: thingY, text: thing, size: fitSize(thing, L * 0.85, pw - L * 0.6, "title"), color: "ink", weight: 800 }), T0 + 2);
}
const dot = (id, x, yy, f, fill) => appear(path(id, { x, y: yy, points: circle(0, 0, node), fill: fill || "paper", stroke: "ink", strokeWidth: 5, closed: 1 }), f, "pop");
before.forEach((s, i) => { dot("shared" + i, cx, BY[i], when["b" + i]); label("sharedName" + i, s, midX, BY[i], midW, "start", L * 0.85, "ink", 800, when["b" + i] + 3); });
heads.slice(0, 2).forEach((h, s) => label("head" + s, h, s ? XR + node * 0.3 : XL - node * 0.3, headY, sideW + node, s ? "start" : "end", L * 0.95, "accent", 800, headAt(s)));
const leftDots = left.map((s, i) => { const id = dot("left" + i, XL, LY[i], when["l" + i], "accent"); label("leftName" + i, s, XL - node - L * 0.3, LY[i], sideW, "end", L * 0.85, "ink", 700, when["l" + i] + 3); return id; });
const rightDots = right.map((s, i) => { const id = dot("right" + i, XR, RY[i], when["r" + i], "accent"); label("rightName" + i, s, XR + node + L * 0.3, RY[i], sideW, "start", L * 0.85, "ink", 700, when["r" + i] + 3); return id; });
const jr = node * 1.5;
appear(path("join", { x: cx, y: joinY, points: circle(0, 0, jr), fill: "accent", stroke: "ink", strokeWidth: 6, closed: 1 }), jAt, "pop");
label("joinName", join, cx + jr + L * 0.35, joinY, W - (cx + jr + L * 0.35) - L * 0.1, "start", L * 0.92, "accent", 800, jAt + 3);
after.forEach((s, i) => { dot("next" + i, cx, AY[i], when["a" + i]); label("nextName" + i, s, midX, AY[i], midW, "start", L * 0.85, "ink", 800, when["a" + i] + 3); });

// The markers: one down the middle, two along the tracks after the split, one again from the join.
const mr = node * 0.62;
const marker = (id, x, yy) => path(id, { x, y: yy, points: circle(0, 0, mr), fill: "highlight", stroke: "ink", strokeWidth: 4, closed: 1 });
const glide = (id, pts, f0, f1) => {
  const len = [0];
  for (let j = 2; j < pts.length; j += 2) len.push(len[len.length - 1] + Math.hypot(pts[j] - pts[j - 2], pts[j + 1] - pts[j - 1]));
  const tot = len[len.length - 1] || 1;
  const pos = (t) => {
    const target = smooth(t) * tot;
    let j = 0;
    while (j < len.length - 1 && len[j + 1] < target) j++;
    const u = len[j + 1] > len[j] ? (target - len[j]) / (len[j + 1] - len[j]) : 0;
    return { x: lerp(pts[j * 2], pts[j * 2 + 2] ?? pts[j * 2], u), y: lerp(pts[j * 2 + 1], pts[j * 2 + 3] ?? pts[j * 2 + 1], u) };
  };
  const a = Math.round(f0), b = Math.max(a + 4, Math.round(f1));
  anim(id, "x", a, b, (t) => pos(t).x, 2);
  anim(id, "y", a, b, (t) => pos(t).y, 2);
};
const lead = Math.round(fps * 0.9);
// The one before the split, stepping down the shared steps.
const m0 = marker("marker", cx, topY);
appear(m0, before.length ? when.b0 : T0, "pop");
for (let i = 1; i < before.length; i++) glide(m0, [cx, BY[i - 1], cx, BY[i]], Math.max(when["b" + (i - 1)] + 4, when["b" + i] - lead), when["b" + i]);
key(m0, "opacity", splitAt, 1);
key(m0, "opacity", splitAt + 4, 0, "smooth");
// One marker per track, from the fork through its steps to the end of its track, where it waits for the other.
const track = (id, X, Ys, names, tag, first) => {
  const m = marker(id, cx, forkY);
  appear(m, splitAt, "pop", 6);
  let at0 = splitAt, pts = S(cx, forkY, X, trackTop);
  if (!Ys.length) { glide(m, pts.concat([X, trackEnd]), splitAt + 2, jAt - 16); return m; }
  glide(m, pts.concat([X, Ys[0]]), Math.max(splitAt + 2, first - lead * 1.5), Math.max(splitAt + 8, first));
  at0 = first;
  for (let i = 1; i < Ys.length; i++) {
    const f = when[tag + i];
    glide(m, [X, Ys[i - 1], X, Ys[i]], Math.max(at0 + 4, f - lead), f);
    at0 = f;
  }
  glide(m, [X, Ys[Ys.length - 1], X, trackEnd], at0 + 6, Math.max(at0 + 12, Math.min(jAt - 16, at0 + lead)));
  return m;
};
const mL = track("markerLeft", XL, LY, left, "l", lFirst);
const mR = track("markerRight", XR, RY, right, "r", rFirst);
// At the join the two meet in the middle and are one from there on.
glide(mL, S(XL, trackEnd, cx, joinY), jAt - 14, jAt);
glide(mR, S(XR, trackEnd, cx, joinY), jAt - 14, jAt);
key(mR, "opacity", jAt, 1);
key(mR, "opacity", jAt + 3, 0, "step");
for (let i = 0; i < after.length; i++) {
  const f = when["a" + i], from = i ? AY[i - 1] : joinY, prev = i ? when["a" + (i - 1)] : jAt;
  glide(mL, [cx, from, cx, AY[i]], Math.max(prev + 6, f - lead), f);
}
