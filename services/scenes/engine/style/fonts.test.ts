import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureMany } from "../kits/text-browser.ts";
import { styleNames, themeFrom, themeOf } from "../render/theme.ts";
import { checkFamily, familiesIn, GENERIC, shippedStack } from "./fonts.ts";
import { FONTS_DIR, fontBook, fontFile, readFontBook } from "./shipped.ts";
import { useChrome } from "../../src/chrome.ts";

useChrome(); // the measuring test opens the headless Chrome that renders videos (npm run browser)

const styleFile = (name: string) => JSON.parse(readFileSync(new URL(`../../styles/${name}.json`, import.meta.url), "utf8"));

test("every font in services/scenes/fonts says where it came from, carries its open licence, and has its files", () => {
  const book = readFontBook();
  assert.ok(book.families.length >= 2);
  for (const f of book.families) {
    assert.match(f.licence, /SIL Open Font License|Apache/);
    for (const l of f.licenceFiles) assert.ok(readFileSync(join(FONTS_DIR, f.folder, l), "utf8").length > 500, `${f.family}: ${l}`);
    for (const face of f.faces) assert.ok(existsSync(fontFile(f.folder, face.file)), `${f.family}: ${face.file}`);
  }
  for (const use of ["fallback", "default", "mono"]) assert.ok(book.families.some((f) => f.serves?.includes(use as "fallback")), `a font serves as ${use}`);
});

test("every style's fonts resolve to files in the repo, with the shipped fallbacks behind them", () => {
  const book = fontBook();
  const fallbacks = book.families.filter((f) => f.serves?.includes("fallback")).map((f) => f.family);
  for (const name of styleNames()) {
    const theme = themeFrom(name);
    const stacks = { title: theme.fonts.title, body: theme.fonts.body, mono: theme.fonts.mono! };
    for (const [key, stack] of Object.entries(stacks)) {
      const names = familiesIn(stack);
      const own = names.filter((n) => !GENERIC.has(n));
      assert.ok(own.length > fallbacks.length, `${name} ${key}: ${stack}`);
      for (const n of own) {
        const family = book.families.find((f) => f.family === n);
        assert.ok(family, `${name} ${key}: ${n} ships`);
        for (const face of family!.faces) assert.ok(existsSync(fontFile(family!.folder, face.file)));
      }
      for (const f of fallbacks) assert.ok(own.includes(f), `${name} ${key} falls back on ${f}`);
      assert.ok(GENERIC.has(names.at(-1)!), `${name} ${key} ends in a generic name`);
    }
    for (const [key, n] of Object.entries(styleFile(name).fonts as Record<string, string>)) assert.ok(book.families.some((f) => f.family === n), `${name} fonts.${key}: ${n} ships`);
  }
});

test("a style naming a font that has no file fails, and says what to do", () => {
  const file = styleFile(styleNames()[0]!);
  const render = (type: Record<string, string>) => ({ ...file, render: { ...file.render, type: { ...file.render.type, ...type } } });
  assert.throws(() => themeOf(render({ title: '"Chalkduster", "Comic Sans MS", cursive' })), /type\.title: "Chalkduster" has no font files in services\/scenes\/fonts\. Add a folder/);
  assert.throws(() => themeOf(render({ body: "sans-serif" })), /type\.body: .*names only generic fonts/);
  assert.throws(() => themeOf({ ...file, fonts: { ...file.fonts, caption: "Arial Black" } }), /fonts\.caption: "Arial Black" has no font files/);
  // A style that names no font at all gets the shipped default and code font, never one the computer picks.
  const { render: _, fonts: __, ...bare } = file;
  const plain = themeOf(bare);
  for (const stack of [plain.fonts.title, plain.fonts.body, plain.fonts.mono!]) assert.ok(familiesIn(stack).filter((n) => !GENERIC.has(n)).every((n) => fontBook().families.some((f) => f.family === n)), stack);
});

test("a font folder must be open, complete and say what it is", () => {
  const ok = { family: "Some Face", licence: "SIL Open Font License 1.1", licenceFiles: ["OFL.txt"], source: "where it came from", faces: [{ file: "Some.ttf", weight: 400 }] };
  const all = () => true;
  assert.equal(checkFamily(ok, "some", all).family, "Some Face");
  assert.throws(() => checkFamily({ ...ok, licence: "All rights reserved" }, "some", all), /SIL Open Font License or Apache 2\.0/);
  assert.throws(() => checkFamily(ok, "some", (f) => f !== "Some.ttf"), /Some\.ttf is missing/);
  assert.throws(() => checkFamily(ok, "some", (f) => f !== "OFL.txt"), /licence file OFL\.txt is missing/);
  assert.throws(() => checkFamily({ ...ok, faces: [{ file: "Some.ttf", weight: 1200 }] }, "some", all), /weight/);
  assert.throws(() => checkFamily({ ...ok, family: "serif" }, "some", all), /not a usable family name/);
  assert.throws(() => checkFamily({ ...ok, faces: [{ file: "Some.ttf", weight: 400, sizeAdjust: "3x" }] }, "some", all), /sizeAdjust must be a percentage/);
  // Two folders may not claim one family.
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-fonts-"));
  try {
    for (const folder of ["a", "b"]) {
      mkdirSync(join(dir, folder));
      writeFileSync(join(dir, folder, "font.json"), JSON.stringify(ok));
      writeFileSync(join(dir, folder, "OFL.txt"), "licence");
      writeFileSync(join(dir, folder, "Some.ttf"), "");
    }
    assert.throws(() => readFontBook(dir), /two folders name the family "Some Face"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(shippedStack({ families: [{ ...ok, folder: "some" }] }, "'Some Face', serif", "type.body"), '"Some Face", serif');
});

// The advance of a character as the font file itself says, in ems: cmap (format 4) to glyph, hmtx to advance.
function advances(path: string, chars: string[]): number[] {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < v.getUint16(4); i++) tables.set(b.toString("latin1", 12 + i * 16, 16 + i * 16), v.getUint32(12 + i * 16 + 8));
  const upm = v.getUint16(tables.get("head")! + 18);
  const metrics = v.getUint16(tables.get("hhea")! + 34);
  const cmap = tables.get("cmap")!;
  let sub = -1;
  for (let i = 0; i < v.getUint16(cmap + 2); i++) {
    const at = cmap + v.getUint32(cmap + 8 + i * 8);
    if (v.getUint16(at) === 4) sub = at;
  }
  const n = v.getUint16(sub + 6) / 2;
  const glyph = (code: number) => {
    for (let i = 0; i < n; i++) {
      if (code > v.getUint16(sub + 14 + i * 2)) continue;
      const start = v.getUint16(sub + 16 + n * 2 + i * 2);
      if (code < start) return 0;
      const delta = v.getUint16(sub + 16 + n * 4 + i * 2);
      const offset = v.getUint16(sub + 16 + n * 6 + i * 2);
      if (!offset) return (code + delta) & 0xffff;
      const g = v.getUint16(sub + 16 + n * 6 + i * 2 + offset + (code - start) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const hmtx = tables.get("hmtx")!;
  return chars.map((c) => v.getUint16(hmtx + Math.min(glyph(c.codePointAt(0)!), metrics - 1) * 4) / upm);
}

test("measuring uses the shipped font files, not fonts installed on the computer", () => {
  const chars = ["M", "a", "W", "0", "?"];
  // Each family's single-weight faces: the browser's width for a character is exactly the advance in that file (scaled
  // by the face's sizeAdjust, when it has one).
  const faces = fontBook().families.flatMap((f) => f.faces.filter((face) => typeof face.weight === "number" && !face.unicodeRange).map((face) => ({ f, face })));
  assert.ok(faces.length >= 5);
  assert.ok(faces.some(({ face }) => face.sizeAdjust), "a size-adjusted face is among those checked");
  const measured = measureMany(faces.flatMap(({ f, face }) => chars.map((c) => ({ clusters: [c], font: JSON.stringify(f.family), weight: face.weight as number }))));
  faces.forEach(({ f, face }, i) => {
    const scale = face.sizeAdjust ? parseFloat(face.sizeAdjust) / 100 : 1;
    const want = advances(fontFile(f.folder, face.file), chars).map((a) => a * scale);
    chars.forEach((c, j) => assert.ok(Math.abs(measured[i * chars.length + j]!.edges[0]! - want[j]!) < 1e-3, `${f.family} ${face.weight} "${c}": measured ${measured[i * chars.length + j]!.edges[0]}, file says ${want[j]}`));
  });
});
