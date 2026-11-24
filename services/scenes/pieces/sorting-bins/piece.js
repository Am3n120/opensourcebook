// Things that arrive one by one and fly into the labelled tray they belong to, as each is named, the trays filling:
// sorting into categories, classifying examples, what goes where, recycling, kinds of rock, word or cell.
// items="Glass jar:Recycle|Banana peel:Compost|Crisp packet:Waste"; the trays are the names after the colons.
const things = items(args.items).map(String).map((s) => { const k = s.lastIndexOf(":"); return k > 0 ? { name: s.slice(0, k).trim(), bin: s.slice(k + 1).trim() } : null; }).filter(Boolean).slice(0, 12);
const bins = [];
for (const t of things) if (!bins.includes(t.bin)) bins.push(t.bin);
for (const b of items(args.bins).map(String)) if (!bins.includes(b)) bins.push(b);
const nb = Math.max(1, Math.min(bins.length, 5));
const U = Math.min(W, H);
const L = clamp(U * 0.08, 44, 100);
const size = L * 0.85;
// Trays stacked down the frame under a space where each thing first appears.
const topArea = L * 2.4;
const trayH = (H - topArea) / nb;
const nameW = Math.min(W * 0.34, Math.max(...bins.slice(0, nb).map((b) => textWidth(b, L))) + L * 0.4);
const at = beats(things.length, args.when, things.map((t) => t.name));
bins.slice(0, nb).forEach((b, i) => {
  const y = topArea + i * trayH;
  path("tray" + i, { points: [nameW, y + L * 0.3, nameW, y + trayH - L * 0.3, W, y + trayH - L * 0.3], stroke: "ink", strokeWidth: 6, fill: "none" });
  text("binName" + i, { x: nameW - L * 0.35, y: y + trayH / 2, text: b, size: fitSize(b, L, nameW - L * 0.4), anchor: "end", color: "accent", weight: 800 });
});
// Each thing appears large at the top, then flies to the next free place in its tray.
const fill = bins.map(() => ({ x: nameW + L * 0.4, row: 0 }));
things.forEach((t, k) => {
  const i = bins.indexOf(t.bin);
  if (i < 0 || i >= nb) return;
  const w = textWidth(t.name, size) + L * 0.6, h = L * 1.25;
  const slot = fill[i];
  if (slot.x + w > W - L * 0.1 && slot.x > nameW + L * 0.4) { slot.x = nameW + L * 0.4; slot.row++; }
  const restX = slot.x + w / 2, restY = topArea + i * trayH + trayH - L * 0.3 - h / 2 - 6 - slot.row * (h + 8);
  slot.x += w + L * 0.3;
  const g = group("thing" + k, { x: W / 2, y: topArea / 2 });
  path("chip" + k, { parent: g, points: rect(-w / 2, -h / 2, w, h), fill: "paper", stroke: "ink", strokeWidth: 4, closed: 1 });
  text("name" + k, { parent: g, x: 0, y: 0, text: t.name, size, color: "ink", weight: 700 });
  const f = at[k];
  appear(g, f, "pop", 8);
  // It travels round the trays rather than over them: across the top, down the right edge, then into its place.
  const edge = W - w / 2 - 4;
  key(g, "x", f + 10, W / 2); key(g, "x", f + 18, edge, "smooth"); key(g, "x", f + 30, edge); key(g, "x", f + 40, restX, "smooth");
  key(g, "y", f + 18, topArea / 2); key(g, "y", f + 30, restY, "smooth");
  emit("drop", f + 40, { into: t.bin });
});
