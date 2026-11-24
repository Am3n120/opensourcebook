// A winding route down the frame with named stops, and a traveller that moves along it reaching each stop as it is
// said: a journey, a delivery, a thing going through steps or stages in order. The traveller can carry the thing's
// name, a stop can have a second way on that is not taken (a fork to a dead end), and a way back can run from a later
// stop to an earlier one.
const stops = items(args.stops).map(String).slice(0, 8);
const cells = (v) => String(v || "").split("|").map((s) => s.trim()); // empty ones keep their place
const notes = cells(args.notes);
const forks = cells(args.branch);
// Ways back: FROM>TO:words, stops counted from 1.
const backs = items(args.returns).map(String).map((s) => /^\s*(\d+)\s*>\s*(\d+)\s*(?::(.*))?$/.exec(s)).filter(Boolean)
  .map((m) => ({ from: Number(m[1]) - 1, to: Number(m[2]) - 1, say: (m[3] || "").trim() }))
  .filter((b) => b.from > b.to && b.to >= 0 && b.from < stops.length);
const thing = String(args.thing || "").trim();
const n = Math.max(2, stops.length);
const U = Math.min(W, H);

// Everything is sized from one letter size, shrunk until the stops' words fit the height.
const lay = (L) => {
  const TL = L * 0.8;
  const pw = thing ? Math.min(textWidth(thing, TL, "title") + L * 0.8, L * 3.8) : L * 0.76;
  const half = pw / 2;
  const sway = L * 1.3;
  const RX = Math.max(L * 1.6, (backs.length ? L * 1.1 : L * 0.25) + sway + half);
  const tx = RX + half + L * 0.4;
  const room = W - tx - L * 0.15;
  const blocks = stops.map((s, i) => {
    const name = wrapText(s, L * 0.9, room).slice(0, 2);
    const note = notes[i] ? wrapText(notes[i], L * 0.85, room).slice(0, 2) : [];
    const fork = forks[i] ? wrapText(forks[i], L * 0.8, room - L * 0.9).slice(0, 2) : [];
    const back = backs.filter((b) => b.from === i && b.say).map((b) => wrapText(b.say, L * 0.8, room - L * 0.9).slice(0, 2));
    return { name, note, fork, back };
  });
  const tall = (b) => b.name.length * L * 0.95 + b.note.length * L * 0.92 + (b.fork.length ? L * 0.2 + b.fork.length * L * 0.8 : 0) + b.back.reduce((s, x) => s + L * 0.2 + x.length * L * 0.8, 0);
  const above = L * 0.62;
  const y0 = L * 0.4 + above;
  const yEnd = H - (tall(blocks[blocks.length - 1] || { name: [""], note: [], fork: [], back: [] }) - above) - L * 0.35;
  const gap = (yEnd - y0) / Math.max(1, n - 1);
  const need = Math.max(...blocks.slice(0, -1).map(tall)) + L * 0.45;
  return { L, TL, pw, half, sway, RX, tx, room, blocks, y0, gap, fits: gap >= need };
};
let G = lay(clamp(U * 0.08, 44, 100));
for (let k = 0; k < 4 && !G.fits; k++) G = lay(Math.max(34, G.L * 0.9));
const { L, TL, pw, half, sway, RX, tx, room, blocks, y0, gap } = G;
const P = stops.map((_, i) => ({ x: RX, y: y0 + gap * i }));

// The road: a smooth curve swinging out to the left between stops, so the words have the width to its right.
const road = [];
for (let i = 0; i < P.length - 1; i++) {
  const a = P[i], b = P[i + 1];
  for (let t = 0; t < 1; t += 1 / 24) road.push(a.x - Math.sin(Math.PI * smooth(t)) * sway, lerp(a.y, b.y, t));
}
road.push(P[P.length - 1].x, P[P.length - 1].y);
path("road", { points: road, stroke: "ink", strokeWidth: L * 0.5, fill: "none", opacity: 0.18 });
const trail = path("trail", { points: road, stroke: "accent", strokeWidth: 8, fill: "none" });
const at = beats(n, args.when, stops);
const len = [0];
for (let k = 2; k < road.length; k += 2) len.push(len[len.length - 1] + Math.hypot(road[k] - road[k - 2], road[k + 1] - road[k - 1]));
const total = len[len.length - 1] || 1;
const stopAt = P.map((_, i) => (i === P.length - 1 ? 1 : len[i * 24] / total));
key(trail, "drawn", T0, 0);
const posAt = (d) => {
  const target = d * total;
  let k = 0;
  while (k < len.length - 1 && len[k + 1] < target) k++;
  const t = len[k + 1] > len[k] ? (target - len[k]) / (len[k + 1] - len[k]) : 0;
  return { x: lerp(road[k * 2], road[k * 2 + 2] ?? road[k * 2], t), y: lerp(road[k * 2 + 1], road[k * 2 + 3] ?? road[k * 2 + 1], t) };
};

// The ways back run round the far left of the road, from the later stop up into the earlier one, and are drawn when
// the later stop is reached.
backs.forEach((b, j) => {
  const a = P[b.from], c = P[b.to];
  const out = L * 0.45 + (j % 2) * L * 0.35;
  const xe = a.x - half - L * 0.12;
  const pts = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    pts.push(lerp(xe, out, Math.sin(Math.PI * t) ** 0.6), lerp(a.y, c.y, smooth(t)));
  }
  const f = at[b.from] + 10;
  appear(path("back" + j, { points: pts, stroke: "accent", strokeWidth: 5, fill: "none", opacity: 0.9 }), f, "draw", 18);
  appear(path("backTip" + j, { x: c.x - half - L * 0.12, y: c.y, points: [-L * 0.34, -L * 0.26, 0, 0, -L * 0.34, L * 0.26], stroke: "accent", strokeWidth: 5, fill: "none" }), f + 16);
});

for (let i = 0; i < P.length; i++) {
  const f = at[i];
  if (i) {
    key(trail, "drawn", at[i - 1] + 6, stopAt[i - 1]);
    key(trail, "drawn", f, stopAt[i], "smooth");
  }
  path("stop" + i, { x: P[i].x, y: P[i].y, points: circle(0, 0, L * 0.3), fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
  const b = blocks[i];
  let y = P[i].y - L * 0.62 + L * 0.42;
  // Every stop's name is there from the start, quiet, and comes forward when the traveller arrives.
  b.name.forEach((l, k) => {
    const id = text(`name${i}-${k}`, { x: tx, y, text: l, size: fitSize(l, L * 0.9, room), anchor: "start", color: "ink", weight: 800, opacity: 0.55 });
    key(id, "opacity", f, 0.55);
    key(id, "opacity", f + 8, 1, "smooth");
    y += L * 0.95;
  });
  b.note.forEach((l, k) => {
    appear(text(`note${i}-${k}`, { x: tx, y, text: l, size: fitSize(l, L * 0.85, room), anchor: "start", color: "accent", weight: 700 }), f + 6);
    y += L * 0.92;
  });
  // The way not taken: a short spur off the road to a dead end, with its words beside the end, quiet.
  if (b.fork.length) {
    y += L * 0.2;
    const ex = tx + L * 0.25, ey = y - L * 0.3;
    const spur = [P[i].x + L * 0.2, P[i].y + L * 0.25, lerp(P[i].x, ex, 0.55), lerp(P[i].y, ey, 0.85), ex - L * 0.1, ey];
    appear(path("fork" + i, { points: spur, stroke: "ink", strokeWidth: 5, fill: "none", opacity: 0.45 }), f + 4, "draw", 12);
    appear(path("forkEnd" + i, { x: ex + L * 0.1, y: ey, points: [-L * 0.2, -L * 0.2, L * 0.2, L * 0.2, 0, 0, -L * 0.2, L * 0.2, L * 0.2, -L * 0.2], stroke: "ink", strokeWidth: 5, fill: "none", opacity: 0.6 }), f + 14);
    b.fork.forEach((l, k) => {
      appear(text(`forkWords${i}-${k}`, { x: tx + L * 0.75, y, text: l, size: fitSize(l, L * 0.8, room - L * 0.75), anchor: "start", color: "ink", weight: 600, opacity: 0.7 }), f + 10);
      y += L * 0.8;
    });
  }
  backs.forEach((bk, j) => {
    if (bk.from !== i || !bk.say) return;
    y += L * 0.2;
    appear(text(`backMark${j}`, { x: tx + L * 0.25, y, text: "↺", size: L * 0.75, color: "accent", weight: 800 }), f + 14);
    b.back[backs.filter((x) => x.from === i && x.say).indexOf(bk)].forEach((l, k) => {
      appear(text(`backWords${j}-${k}`, { x: tx + L * 0.75, y, text: l, size: fitSize(l, L * 0.8, room - L * 0.75), anchor: "start", color: "accent", weight: 700 }), f + 14);
      y += L * 0.8;
    });
  });
}

// The traveller: a dot, or a tag with the thing's name, riding the road from stop to stop.
const tv = group("traveller", { x: P[0].x, y: P[0].y });
if (thing) {
  const h = L * 1.1, r = h / 2, w = pw;
  const pill = arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, 10).concat(arc(-w / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, 10));
  path("token", { parent: tv, points: pill, fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
  text("thing", { parent: tv, x: 0, y: L * 0.02, text: thing, size: fitSize(thing, TL, w - L * 0.6, "title"), color: "ink", weight: 800 });
} else {
  path("token", { parent: tv, points: circle(0, 0, L * 0.38), fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
}
for (let i = 1; i < P.length; i++) {
  const from = at[i - 1] + 6, to = Math.max(from + 6, at[i]);
  anim(tv, "x", from, to, (t) => posAt(lerp(stopAt[i - 1], stopAt[i], smooth(t))).x, 2);
  anim(tv, "y", from, to, (t) => posAt(lerp(stopAt[i - 1], stopAt[i], smooth(t))).y, 2);
}
