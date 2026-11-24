// A flow chart built down the frame as it is said: stages joined by arrows, questions with a second way out (down to
// an outcome of its own beside the next stage, or back to an earlier stage), and a named thing that passes along the
// arrows from stage to stage, taking the ways the voice says it takes.
const names = items(args.steps).map(String).slice(0, 7);
const n = Math.max(1, names.length);
const cells = (v) => String(v || "").split("|").map((s) => s.trim()); // empty ones keep their place
const notes = cells(args.notes);
const mains = cells(args.main);
const opposite = { yes: "no", no: "yes", pass: "fail", fail: "pass", true: "false", false: "true", accept: "reject", reject: "accept", approved: "rejected", rejected: "approved" };
// Each stage's second way: WORD:OUTCOME, or WORD:>N to go back to stage N (counted from 1).
const ways = cells(args.ways).slice(0, n).map((s, i) => {
  const m = /^(.*?):\s*(>\s*(\d+)|.+)$/.exec(s);
  if (!m) return null;
  const to = m[3] !== undefined ? Number(m[3]) - 1 : -1;
  if (m[3] !== undefined && (to < 0 || to >= i)) return null;
  return { say: m[1].trim(), to, out: m[3] !== undefined ? "" : m[2].trim() };
});
while (ways.length < n) ways.push(null);
const mainWord = (i) => mains[i] || (ways[i] ? opposite[ways[i].say.toLowerCase()] || "" : "");
const taken = items(args.path).map((s) => String(s).toLowerCase());
const thing = String(args.thing || "").trim();
const U = Math.min(W, H);

// The thing's route: down the main way, or out by a second way when the voice says it takes it.
const route = [{ k: "stage", i: 0 }];
let ti = 0;
for (let i = 0, guard = 0; guard < 24; guard++) {
  const w = ways[i];
  if (w && ti < taken.length && taken[ti++] === w.say.toLowerCase()) {
    if (w.to >= 0) { route.push({ k: "back", i, to: w.to }); i = w.to; route.push({ k: "stage", i }); continue; }
    route.push({ k: "out", i });
    break;
  }
  if (i >= n - 1) break;
  i++;
  route.push({ k: "stage", i });
}
const exits = new Set(route.filter((v) => v.k === "out").map((v) => v.i));
// Rows down the frame: each stage has its own, and an outcome sits on the right of the row after its question.
const R = n + (ways[n - 1] && ways[n - 1].out ? 1 : 0);
const hosted = Array.from({ length: R }, (_, r) => (r > 0 && ways[r - 1] && ways[r - 1].out ? r - 1 : -1));
const backWords = ways.filter((w) => w && w.to >= 0).map((w) => w.say);

const lay = (L) => {
  const TL = L * 0.8;
  const pw = thing ? Math.min(textWidth(thing, TL, "title") + L * 0.75, L * 3.8) : L * 0.8;
  const lane = pw + L * 0.3;
  const x0 = lane;
  const rb = backWords.length ? Math.min(L * 3.2, L * 0.85 + Math.max(...backWords.map((s) => textWidth(s, L * 0.8)))) : 0;
  const full = W - x0 - rb;
  const ms = full * 0.52;
  const ox0 = x0 + ms + L * 0.45, ow = x0 + full - ox0;
  const rows = Array.from({ length: R }, (_, r) => {
    const i = r < n ? r : -1;
    const width = hosted[r] >= 0 ? ms : full;
    const q = i >= 0 && (/\?\s*$/.test(names[i]) || !!ways[i]);
    const inset = q ? L * 1.3 : L * 0.7;
    const lines = i >= 0 ? wrapText(names[i], L * 0.85, width - inset).slice(0, 2) : [];
    const note = i >= 0 && notes[i] ? wrapText(notes[i], L * 0.75, width - inset).slice(0, 1) : [];
    const h = i >= 0 ? lines.length * L * 0.95 + note.length * L * 0.85 + L * 0.75 : 0;
    const d = hosted[r];
    const out = d >= 0 ? wrapText(ways[d].out, L * 0.85, ow - L * 0.5).slice(0, 3) : [];
    // The thing docks on the top of an outcome it reaches, so that outcome keeps room above its words.
    const dock = d >= 0 && exits.has(d) ? L * 0.55 : 0;
    const oh = out.length ? out.length * L * 0.95 + L * 0.7 + dock : 0;
    const above = Math.max(h / 2, oh / 2 + (dock ? L * 1.1 : 0)), below = Math.max(h / 2, oh / 2);
    return { i, width, q, inset, lines, note, h, d, out, oh, dock, above, below };
  });
  const sum = rows.reduce((s, r) => s + r.above + r.below, 0);
  const gap = R > 1 ? (H - sum) / (R - 1) : 0;
  return { L, TL, pw, lane, x0, full, ms, ox0, ow, rows, gap, fits: R === 1 || gap >= L * 1.7 };
};
let G = lay(clamp(U * 0.085, 40, 100));
for (let k = 0; k < 6 && !G.fits; k++) G = lay(Math.max(30, G.L * 0.92));
const { L, TL, pw, lane, x0, full, ms, ox0, ow, rows, gap } = G;
const ax = x0 + ms / 2; // the main arrows run down here
const ocx = ox0 + ow / 2;
let yy = 0;
const Y = rows.map((r) => { const y = yy + r.above; yy += r.above + r.below + Math.max(0, gap); return y; });
if (R === 1) Y[0] = H / 2;

const visits = route.filter((v) => v.k !== "back");
const at = beats(visits.length, args.when, visits.map((v) => (v.k === "stage" ? names[v.i] : ways[v.i].out)));
const first = names.map(() => undefined);
visits.forEach((v, k) => { if (v.k === "stage" && first[v.i] === undefined) first[v.i] = at[k]; });
// Stages the thing never reaches still arrive, when their names are said or after the rest.
let after = Math.max(...at);
const show = names.map((s, i) => {
  if (first[i] !== undefined) return first[i];
  const heard = said(s, after);
  after = heard !== undefined ? heard : after + 14;
  return after;
});

const lozenge = (w, h, p) => [-w / 2 + p, -h / 2, w / 2 - p, -h / 2, w / 2, 0, w / 2 - p, h / 2, -w / 2 + p, h / 2, -w / 2, 0, -w / 2 + p, -h / 2];
const rounded = (w, h, r) => arc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, 6).concat(arc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, 6), arc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, 6), arc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, 6), [w / 2 - r, -h / 2]);
const head = (id, x, y, deg, f, color) => appear(path(id, { x, y, rotate: deg, points: [-L * 0.36, -L * 0.28, 0, 0, -L * 0.36, L * 0.28], stroke: color || "ink", strokeWidth: 6, fill: "none" }), f);
const boxes = [];

rows.forEach((r, ri) => {
  if (r.i < 0) return;
  const i = r.i, f = show[i];
  const bx = x0 + r.width / 2;
  const box = path("stage" + i, { x: bx, y: Y[ri], points: r.q ? lozenge(r.width, r.h, L * 0.55) : rounded(r.width, r.h, L * 0.3), fill: "paper", stroke: "ink", strokeWidth: 5, closed: 1 });
  key(box, "stroke", T0, "ink");
  appear(box, f, "pop");
  boxes[i] = box;
  const top = Y[ri] - r.h / 2 + L * 0.375 + L * 0.47;
  r.lines.forEach((l, k) => appear(text(`name${i}-${k}`, { x: bx, y: top + k * L * 0.95, text: l, size: fitSize(l, L * 0.85, r.width - r.inset), color: "ink", weight: 800 }), f + 3));
  r.note.forEach((l, k) => appear(text(`note${i}-${k}`, { x: bx, y: top + r.lines.length * L * 0.95 + k * L * 0.85 - L * 0.05, text: l, size: fitSize(l, L * 0.75, r.width - r.inset), color: "accent", weight: 700 }), f + 6));
});

const wordRoom = (ocx - ax) / 2 - L * 0.5;
rows.forEach((r, ri) => {
  if (r.i < 0) return;
  const i = r.i;
  const bottom = Y[ri] + r.h / 2 + L * 0.12;
  // The main way down to the next stage, with its word to the right of the arrow.
  if (i < n - 1) {
    const yb = Y[ri + 1] - rows[ri + 1].h / 2 - L * 0.12;
    const g = show[i + 1];
    appear(path("down" + i, { points: [ax, bottom, ax, yb], stroke: "ink", strokeWidth: 6, fill: "none" }), g - 8, "draw", 8);
    head("downTip" + i, ax, yb, 90, g);
    const word = mainWord(i);
    if (word && yb - bottom > L * 0.9) appear(text("downWord" + i, { x: ax + L * 0.3, y: rows[ri + 1].dock ? bottom + L * 0.62 : (bottom + yb) / 2 + L * 0.3, text: word, size: fitSize(word, L * 0.8, wordRoom), anchor: "start", color: "accent", weight: 800 }), g - 6);
  }
  const w = ways[i];
  if (!w) return;
  const fw = show[i] + 10;
  if (w.out) {
    // The second way: an arrow down on the right to its outcome, beside the next stage, the way's word left of it.
    const orow = rows[ri + 1], oy = Y[ri + 1];
    const otop = oy - orow.oh / 2 - L * 0.12;
    const wide = x0 + r.width >= ocx + L * 0.3;
    const pts = wide ? [ocx, bottom, ocx, otop] : [x0 + r.width + L * 0.1, Y[ri], ocx, Y[ri], ocx, otop];
    appear(path("side" + i, { points: pts, stroke: "ink", strokeWidth: 6, fill: "none" }), fw, "draw", 10);
    head("sideTip" + i, ocx, otop, 90, fw + 8);
    const ob = path("out" + i, { x: ocx, y: oy, points: rounded(ow, orow.oh, L * 0.45), fill: "paper", stroke: "accent", strokeWidth: 5, closed: 1 });
    key(ob, "strokeWidth", T0, 5);
    appear(ob, fw + 6, "pop");
    const t0 = oy - orow.oh / 2 + orow.dock + L * 0.35 + L * 0.47;
    orow.out.forEach((l, k) => appear(text(`outName${i}-${k}`, { x: ocx, y: t0 + k * L * 0.95, text: l, size: fitSize(l, L * 0.85, ow - L * 0.5), color: "ink", weight: 700 }), fw + 9));
    // When the thing will dock on this outcome, the word sits high in the gap, clear of where the thing stops.
    const wy = wide ? (orow.dock ? bottom + L * 0.62 : (bottom + otop) / 2 + L * 0.3) : Y[ri] - L * 0.4;
    appear(text("sideWord" + i, { x: wide ? ocx - L * 0.3 : (x0 + r.width + ocx) / 2, y: wy, text: w.say, size: fitSize(w.say, L * 0.8, wordRoom), anchor: wide ? "end" : "middle", color: "accent", weight: 800 }), fw);
  } else {
    // The way back: out of the right side, up, and into the earlier stage, with its word beside the line.
    const t = w.to;
    const j = ways.slice(0, i).filter((x) => x && x.to >= 0).length;
    const bx = x0 + full + L * 0.45 + (j % 2) * L * 0.25;
    const exitX = x0 + r.width + L * 0.08;
    if (hosted[t] >= 0) {
      // The earlier stage has an outcome beside it, so the way back comes in under it, through the gap below.
      const ex = x0 + rows[t].width - L * 0.6, eb = Y[t] + rows[t].h / 2 + L * 0.12;
      const gy = Y[t] + rows[t].below + Math.max(0, gap) * 0.5;
      appear(path("back" + i, { points: [exitX, Y[ri], bx, Y[ri], bx, gy, ex, gy, ex, eb], stroke: "accent", strokeWidth: 6, fill: "none" }), fw, "draw", 16);
      head("backTip" + i, ex, eb, -90, fw + 14, "accent");
    } else {
      const enterX = x0 + rows[t].width + L * 0.14;
      appear(path("back" + i, { points: [exitX, Y[ri], bx, Y[ri], bx, Y[t], enterX, Y[t]], stroke: "accent", strokeWidth: 6, fill: "none" }), fw, "draw", 16);
      head("backTip" + i, enterX, Y[t], 180, fw + 14, "accent");
    }
    const room = W - bx - L * 0.3;
    appear(text("backWord" + i, { x: bx + L * 0.25, y: (Y[ri] + Y[t]) / 2 + L * 0.3, text: w.say, size: fitSize(w.say, L * 0.8, room), anchor: "start", color: "accent", weight: 800 }), fw + 4);
  }
});

// The thing: a tag with its name in the lane at the left, beside the stage it is in.
const tv = group("thing", { x: lane / 2, y: Y[0] });
const th = L * 1.05;
if (thing) {
  path("token", { parent: tv, points: rounded(pw, th, th / 2), fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
  text("thingName", { parent: tv, x: 0, y: L * 0.02, text: thing, size: fitSize(thing, TL, pw - L * 0.55, "title"), color: "ink", weight: 800 });
} else {
  path("token", { parent: tv, points: circle(0, 0, L * 0.36), fill: "highlight", stroke: "ink", strokeWidth: 5, closed: 1 });
}
appear(tv, at[0], "pop");
const lit = (id, f) => { key(id, "stroke", f, "accent", "step"); key(id, "strokeWidth", f, 5); key(id, "strokeWidth", f + 6, 9, "out"); };
lit(boxes[0], at[0]);
let cur = { x: lane / 2, y: Y[0] };
let vk = 0;
for (let k = 1; k < route.length; k++) {
  const v = route[k];
  if (v.k === "back") continue;
  vk++;
  // It waits at a stage while that stage is talked about, and moves on in the second before the next is named.
  const to = Math.max(at[vk - 1] + 14, at[vk]), from = Math.max(at[vk - 1] + 6, to - Math.round(fps * 1.1));
  const a = cur;
  if (v.k === "out") {
    // Out by the second way: down the lane to the outcome's top, then across onto it, under the words in the gap.
    const orow = rows[v.i + 1], oy = Y[v.i + 1];
    const next = { x: ocx, y: oy - orow.oh / 2 + L * 0.05 };
    const legs = [a, { x: a.x, y: next.y }, next];
    const go = (t) => { const s = smooth(t) * 2, q = Math.min(1, Math.floor(s)); const u = s - q; return { x: lerp(legs[q].x, legs[q + 1].x, u), y: lerp(legs[q].y, legs[q + 1].y, u) }; };
    anim(tv, "x", from, to, (t) => go(t).x, 2);
    anim(tv, "y", from, to, (t) => go(t).y, 2);
    key(`out${v.i}`, "strokeWidth", to, 5);
    key(`out${v.i}`, "strokeWidth", to + 6, 9, "out");
    cur = next;
  } else {
    const next = { x: lane / 2, y: Y[v.i] };
    anim(tv, "y", from, to, (t) => lerp(a.y, next.y, smooth(t)), 2);
    lit(boxes[v.i], to);
    cur = next;
  }
}
