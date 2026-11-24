// QR codes for the launcher. When Open Sourcebook starts, the launcher shows a QR code so
// a phone on the same network can use Open Sourcebook by pointing its camera at it.
// The encoder is written here rather than pulled in as a dependency: the
// launcher only needs byte mode, level M and versions 1 to 10, which is small.
// It follows ISO/IEC 18004 (QR Code bar code symbology specification).

/** Level M block layout per version: EC codewords per block, then [block count, data codewords per block] groups. */
const LEVEL_M: readonly (readonly [number, readonly (readonly [number, number])[]])[] = [
  [10, [[1, 16]]], // 1
  [16, [[1, 28]]], // 2
  [26, [[1, 44]]], // 3
  [18, [[2, 32]]], // 4
  [24, [[2, 43]]], // 5
  [16, [[4, 27]]], // 6
  [18, [[4, 31]]], // 7
  [22, [[2, 38], [2, 39]]], // 8
  [22, [[3, 36], [2, 37]]], // 9
  [26, [[4, 43], [1, 44]]], // 10
];

/** Alignment pattern centre coordinates per version (version 1 has none). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MAX_VERSION = 10;

// ---- GF(256) arithmetic with the QR field polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0;
}

/** The RS generator polynomial of the given degree, highest power first, leading 1 omitted. */
export function generatorPolynomial(degree: number): number[] {
  // Start from g(x) = 1 and multiply by (x - a^i) for i = 0..degree-1.
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = EXP[i] ?? 0;
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ c;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(c, root);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** Reed-Solomon error-correction codewords for one data block. */
export function reedSolomon(data: readonly number[], ecCount: number): number[] {
  const gen = generatorPolynomial(ecCount);
  const rem = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rem[0] ?? 0);
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecCount; i++) rem[i] = (rem[i] ?? 0) ^ gfMul(gen[i] ?? 0, factor);
  }
  return rem;
}

// ---- Capacity.

function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function layout(version: number): { ec: number; blocks: number[] } {
  const entry = LEVEL_M[version - 1];
  if (!entry) throw new Error(`no layout for version ${version}`);
  const blocks: number[] = [];
  for (const [count, size] of entry[1]) for (let i = 0; i < count; i++) blocks.push(size);
  return { ec: entry[0], blocks };
}

function dataCapacity(version: number): number {
  return layout(version).blocks.reduce((a, b) => a + b, 0);
}

// ---- Bits to codewords.

function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | (bits[i + j] ?? 0);
    words.push(w);
  }
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

function interleave(data: number[], version: number): number[] {
  const { ec, blocks } = layout(version);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const size of blocks) {
    const block = data.slice(at, at + size);
    at += size;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, ec));
  }
  const out: number[] = [];
  const longest = Math.max(...blocks);
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i] ?? 0);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i] ?? 0);
  return out;
}

// ---- Matrix.

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] };

function newGrid(size: number): Grid {
  const make = (): boolean[][] => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, dark: make(), fixed: make() };
}

function setFixed(g: Grid, x: number, y: number, dark: boolean): void {
  const row = g.dark[y];
  const fixedRow = g.fixed[y];
  if (!row || !fixedRow || x < 0 || x >= g.size) return;
  row[x] = dark;
  fixedRow[x] = true;
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  // Timing patterns.
  for (let i = 0; i < n; i++) {
    setFixed(g, 6, i, i % 2 === 0);
    setFixed(g, i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) setFixed(g, x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Alignment patterns, skipping the three that would overlap finders.
  const pos = ALIGNMENT[version - 1] ?? [];
  const last = pos.length - 1;
  pos.forEach((cy, i) => {
    pos.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFixed(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  // Reserve format areas (written for real per mask) and version info.
  drawFormat(g, 0);
  drawVersion(g, version);
}

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, mask: number): void {
  const n = g.size;
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) setFixed(g, 8, i, bit(i));
  setFixed(g, 8, 7, bit(6));
  setFixed(g, 8, 8, bit(7));
  setFixed(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFixed(g, 14 - i, 8, bit(i));
  // Second copy, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) setFixed(g, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFixed(g, 8, n - 15 + i, bit(i));
  setFixed(g, 8, n - 8, true); // the dark module
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFixed(g, a, b, dark);
    setFixed(g, b, a, dark);
  }
}

function placeData(g: Grid, codewords: number[]): void {
  const n = g.size;
  const total = codewords.length * 8;
  let i = 0;
  // Two-column strips from the right edge, zigzagging up and down, skipping the vertical timing column.
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (g.fixed[y]?.[x]) continue;
        const row = g.dark[y];
        if (!row) continue;
        // Past the last codeword the remainder bits stay light (0).
        row[x] = i < total && (((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const test = MASKS[mask];
  if (!test) return;
  for (let y = 0; y < g.size; y++) {
    const row = g.dark[y];
    const fixedRow = g.fixed[y];
    if (!row || !fixedRow) continue;
    for (let x = 0; x < g.size; x++) if (!fixedRow[x] && test(x, y)) row[x] = !row[x];
  }
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

/** The four penalty rules of ISO/IEC 18004 section 7.8.3. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  const at = (x: number, y: number): boolean => m[y]?.[x] === true;
  let score = 0;
  for (const horizontal of [true, false]) {
    for (let a = 0; a < n; a++) {
      const get = (b: number): boolean => (horizontal ? at(b, a) : at(a, b));
      // Rule 1: runs of five or more of one colour.
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(b) === get(b - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
      // Rule 3: 1:1:3:1:1 finder-like pattern with four light modules on one side.
      for (let b = 0; b + 11 <= n; b++) {
        for (const pattern of FINDER_LIKE) if (pattern.every((v, k) => get(b + k) === v)) score += 40;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = at(x, y);
      if (at(x + 1, y) === c && at(x, y + 1) === c && at(x + 1, y + 1) === c) score += 3;
    }
  }
  // Rule 4: balance of dark and light.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Encodes text (as UTF-8 bytes) into a QR matrix, level M, true = dark, without the quiet zone. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  // Mode (4 bits) + count (8 or 16 bits) + data must fit the data codewords.
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > MAX_VERSION) throw new Error(`${bytes.length} bytes of text is too long for a QR code`);

  const codewords = interleave(dataCodewords(bytes, version), version);
  const size = version * 4 + 17;
  if (codewords.length * 8 > rawDataModules(version)) throw new Error(`version ${version} layout does not fit`);

  const base = newGrid(size);
  drawFunctionPatterns(base, version);
  placeData(base, codewords);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g: Grid = { size, dark: base.dark.map((r) => [...r]), fixed: base.fixed.map((r) => [...r]) };
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g.dark);
    if (score < bestScore) {
      bestScore = score;
      best = g.dark;
    }
  }
  if (!best) throw new Error("no mask chosen");
  return best;
}

const QUIET = 4;

/**
 * Lines to print a QR matrix in a terminal, two module rows per line, with a 4-module quiet zone.
 * With ansi, each line is drawn black on white whatever the terminal theme, and the glyphs are the dark modules.
 * Without ansi the glyphs are the LIGHT modules: the terminal's own (usually dark) background shows through as
 * the dark modules, so the code reads right on a dark terminal.
 */
export function terminalQr(matrix: boolean[][], ansi: boolean): string[] {
  const n = matrix.length;
  const full = n + QUIET * 2;
  // drawn(x, y): whether the glyph covers this module. Outside the padded area nothing is drawn.
  const drawn = (x: number, y: number): boolean => {
    if (y >= full) return false;
    const dark = matrix[y - QUIET]?.[x - QUIET] === true;
    return ansi ? dark : !dark;
  };
  const lines: string[] = [];
  for (let y = 0; y < full; y += 2) {
    let line = "";
    for (let x = 0; x < full; x++) {
      const top = drawn(x, y);
      const bottom = drawn(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(ansi ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines;
}

/** A standalone SVG of the matrix with a 4-module quiet zone, one unit per module. */
export function svgQr(matrix: boolean[][]): string {
  const n = matrix.length;
  const full = n + QUIET * 2;
  let d = "";
  matrix.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (!row[x]) continue;
      let end = x;
      while (row[end + 1]) end++;
      d += `M${x + QUIET} ${y + QUIET}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
