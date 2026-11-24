/**
 * The shelf of pieces: it is read from its folders, every shipped piece's scene builds in every style with nothing a
 * viewer would notice that the engine can measure, the search finds pieces by plain words and notes what it could not
 * find, and a piece the agent saves lands on the person's own shelf and is found by the next search.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadShelf, PIECES, readPiece } from "../engine/language/library.ts";
import { closeRenderer } from "../pipeline/stages/scene.ts";
import { useChrome } from "../src/chrome.ts";
import { languageGuide } from "../src/prompt.ts";
import { loadImage } from "@napi-rs/canvas";
import { buildPieceScene, matchPieces, pieceExample, savePiece, search, SHEET, shelfSheet, shippedPieces, wantedLog } from "../src/shelf.ts";
import { findPiece } from "../src/shelf-tools.ts";
import { listStyles } from "../src/styles.ts";
import type { ToolContext } from "../src/tools.ts";

useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-shelf-"));
const saved = join(folder, "data", "pieces");
process.env.SCENES_SAVED_PIECES = saved;
after(async () => {
  await closeRenderer();
  rmSync(folder, { recursive: true, force: true });
});

const pieceFiles = (dir: string, about = "A row of dots that light up one after another.") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "piece.json"), JSON.stringify({ about, tags: ["dots"], params: { n: { default: "3", about: "how many" } } }));
  writeFileSync(join(dir, "piece.js"), 'for (let i = 0; i < args.n; i++) appear(path("d" + i, { points: circle(W * (i + 0.5) / args.n, H / 2, 20), fill: "ink" }), T0 + i * 10);\n');
};

test("the shelf is read from its folders: a new folder is a new piece, and a broken one fails with what is wrong", () => {
  const shelf = join(folder, "shelf");
  pieceFiles(join(shelf, "dot-row"));
  assert.deepEqual(loadShelf(shelf, null).pieces.map((p) => [p.name, p.params.n, p.about?.n, p.origin]), [["dot-row", "3", "how many", "shipped"]]);
  pieceFiles(join(shelf, "dot-row-two"));
  assert.equal(loadShelf(shelf, null).pieces.length, 2);
  mkdirSync(join(shelf, "broken"));
  writeFileSync(join(shelf, "broken", "piece.json"), "{ not json");
  assert.throws(() => loadShelf(shelf, null), /The piece broken .*has no piece\.js/);
  writeFileSync(join(shelf, "broken", "piece.js"), "");
  assert.throws(() => loadShelf(shelf, null), /The piece broken .*piece\.json is not valid JSON/);
  rmSync(join(shelf, "broken"), { recursive: true });
  pieceFiles(join(shelf, "no-line"), "short");
  assert.throws(() => readPiece(join(shelf, "no-line")), /needs "about", a line on what it is/);
});

const pieces = shippedPieces();

test("every shipped piece has its line, tags, settings explained, a built scene and a picture, and the language guide lists it", () => {
  assert.ok(pieces.length >= 40, `${pieces.length} pieces`);
  const guide = languageGuide({ title: "t", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, style: "flat", passages: [], limits: {} } as never, "flat");
  for (const p of pieces) {
    assert.ok((p.tags ?? []).length >= 3, `${p.name}: tags`);
    for (const k of Object.keys(p.params)) assert.ok(p.about?.[k], `${p.name}: what ${k} means`);
    const e = pieceExample(p);
    assert.match(e.source, new RegExp(`run ${p.name} `), `${p.name}: its scene runs it`);
    assert.ok(existsSync(join(PIECES, p.name, "still.jpg")), `${p.name}: still.jpg`);
    assert.ok(guide.includes(`\`${p.name}\``), `${p.name} in the guide`);
  }
});

// What the engine can measure that a viewer would notice: words cut, on words, too small, an empty opening.
const MEASURED = /^(Words cut by the frame edge|Writing on top of writing|Words too small|Small words|Opens empty)/;
for (const p of pieces) {
  test(`${p.name} builds in every style with nothing measured a viewer would notice`, async () => {
    for (const s of listStyles()) {
      const r = await buildPieceScene(p, s.id, join(folder, "build", p.name, s.id));
      assert.deepEqual(r.problems, [], `${p.name} in ${s.id}:\n${r.problems.join("\n")}`);
      // Only what the piece draws: words the scene writes itself (its title) are the language's to lay out.
      const own = [...pieceExample(p).source.matchAll(/^\s*text \S+ "([^"]+)"/gm)].map((m) => m[1]!.toLowerCase());
      const about = (x: string) => [...x.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
      const seen = r.serious.filter((x) => MEASURED.test(x) && !about(x).every((w) => own.some((o) => o.includes(w))));
      assert.deepEqual(seen, [], `${p.name} in ${s.id}:\n${seen.join("\n")}`);
    }
  });
}

test("the search finds pieces by what is to be shown, and notes a search that found nothing", async () => {
  const names = (q: string) => search(q).map((f) => f.piece.name);
  assert.ok(names("compare amounts side by side").includes("bars"), names("compare amounts side by side").join(","));
  // Plain words about a process find a piece that draws one, whatever the subject.
  const wants: [string, string][] = [["steps in order", "journey"], ["something goes through stages", "journey"], ["a process with a choice", "flow"], ["a thing that changes at each step", "transform"], ["repeat until it works", "loop-until"], ["two paths that join", "two-tracks"]];
  for (const [q, p] of wants) assert.ok(names(q).slice(0, 3).includes(p), `${q}: ${names(q).join(",")}`);
  const ctx = { draft: { scenes: {} }, folder } as unknown as ToolContext;
  const miss = await findPiece.run({ want: "a xylophone glissando" }, ctx);
  assert.match(miss.text, /Nothing on the shelf fits "a xylophone glissando"/);
  const log = readFileSync(wantedLog(saved), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { wanted: string });
  assert.equal(log.at(-1)!.wanted, "a xylophone glissando");
  const hit = await findPiece.run({ want: "compare amounts" }, ctx);
  assert.match(hit.text, /bars \(shipped with Open Sourcebook\)/);
  assert.ok((hit.images ?? []).length >= 1, "a picture of each");
  const one = await findPiece.run({ name: "bars" }, ctx);
  assert.match(one.text, /program my-bars /);
  const all = await findPiece.run({}, ctx);
  assert.ok(all.text.split("\n").length > pieces.length, "every piece by name");
  assert.equal(all.images?.length, 1, "and one picture of the whole shelf");

  const hitsFor = (q: string) => matchPieces(q, pieces, 3).map((f) => f.piece.name);
  assert.ok(hitsFor("A sequence of stages showing a bill moving from committee to floor vote to president").includes("journey"));
  assert.ok(hitsFor("Two tracks running in parallel through House and Senate before merging").includes("two-tracks"));
  assert.ok(hitsFor("Compare mitosis and meiosis side by side").includes("two-sides"));
  assert.ok(hitsFor("A balance tipping between effort and load").includes("balance"));
  for (const vague of [
    "A poem about grief and time",
    "How vaccines train the immune system to recognize a pathogen",
    "A box with the word Democracy in the middle",
    "a xylophone glissando",
  ]) {
    assert.deepEqual(matchPieces(vague, pieces, 3), [], `should not force noisy matches for: ${vague}`);
  }
});

test("the sheet of the shelf is one picture of every piece, its name under it, in the shelf's order", async () => {
  const file = await shelfSheet(pieces, join(folder, "sheet", "sheet.jpg"));
  assert.ok(file && existsSync(file));
  const img = await loadImage(readFileSync(file));
  const rows = Math.ceil(pieces.length / SHEET.cols);
  assert.equal(img.width, SHEET.cols * (SHEET.tile + SHEET.gap) + SHEET.gap);
  assert.equal(img.height, rows * (Math.round((SHEET.tile * 16) / 9) + SHEET.label + SHEET.gap) + SHEET.gap);
  assert.equal(await shelfSheet([], join(folder, "sheet", "none.jpg")), undefined, "nothing for an empty shelf");
});

test("a saved piece lands on the person's shelf and the next search finds it; baked-in words are described, not refused", async () => {
  const general = { params: { labels: "Seed|Sprout|Tree", n: "3" }, source: 'const l = items(args.labels);\nfor (let i = 0; i < l.length; i++) appear(text("t" + i, { x: W / 2, y: H * (i + 0.5) / l.length, text: String(l[i]), size: 60, color: "ink" }), T0 + i * 12);\n' };
  const r = await savePiece({ name: "stacked-words", about: "Words stacked down the box, each arriving in turn, for stages named one by one.", tags: ["stages", "list"], params: { labels: "the words, split by |", n: "how many" }, program: general, style: "flat" }, folder, saved);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /reads as general/);
  assert.ok(existsSync(join(saved, "stacked-words", "still.jpg")));
  const found = search("words stacked down the box");
  const mine = found.find((f) => f.piece.name === "stacked-words");
  assert.ok(mine, found.map((f) => f.piece.name).join(", "));
  assert.equal(mine.piece.origin, "saved");
  assert.ok(found.some((f) => f.piece.origin === "shipped") || found.length === 1, "shipped and saved are searched together");
  const baked = { params: {}, source: 'text("a", { x: W / 2, y: H / 2, text: "The Battle of Hastings", size: 60, color: "ink" });\npath("b", { points: [0, 0, 10, 10, 20, 5, 30, 30, 40, 2], stroke: "ink" });\n' };
  const b = await savePiece({ name: "one-title", about: "A title written across the middle of the box.", program: baked, style: "flat" }, folder, saved);
  assert.ok(b.ok, b.text);
  assert.match(b.text, /writes these words itself: "The Battle of Hastings"/);
  assert.match(b.text, /no settings/);
  assert.match(readFileSync(join(saved, "one-title", "piece.json"), "utf8"), /"notes"/);
  const taken = await savePiece({ name: "bars", about: "A bar chart of my own making here.", program: general, style: "flat" }, folder, saved);
  assert.equal(taken.ok, false);
  assert.match(taken.text, /shipped piece's name/);
});
