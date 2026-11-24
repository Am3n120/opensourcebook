import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQr, generatorPolynomial, reedSolomon, svgQr, terminalQr } from "../qr.ts";

const URL = "http://192.168.100.200:65000/pair#AbCdEfGhIjKlMnOpQrStUv";

// The worked example of ISO/IEC 18004 Annex I / the usual tutorials: "HELLO WORLD" at 1-M has these
// 16 data codewords, and these 10 error-correction codewords.
const HELLO_DATA = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const HELLO_EC = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];

test("Reed-Solomon codewords match the published 1-M HELLO WORLD example", () => {
  assert.deepEqual(reedSolomon(HELLO_DATA, 10), HELLO_EC);
});

test("the degree 7 generator polynomial matches the spec's table", () => {
  // g(x) = x^7 + a^87 x^6 + a^229 x^5 + a^146 x^4 + a^149 x^3 + a^238 x^2 + a^102 x + a^21, as plain bytes.
  assert.deepEqual(generatorPolynomial(7), [127, 122, 154, 164, 11, 68, 117]);
});

test("the size grows with the text: 21 for short, larger for longer, the pairing URL fits", () => {
  assert.equal(encodeQr("hello").length, 21);
  assert.equal(encodeQr("x".repeat(14)).length, 21); // 14 bytes is the 1-M byte-mode limit
  assert.equal(encodeQr("x".repeat(15)).length, 25);
  const url = encodeQr(URL);
  assert.ok(url.length >= 25, `URL symbol is ${url.length}`);
  assert.equal(url.length, 33); // 56 bytes needs version 4 at level M
  assert.equal(encodeQr("x".repeat(213)).length, 57); // version 10 limit
  for (const m of [encodeQr("hello"), url]) for (const row of m) assert.equal(row.length, m.length);
});

test("text beyond version 10 is a plain error", () => {
  assert.throws(() => encodeQr("x".repeat(214)), /too long for a QR code/);
});

function hasFinder(m: boolean[][], left: number, top: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[top + dy]?.[left + dx] !== (d !== 2)) return false;
    }
  }
  return true;
}

test("finder patterns sit in three corners and the fourth is not one", () => {
  for (const text of ["hi", URL, "y".repeat(150)]) {
    const m = encodeQr(text);
    const n = m.length;
    assert.ok(hasFinder(m, 0, 0), "top left");
    assert.ok(hasFinder(m, n - 7, 0), "top right");
    assert.ok(hasFinder(m, 0, n - 7), "bottom left");
    assert.ok(!hasFinder(m, n - 7, n - 7), "bottom right");
    assert.equal(m[n - 8]?.[8], true, "dark module");
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6]?.[i], i % 2 === 0, "horizontal timing");
      assert.equal(m[i]?.[6], i % 2 === 0, "vertical timing");
    }
  }
});

function readFormat(m: boolean[][]): [number, number] {
  const n = m.length;
  const at = (x: number, y: number): number => (m[y]?.[x] ? 1 : 0);
  let a = 0;
  let b = 0;
  const first: [number, number][] = [];
  for (let i = 0; i <= 5; i++) first.push([8, i]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) first.push([14 - i, 8]);
  const second: [number, number][] = [];
  for (let i = 0; i < 8; i++) second.push([n - 1 - i, 8]);
  for (let i = 8; i < 15; i++) second.push([8, n - 15 + i]);
  first.forEach(([x, y], i) => (a |= at(x, y) << i));
  second.forEach(([x, y], i) => (b |= at(x, y) << i));
  return [a, b];
}

test("format information is the same in both copies, says level M, and is a valid BCH word", () => {
  for (const text of ["hello", URL, "z".repeat(100)]) {
    const [a, b] = readFormat(encodeQr(text));
    assert.equal(a, b);
    const raw = a ^ 0x5412;
    assert.equal(raw >>> 13, 0b00, "level M");
    let rem = raw >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(raw & 0x3ff, rem & 0x3ff);
  }
});

test("version information appears for version 7 and up, in both copies", () => {
  const m = encodeQr("v".repeat(120)); // 120 bytes needs version 7 at level M
  assert.equal(m.length, 45);
  const n = m.length;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i++) {
    const x = n - 11 + (i % 3);
    const y = Math.floor(i / 3);
    a |= (m[y]?.[x] ? 1 : 0) << i;
    b |= (m[x]?.[y] ? 1 : 0) << i;
  }
  assert.equal(a, b);
  assert.equal(a, 0x07c94); // the spec's table value for version 7
});

test("terminal output: a 4-module quiet zone, two rows per line", () => {
  const m = encodeQr("hello");
  const plain = terminalQr(m, false);
  assert.equal(plain.length, Math.ceil((21 + 8) / 2));
  for (const line of plain) assert.equal([...line].length, 29);
  // Without colour the light modules are drawn, so the quiet zone is solid.
  assert.equal(plain[0], "█".repeat(29));
  const ansi = terminalQr(m, true);
  assert.equal(ansi.length, plain.length);
  for (const line of ansi) {
    assert.ok(line.startsWith("\x1b[30;107m") && line.endsWith("\x1b[0m"));
    assert.equal([...line.slice(9, -4)].length, 29);
  }
  assert.equal(ansi[0], `\x1b[30;107m${" ".repeat(29)}\x1b[0m`);
});

test("SVG output has the quiet zone in its viewBox, a white background and one path", () => {
  const svg = svgQr(encodeQr("hello"));
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
  assert.equal(svg.match(/<path /g)?.length, 1);
  assert.match(svg, /shape-rendering="crispEdges"/);
});
