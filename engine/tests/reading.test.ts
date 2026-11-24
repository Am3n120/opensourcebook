/**
 * Reading a long source: parts, the map, an even spread and named ranges
 * (src/sources/reading.ts), over a long source made in the test.
 */
import { describe, expect, it } from "vitest";
import { buildPassages } from "../src/sources/passages";
import { charsOf, isLong, labelRanges, partsOf, passagesNamed, renderMap, spread, spreadNote, WHOLE_READ_CHARS } from "../src/sources/reading";
import { factOf, longNodeSource } from "./support/long-source";

const book = buildPassages([longNodeSource({ chars: 400_000 })]);

describe("parts", () => {
  it("covers every passage once, in order, in runs near the part size", () => {
    const parts = partsOf(book, 8_000);
    expect(parts.flatMap((part) => part.passages)).toEqual(book);
    for (const part of parts.slice(0, -1)) expect(part.chars).toBeLessThanOrEqual(8_000);
    expect(parts.length).toBeGreaterThan(40);
  });

  it("closes at a page turn near the size and says which pages a part holds", () => {
    const paged = buildPassages([longNodeSource({ chars: 60_000, pages: true, partChars: 3_000 })]);
    const parts = partsOf(paged, 8_000);
    for (const part of parts) {
      expect(part.pages).toBeDefined();
      const last = part.passages[part.passages.length - 1];
      const next = paged[paged.indexOf(last) + 1];
      // A part ends where its last page ends, not inside a page.
      if (next) expect(next.locator?.page).not.toBe(last.locator?.page);
    }
  });

  it("never runs across two sources", () => {
    const two = buildPassages([longNodeSource({ chars: 10_000, sourceId: "a", title: "A" }), longNodeSource({ chars: 10_000, sourceId: "b", title: "B" })]);
    for (const part of partsOf(two, 50_000)) expect(new Set(part.passages.map((passage) => passage.sourceId)).size).toBe(1);
  });
});

describe("map", () => {
  it("names every passage in a range, stays near its budget, and previews the end as well as the start", () => {
    const map = renderMap(book, 12_000);
    expect(map.length).toBeLessThan(14_000);
    expect(map).toContain("P1–");
    expect(map).toContain(`${book[book.length - 1].label} (`);
    const ranges = [...map.matchAll(/^- (P\d+)(?:–(P\d+))? /gm)].map((match) => [match[1], match[2] ?? match[1]]);
    const covered = ranges.flatMap(([from, to]) => passagesNamed(`${from}-${to}`, book) ?? []);
    expect(covered).toEqual(book);
  });

  it("shows pages when the passages have them", () => {
    const paged = buildPassages([longNodeSource({ chars: 40_000, pages: true, partChars: 3_000 })]);
    expect(renderMap(paged)).toMatch(/pages \d+–\d+/);
  });
});

describe("spread", () => {
  it("keeps everything that fits", () => {
    const short = book.slice(0, 5);
    expect(spread(short, 100_000)).toEqual(short);
  });

  it("takes passages evenly across the whole source within the budget", () => {
    const shown = spread(book, 40_000);
    expect(charsOf(shown)).toBeLessThanOrEqual(40_000);
    expect(shown[0]).toBe(book[0]);
    expect(shown[shown.length - 1]).toBe(book[book.length - 1]);
    // Every tenth of the source is read.
    const tenths = new Set(shown.map((passage) => Math.floor((book.indexOf(passage) / book.length) * 10)));
    expect(tenths.size).toBe(10);
    expect(spreadNote(shown, book)).toContain(`across the ${book.length} this covers`);
    expect(spreadNote(book, book)).toBe("");
  });
});

describe("named ranges", () => {
  it("reads P-ranges, bare numbers, dashes and lists", () => {
    expect(passagesNamed("P3-P5", book)?.map((passage) => passage.label)).toEqual(["P3", "P4", "P5"]);
    expect(passagesNamed("3–4", book)?.map((passage) => passage.label)).toEqual(["P3", "P4"]);
    expect(passagesNamed(["P9", "P1-P2"], book)?.map((passage) => passage.label)).toEqual(["P1", "P2", "P9"]);
    expect(passagesNamed("P99999", book)).toBeUndefined();
    expect(passagesNamed(undefined, book)).toBeUndefined();
    expect(labelRanges([book[0], book[1], book[2], book[7]], book)).toBe("P1–P3, P8");
  });

  it("finds the late fact in the late passages", () => {
    const late = book.filter((passage) => passage.text.includes(factOf(95)));
    expect(late).toHaveLength(1);
    expect(book.indexOf(late[0])).toBeGreaterThan(book.length * 0.9);
    expect(isLong(book)).toBe(true);
    expect(isLong(book.slice(0, 3), WHOLE_READ_CHARS)).toBe(false);
  });
});
