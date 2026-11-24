/**
 * Builds a piece's scene in some styles and writes stills of it, to look at while making a piece:
 *
 *   node --experimental-strip-types scripts/piece.ts NAME [NAME…] [--styles flat,ink,neon] [--out DIR] [--picture]
 *
 * Each style's build problems and what a viewer would notice are printed, and three stills (how it opens, its middle,
 * how it ends) go to DIR/NAME/STYLE/. `--picture` also writes the piece's shelf picture (`still.jpg`, the end of its
 * scene in the first style) into its folder. `all` builds every shipped piece.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useChrome } from "../src/chrome.ts";
import { buildPieceScene, shippedPieces } from "../src/shelf.ts";

useChrome();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const styles = (flag("--styles") ?? "flat,ink,neon").split(",");
const out = flag("--out") ?? join(tmpdir(), "opensourcebook-pieces");
const picture = args.includes("--picture");
const names = args.filter((a) => !a.startsWith("--"));
const pieces = shippedPieces().filter((p) => names.includes("all") || names.includes(p.name));
if (!pieces.length) throw new Error(`No piece called ${names.join(", ")}. There are: ${shippedPieces().map((p) => p.name).join(", ")}`);

let bad = 0;
for (const p of pieces) {
  const tiles: string[] = [];
  for (const [k, style] of styles.entries()) {
    const folder = join(out, p.name, style);
    mkdirSync(folder, { recursive: true });
    const r = await buildPieceScene(p, style, folder, { stills: true });
    const said = [...r.problems.map((x) => `PROBLEM ${x}`), ...r.serious.map((x) => `NOTICE ${x}`)];
    if (said.length) bad++;
    console.log(`${p.name} in ${style}: ${said.length ? `\n  ${said.join("\n  ")}` : "clean"}${r.stills?.length ? `\n  stills: ${r.stills.join(" ")}` : ""}`);
    if (picture && k === 0 && r.stills?.length) copyFileSync(r.picture!, join(p.folder!, "still.jpg"));
    tiles.push(...(r.stills ?? []).slice(1));
  }
  // One sheet of every style's middle and end, side by side, to look at in one go.
  if (tiles.length) {
    const sheet = join(out, p.name, "sheet.jpg");
    const graph = `${tiles.map((_, i) => `[${i}:v]scale=270:480,pad=276:486:3:3:color=gray[t${i}]`).join(";")};${tiles.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${tiles.length}[out]`;
    execFileSync("ffmpeg", ["-y", "-v", "error", ...tiles.flatMap((t) => ["-i", t]), "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "4", sheet]);
    console.log(`  sheet: ${sheet}`);
  }
}
process.exit(bad ? 1 : 0);
