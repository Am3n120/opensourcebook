/**
 * Makes the map piece's outlines and cities (`pieces/map/data.json`) from Natural Earth, which is public domain:
 *
 *   node --experimental-strip-types scripts/map-data.ts COUNTRIES.geojson PLACES.geojson
 *
 * COUNTRIES is Natural Earth's 1:50m admin 0 countries and PLACES its 1:50m populated places (simple), both as GeoJSON
 * (github.com/nvkelso/natural-earth-vector, `geojson/`). Each country keeps its outer rings, thinned to what a frame can
 * show (a point is kept when it bends the line by more than 0.04 degrees) and stored as whole hundredths of a degree,
 * each point as the step from the one before. Lakes inside a country are not kept. `pieces/map/DATA.md` says the source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Ring = [number, number][];
const [countriesFile, placesFile] = process.argv.slice(2);
if (!countriesFile || !placesFile) throw new Error("Give the countries and the populated places GeoJSON files.");
const TOLERANCE = 0.04;
const Q = 100;

// Douglas and Peucker's thinning: keep the point furthest from the line between two kept ones while it is far enough.
function thin(pts: Ring, eps: number): Ring {
  if (pts.length < 3) return pts;
  const keep = pts.map(() => false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let best = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]!;
      const d = len === 0 ? Math.hypot(x - ax, y - ay) : Math.abs(dy * x - dx * y + bx * ay - by * ax) / len;
      if (d > best) [best, at] = [d, i];
    }
    if (best > eps) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (r: Ring) => Math.abs(r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1]![1] - r[i + 1]![0] * p[1], 0)) / 2;

const NAMES = ["NAME", "NAME_EN", "NAME_LONG", "ADMIN", "BRK_NAME", "FORMAL_EN", "NAME_ALT", "ISO_A3", "ADM0_A3"];
type Feature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const countries = (JSON.parse(readFileSync(countriesFile, "utf8")).features as Feature[]).map((f) => {
  const p = f.properties;
  const polys = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]) as Ring[][];
  const rings = polys.map((poly) => poly[0]!);
  const biggest = Math.max(...rings.map(area));
  const encoded: number[][] = [];
  for (const r of rings) {
    if (area(r) < 0.02 * TOLERANCE && area(r) < biggest) continue;
    const q: [number, number][] = [];
    for (const [x, y] of thin(r, TOLERANCE)) {
      const pt: [number, number] = [Math.round(x * Q), Math.round(y * Q)];
      const last = q[q.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) q.push(pt);
    }
    if (q.length < 4 && area(r) < biggest) continue;
    const flat: number[] = [];
    let [px, py] = [0, 0];
    for (const [x, y] of q) {
      flat.push(x - px, y - py);
      [px, py] = [x, y];
    }
    encoded.push(flat);
  }
  const names = [...new Set(NAMES.map((k) => p[k]).filter((v): v is string => typeof v === "string" && v !== "" && v !== "-99"))];
  return { n: names, c: p.CONTINENT, r: p.SUBREGION, l: [Math.round(Number(p.LABEL_X) * Q), Math.round(Number(p.LABEL_Y) * Q)], p: encoded };
});
const places = (JSON.parse(readFileSync(placesFile, "utf8")).features as Feature[]).map((f) => {
  const p = f.properties;
  return [p.name, Math.round(Number(p.longitude) * Q), Math.round(Number(p.latitude) * Q), p.scalerank, p.adm0name, ...(p.nameascii !== p.name ? [p.nameascii] : [])];
});
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "pieces", "map", "data.json");
writeFileSync(out, JSON.stringify({ scale: Q, countries, places }));
console.log(`${countries.length} countries, ${places.length} places: ${out}`);
