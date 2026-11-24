const total = clamp(Math.round(Number(args.total) || 100), 1, 400);
const counts = items(args.count).map(Number).filter((v) => v >= 0);
const names = items(args.names).map(String);
const shape = String(args.shape || "square");
const U = Math.min(W, H);
const L = clamp(U * 0.08, 40, 96);
const legend = names.length ? (names.length + (Number(args.restName ? 1 : 0))) * L * 1.4 + L * 0.5 : 0;
const room = H - legend;
// The grid: as many columns as keep each unit near square in the room it has.
let cols = Math.max(1, Math.round(Math.sqrt((total * W) / room)));
while (cols < total && Math.ceil(total / cols) * (W / cols) > room) cols++;
const rows = Math.ceil(total / cols);
const cell = Math.min(W / cols, room / rows);
const ox = (W - cell * cols) / 2;
const s = cell * 0.4;
const person = [0, -s * 0.95, s * 0.32, -s * 0.62, 0, -s * 0.3, -s * 0.32, -s * 0.62, 0, -s * 0.95];
const body = [-s * 0.55, s, -s * 0.55, s * 0.05, -s * 0.3, -s * 0.2, s * 0.3, -s * 0.2, s * 0.55, s * 0.05, s * 0.55, s, -s * 0.55, s];
const fills = ["accent", "highlight", "ink"];
const at = beats(counts.length, args.when, names);
// Which group each unit falls in, in reading order, the first group first.
const owner = [];
counts.forEach((c, g) => { for (let k = 0; k < c && owner.length < total; k++) owner.push(g); });
for (let i = 0; i < total; i++) {
  const x = ox + (i % cols) * cell + cell / 2;
  const y = Math.floor(i / cols) * cell + cell / 2;
  const g = owner[i];
  const pts = shape === "dot" ? circle(0, 0, s * 0.9, 20) : shape === "person" ? person : rect(-s, -s, s * 2, s * 2);
  const u = path("u" + i, { x, y, points: pts, fill: "paper", stroke: "ink", strokeWidth: Math.max(2, cell * 0.04), closed: 1, smooth: shape === "person" ? 1 : 0 });
  if (shape === "person") path("b" + i, { x, y, points: body, fill: "paper", stroke: "ink", strokeWidth: Math.max(2, cell * 0.04), closed: 1 });
  if (g !== undefined) {
    // A group's units color in one after another, fast, from the moment it is named.
    const f = at[g] + Math.round((owner.slice(0, i).filter((x) => x === g).length / Math.max(1, counts[g])) * Math.min(30, counts[g] * 1.5));
    key(u, "fill", T0, "paper");
    key(u, "fill", f, fills[g % fills.length], "step");
    if (shape === "person") { key("b" + i, "fill", T0, "paper"); key("b" + i, "fill", f, fills[g % fills.length], "step"); }
  }
}
names.forEach((nm, g) => {
  const ly = rows * cell + L * 0.9 + g * L * 1.4;
  appear(path("key" + g, { x: L * 0.3, y: ly - L * 0.38, points: rect(0, 0, L * 0.76, L * 0.76), fill: fills[g % fills.length], stroke: "ink", strokeWidth: 3, closed: 1 }), at[g]);
  const label = `${counts[g] ?? ""} ${nm}`.trim();
  appear(text("name" + g, { x: L * 1.4, y: ly, text: label, size: fitSize(label, L, W - L * 1.6), anchor: "start", color: "ink" }), at[g] + 4);
});
if (args.restName) {
  const g = names.length;
  const ly = rows * cell + L * 0.9 + g * L * 1.4;
  const rest = total - counts.reduce((a, b) => a + b, 0);
  path("keyrest", { x: L * 0.3, y: ly - L * 0.38, points: rect(0, 0, L * 0.76, L * 0.76), fill: "paper", stroke: "ink", strokeWidth: 3, closed: 1 });
  const label = `${rest} ${args.restName}`;
  text("rest", { x: L * 1.4, y: ly, text: label, size: fitSize(label, L, W - L * 1.6), anchor: "start", color: "ink" });
}
