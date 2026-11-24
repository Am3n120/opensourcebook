// A conversation in speech bubbles, left and right, each line arriving as it is said, with the speakers named: a
// dialogue in another language, a negotiation, an interview, two sides of an exchange, a scene from a story.
// lines="A: Hello|B: Hi there|A: How are you?"; the first speaker named is on the left.
const raw = items(args.lines).map(String);
const msgs = raw.map((l) => { const k = l.indexOf(":"); return k > 0 && k < 24 ? { who: l.slice(0, k).trim(), say: l.slice(k + 1).trim() } : { who: "", say: l.trim() }; }).slice(0, 8);
const who = [];
for (const m of msgs) if (m.who && !who.includes(m.who)) who.push(m.who);
const U = Math.min(W, H);
const L = clamp(U * 0.08, 44, 100);
const maxW = W * 0.74;
const pad = L * 0.5;
const nameH = L * 0.95;
const blocks = msgs.map((m) => { const lines = wrapText(m.say, L * 0.9, maxW - pad * 2).slice(0, 4); return { ...m, lines, w: Math.max(...lines.map((l) => textWidth(l, L * 0.9))) + pad * 2, h: lines.length * L * 1.1 + pad * 1.4 }; });
const newName = (i) => blocks[i].who && (i === 0 || blocks[i - 1].who !== blocks[i].who);
const total = blocks.reduce((s, b, i) => s + b.h + L * 0.5 + (newName(i) ? nameH : 0), 0);
// When the talk runs longer than the box, the earliest bubbles scroll up out of it, as a chat does.
const at = beats(blocks.length, args.when, blocks.map((b) => b.say));
let y = Math.max(0, (H - total) / 2);
const tops = [];
blocks.forEach((b, i) => {
  if (newName(i)) y += nameH;
  tops.push(y);
  y += b.h + L * 0.5;
});
const over = Math.max(0, total - H);
const all = group("talk", { x: 0, y: 0 });
blocks.forEach((b, i) => {
  const right = who.indexOf(b.who) % 2 === 1;
  const x = right ? W - b.w : 0;
  const top = tops[i];
  const g = group("line" + i, { parent: all, x, y: top });
  if (newName(i)) text("who" + i, { parent: g, x: right ? b.w - pad * 0.4 : pad * 0.4, y: -nameH * 0.5, text: b.who, size: L * 0.75, anchor: right ? "end" : "start", color: right ? "accent" : "ink", weight: 800 });
  // The bubble: a rounded box with a small tail at its lower corner, on the speaker's side.
  const r = Math.min(L * 0.6, b.h / 2);
  const bub = arc(b.w - r, r, r, -Math.PI / 2, 0, 6).concat(arc(b.w - r, b.h - r, r, 0, Math.PI / 2, 6), right ? [b.w + L * 0.35, b.h + L * 0.15, b.w - r * 1.2, b.h] : [r * 1.2, b.h, -L * 0.35, b.h + L * 0.15], arc(r, b.h - r, r, Math.PI / 2, Math.PI, 6), arc(r, r, r, Math.PI, Math.PI * 1.5, 6));
  path("bubble" + i, { parent: g, points: bub, fill: "paper", stroke: right ? "accent" : "ink", strokeWidth: 5, closed: 1 });
  b.lines.forEach((l, k) => text(`say${i}-${k}`, { parent: g, x: pad, y: pad * 0.7 + L * 0.55 + k * L * 1.1, text: l, size: L * 0.9, anchor: "start", color: "ink" }));
  appear(g, at[i], "pop", 12);
});
if (over > 0) {
  // Scroll so the newest bubble is always in view.
  blocks.forEach((b, i) => {
    const bottom = tops[i] + b.h + L * 0.4;
    const shift = Math.max(0, bottom - H);
    key(all, "y", at[i], i ? -Math.max(0, tops[i - 1] + blocks[i - 1].h + L * 0.4 - H) : 0);
    key(all, "y", at[i] + 12, -shift, "smooth");
  });
}
