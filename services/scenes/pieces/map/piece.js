// A map as the stage: the land drawn quietly, then each place lit as it is said (a country filled in, a city or any
// point marked with its name), a route drawn from one to the next when the places are stops on a way, and a strip of
// time along the bottom when the places have dates. The outlines and cities come with the piece as `pieceData`
// (Natural Earth, public domain; see DATA.md beside this file).
if (!pieceData || !Array.isArray(pieceData.countries)) throw new Error("the map's outlines come with the map piece: run it as map, not as a copy of its program");
const Q = pieceData.scale || 100;
const cells = (v) => String(v || "").split("|").map((s) => s.trim()); // empty ones keep their place
const wanted = items(args.places).map(String).slice(0, 12);
const notes = cells(args.notes);
const dates = cells(args.dates);
const lit = items(args.highlight).map(String);
const route = String(args.route) === "1";
const plain = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

// Rings come stored as whole hundredths of a degree, each point the step from the one before.
const ringOf = (flat) => {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out.push(x / Q, y / Q); }
  return out;
};
const boxOf = (pts) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < pts.length; i += 2) { b[0] = Math.min(b[0], pts[i]); b[1] = Math.min(b[1], pts[i + 1]); b[2] = Math.max(b[2], pts[i]); b[3] = Math.max(b[3], pts[i + 1]); }
  return b;
};
const countries = pieceData.countries.map((c) => {
  const rings = c.p.map(ringOf).map((pts) => ({ pts, box: boxOf(pts) }));
  const main = rings.reduce((a, r) => ((r.box[2] - r.box[0]) * (r.box[3] - r.box[1]) > (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) ? r : a), rings[0]);
  return { names: c.n, keys: c.n.map(plain), continent: c.c, region: c.r, label: [c.l[0] / Q, c.l[1] / Q], rings, main };
});
const cities = pieceData.places.map((p) => ({ name: p[0], keys: [plain(p[0]), p[5] ? plain(p[5]) : ""].filter(Boolean), lon: p[1] / Q, lat: p[2] / Q, rank: p[3], country: p[4] }));

// Each place is a country, a city, or any point given as Name:latitude,longitude.
const marks = wanted.map((w, i) => {
  const at = /^(.*?)\s*:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(w);
  if (at) return { i, kind: "point", name: at[1] || w, lat: Number(at[2]), lon: Number(at[3]) };
  const k = plain(w);
  const country = countries.find((c) => c.keys.includes(k));
  if (country) return { i, kind: "country", name: w, country, lat: country.label[1], lon: country.label[0] };
  const city = cities.filter((c) => c.keys.includes(k)).sort((a, b) => a.rank - b.rank)[0];
  if (city) return { i, kind: "city", name: w, lat: city.lat, lon: city.lon };
  throw new Error(`the map does not know the place "${w}": name a country or a city, or give it as ${w}:latitude,longitude`);
});

// What the map shows: the places with room round them, the whole world, a continent or part of one, or a box.
const area = String(args.area || "").trim();
let view;
const boxArea = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(area);
if (boxArea) {
  const [a, b, c, d] = boxArea.slice(1).map(Number);
  view = [Math.min(b, d), Math.min(a, c), Math.max(b, d), Math.max(a, c)];
} else if (plain(area) === "world") {
  view = [-170, -56, 180, 80];
} else if (area) {
  const k = plain(area);
  const inArea = countries.filter((c) => plain(c.continent) === k || plain(c.region) === k);
  if (!inArea.length) throw new Error(`the map does not know the area "${area}": say world, a continent, a part of one such as Western Europe, or a box as lat,lon,lat,lon`);
  view = boxOf(inArea.flatMap((c) => c.label));
  const pad = Math.max(view[2] - view[0], view[3] - view[1]) * 0.12 + 4;
  view = [view[0] - pad, view[1] - pad, view[2] + pad, view[3] + pad];
} else if (marks.length) {
  view = boxOf(marks.flatMap((m) => (m.kind === "country" ? m.country.main.box : [m.lon, m.lat])));
  const pad = Math.max(view[2] - view[0], view[3] - view[1]) * 0.18 + 3;
  view = [view[0] - pad, view[1] - pad, view[2] + pad, view[3] + pad];
} else {
  view = [-170, -56, 180, 80];
}

// Room for the strip of time below, when there are dates.
const U = Math.min(W, H);
const L = clamp(U * 0.085, 44, 110);
const timed = dates.some((d) => d);
// Each date's place along the strip, by its year when the dates are numbers, else evenly; a date too near another
// takes the next row down, so the strip is as tall as its dates need.
// A year before the common era counts back from it, so 270 BC comes before 30 BC and AD 43.
const years = dates.map((d) => Number(String(d).replace(/[^\d.-]/g, "")) * (/\b(BC|BCE)\b/i.test(d) ? -1 : 1));
const known = dates.map((d, i) => d && Number.isFinite(years[i]) && /\d/.test(d));
const real = known.filter(Boolean).length > 1 && known.every((k, i) => k || !dates[i]);
const lo = Math.min(...years.filter((_, i) => known[i])), hi = Math.max(...years.filter((_, i) => known[i]));
const left = L * 0.8, right = W - L * 0.8;
const xs = marks.map((_, i) => (real && hi > lo && known[i] ? lerp(left, right, (years[i] - lo) / (hi - lo)) : lerp(left, right, marks.length > 1 ? i / (marks.length - 1) : 0.5)));
const DS = L * 0.8;
const rows = [];
const dateRow = marks.map((_, i) => {
  if (!dates[i] || dates.slice(0, i).includes(dates[i])) return -1;
  const dw = textWidth(dates[i], DS);
  const x = clamp(xs[i], dw / 2 + L * 0.1, W - dw / 2 - L * 0.1);
  let r = 0;
  while ((rows[r] || []).some((o) => Math.abs(o[0] - x) < (o[1] + dw) / 2 + L * 0.3)) r++;
  (rows[r] = rows[r] || []).push([x, dw]);
  return r;
});
const band = timed ? L * (1.5 + 1.05 * Math.max(1, rows.length)) : 0;
const MH = H - band;
// Degrees across are shorter away from the equator, so the map is drawn at the middle latitude's true shape.
const k0 = Math.cos((clamp((view[1] + view[3]) / 2, -70, 70) * Math.PI) / 180);
let [x0, y0, x1, y1] = view;
const wide = (x1 - x0) * k0, tall = y1 - y0;
if (wide / tall > W / MH) { const grow = (wide * MH) / W - tall; y0 -= grow / 2; y1 += grow / 2; }
else { const grow = ((tall * W) / MH - wide) / k0; x0 -= grow / 2; x1 += grow / 2; }
const s = W / ((x1 - x0) * k0);
const px = (lon) => (lon - x0) * k0 * s;
const py = (lat) => (y1 - lat) * s;

// The land: every ring that falls in view, its points thinned to what can be seen, the smallest left out if many.
const project = (pts) => {
  const out = [];
  let lx = Infinity, ly = Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = px(pts[i]), y = py(pts[i + 1]);
    if (Math.hypot(x - lx, y - ly) < 1.6 && i + 2 < pts.length) continue;
    out.push(x, y); lx = x; ly = y;
  }
  return out;
};
// A ring that runs off the map is cut at its edge (each side in turn), so nothing is drawn outside the frame.
const clip = (pts) => {
  let poly = [];
  for (let i = 0; i + 1 < pts.length; i += 2) poly.push([pts[i], pts[i + 1]]);
  const sides = [[(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]], [(p) => p[0] <= W, (a, b) => [W, a[1] + ((b[1] - a[1]) * (W - a[0])) / (b[0] - a[0])]], [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]], [(p) => p[1] <= MH, (a, b) => [a[0] + ((b[0] - a[0]) * (MH - a[1])) / (b[1] - a[1]), MH]]];
  for (const [inside, cut] of sides) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length], b = poly[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
    }
    poly = out;
    if (!poly.length) break;
  }
  return poly.flat();
};
const seen = (b) => b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1;
let rings = [];
countries.forEach((c, ci) => c.rings.forEach((r) => {
  if (!seen(r.box)) return;
  const size = (r.box[2] - r.box[0]) * k0 * s * (r.box[3] - r.box[1]) * s;
  if (size < 20) return;
  rings.push({ ci, r, size });
}));
rings.sort((a, b) => b.size - a.size);
rings = rings.slice(0, 700);
// A faint grid of latitude and longitude first, so even open sea reads as a map.
const step = [1, 2, 5, 10, 15, 30].find((g) => (x1 - x0) / g <= 9) || 30;
for (let g = Math.ceil(x0 / step) * step, j = 0; g <= x1; g += step, j++) path("lon" + j, { points: [px(g), 0, px(g), MH], stroke: "ink", strokeWidth: 1.5, opacity: 0.12 });
for (let g = Math.ceil(y0 / step) * step, j = 0; g <= y1; g += step, j++) path("lat" + j, { points: [0, py(g), W, py(g)], stroke: "ink", strokeWidth: 1.5, opacity: 0.12 });
rings.forEach((x, j) => {
  x.points = clip(project(x.r.pts));
  if (x.points.length < 6) return;
  path("land" + j, { points: x.points, closed: 1, fill: "ink", opacity: 0.1 });
});
rings.forEach((x, j) => x.points.length >= 6 && path("coast" + j, { points: x.points, closed: 1, stroke: "ink", strokeWidth: 2, fill: "none", opacity: 0.45 }));

// The edge of the map, so land cut by it reads as running on beyond.
path("frame", { points: rect(0, 0, W, MH), closed: 1, stroke: "ink", strokeWidth: 3, fill: "none", opacity: 0.6 });

// Where each place's mark and its words go, inside the map.
const at = beats(marks.length, args.when, marks.map((m) => m.name));
const pin = marks.map((m) => ({ x: clamp(px(m.lon), L * 0.5, W - L * 0.5), y: clamp(py(m.lat), L * 0.5, MH - L * 0.5) }));

// The route, drawn from stop to stop as each is reached: gentle arcs, so a way over the sea reads as a way.
if (route && marks.length > 1) {
  const pts = [];
  const ends = [0];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = pin[i], b = pin[i + 1];
    const bend = Math.hypot(b.x - a.x, b.y - a.y) * 0.15;
    const nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1;
    for (let t = 0; t <= 1; t += 1 / 20) {
      if (i && t === 0) continue;
      const lift = Math.sin(Math.PI * t) * bend;
      pts.push(lerp(a.x, b.x, t) + (nx / nl) * lift, lerp(a.y, b.y, t) + (ny / nl) * lift);
    }
    ends.push(pts.length / 2 - 1);
  }
  const len = [0];
  for (let k = 2; k < pts.length; k += 2) len.push(len[len.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]));
  const total = len[len.length - 1] || 1;
  const way = path("route", { points: pts, stroke: "accent", strokeWidth: L * 0.16, fill: "none" });
  key(way, "drawn", T0, 0);
  for (let i = 1; i < marks.length; i++) {
    key(way, "drawn", at[i - 1] + 12, len[ends[i - 1]] / total, "step");
    key(way, "drawn", Math.max(at[i - 1] + 13, at[i] - 2), len[ends[i]] / total, "smooth");
  }
}

// Each place lights up as it is said: a country fills in, a city or point gets a dot, and its name and note appear.
// The dots are there to keep words off from the start; each place's words then take the spot round it that is freest.
const used = marks.map((m, i) => (m.kind === "country" ? null : [pin[i].x - L * 0.45, pin[i].y - L * 0.45, L * 0.9, L * 0.9])).filter(Boolean);
const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
marks.forEach((m, i) => {
  const on = lit.includes(m.name) || (!lit.length && !route && marks.length === 1);
  if (m.kind === "country") {
    rings.forEach((x, j) => {
      if (countries[x.ci] !== m.country || x.points.length < 6) return;
      const f = path(`fill${i}-${j}`, { points: x.points, closed: 1, fill: on || lit.length === 0 ? "accent" : "highlight", stroke: "ink", strokeWidth: 2.5, opacity: 0 });
      key(f, "opacity", T0, 0);
      key(f, "opacity", at[i], 0, "step");
      key(f, "opacity", at[i] + 14, on ? 0.85 : 0.6, "smooth");
    });
  } else {
    appear(path("dot" + i, { x: pin[i].x, y: pin[i].y, points: circle(0, 0, L * (on ? 0.36 : 0.26)), fill: on ? "accent" : "paper", stroke: "ink", strokeWidth: 4, closed: 1 }), at[i], "pop");
  }
  // The date is on the strip of time, so only the name and the note sit by the place.
  const name = m.name.replace(/:.*$/, "") || m.name;
  const room = W - L * 0.4;
  const size = fitSize(name, L * (on ? 1.05 : 0.95), room);
  const note = notes[i] || "";
  const subSize = note ? fitSize(note, L * 0.8, room) : 0;
  const w = Math.max(textWidth(name, size), note ? textWidth(note, subSize) : 0);
  const h = size * 1.25 + (note ? subSize * 1.35 : 0);
  const { x, y } = pin[i];
  const g = m.kind === "country" ? L * 0.2 : L * 0.55;
  const options = [];
  for (const d of [g, g * 2.2]) options.push([x + d, y - h / 2], [x - d - w, y - h / 2], [x - w / 2, y - d - h], [x - w / 2, y + d], [x + d, y - h - d * 0.3], [x + d, y + d * 0.3], [x - d - w, y - h - d * 0.3], [x - d - w, y + d * 0.3]);
  if (m.kind === "country") options.unshift([x - w / 2, y - h / 2]);
  // Each spot is first pulled inside the map, then scored by how much it covers words and dots already there.
  const inside = (o) => [clamp(o[0], L * 0.2, Math.max(L * 0.2, W - w - L * 0.2)), clamp(o[1], L * 0.1, Math.max(L * 0.1, MH - h - L * 0.1))];
  const cost = (o) => used.reduce((c, u) => c + overlap([o[0], o[1], w, h], u), 0) + Math.hypot(o[0] + w / 2 - x, o[1] + h / 2 - y) * 0.01;
  const o = options.map(inside).reduce((best, c) => (cost(c) < cost(best) ? c : best));
  used.push([o[0], o[1], w, h]);
  appear(text("name" + i, { x: o[0], y: o[1] + size * 0.6, text: name, size, anchor: "start", color: on && m.kind !== "country" ? "accent" : "ink", weight: on ? 800 : 700 }), at[i] + 8);
  if (note) appear(text("note" + i, { x: o[0], y: o[1] + size * 1.25 + subSize * 0.65, text: note, size: subSize, anchor: "start", color: "ink", weight: 600 }), at[i] + 12);
});

// The strip of time: each date a tick along a line, and a marker that moves along to the date of each place as it is
// reached.
if (timed) {
  const ty = MH + L * 0.75;
  path("time", { points: [left, ty, right, ty], stroke: "ink", strokeWidth: 3, opacity: 0.5 });
  marks.forEach((_, i) => {
    if (dateRow[i] < 0) return;
    path("tick" + i, { points: [xs[i], ty - L * 0.25, xs[i], ty + L * 0.25], stroke: "ink", strokeWidth: 3, opacity: 0.5 });
    const dw = textWidth(dates[i], DS);
    const d = text("when" + i, { x: clamp(xs[i], dw / 2 + L * 0.1, W - dw / 2 - L * 0.1), y: ty + L * (0.95 + 1.05 * dateRow[i]), text: dates[i], size: DS, color: "ink", weight: 700, opacity: 0.55 });
    key(d, "opacity", at[i], 0.55, "step");
    key(d, "opacity", at[i] + 10, 1, "smooth");
  });
  const first = marks.findIndex((_, i) => dates[i]);
  const marker = path("now", { x: xs[Math.max(0, first)], y: ty, points: circle(0, 0, L * 0.3), fill: "accent", stroke: "ink", strokeWidth: 4, closed: 1 });
  appear(marker, at[Math.max(0, first)], "pop");
  // The marker glides from each date to the next as its place is reached.
  key(marker, "x", T0, xs[Math.max(0, first)]);
  let last = first;
  marks.forEach((_, i) => {
    if (i <= first || !dates[i]) return;
    key(marker, "x", at[i], xs[last], "step");
    key(marker, "x", at[i] + 16, xs[i], "smooth");
    last = i;
  });
}
