import { describe, expect, it, test } from "vitest";
import { fitMap, layoutMindMap, linksOf, nameBox } from "./mindMap";

const ids = (...names: string[]) => names.map((id) => ({ id }));
/** How far out a spot sits, as a share of the outermost ring (an ellipse, wider than tall). */
const ring = (spot: { x: number; y: number }) => Math.hypot((spot.x - 50) / 41, (spot.y - 50) / 40);

describe("laying out a mind map", () => {
  it("puts the first idea in the middle and the ideas linked to it on one ring, the first at the top", () => {
    const placed = layoutMindMap(ids("c", "a", "b", "d", "e"), [
      { from: "c", to: "a" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "c", to: "e" },
    ]);
    expect(placed[0]).toEqual({ id: "c", x: 50, y: 50, depth: 0 });
    for (const spot of placed.slice(1)) {
      expect(spot.depth).toBe(1);
      expect(ring(spot)).toBeCloseTo(1, 2);
    }
    // Four round the centre, a quarter turn apart, clockwise from the top right.
    expect(placed.slice(1).map(({ x, y }) => [Math.sign(x - 50), Math.sign(y - 50)])).toEqual([
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]);
  });

  it("puts the ideas hanging from another further out, inside that one's slice", () => {
    const placed = layoutMindMap(ids("c", "left", "right", "r1", "r2"), [
      { from: "c", to: "left" },
      { from: "c", to: "right" },
      { from: "right", to: "r1" },
      { from: "r2", to: "right" },
    ]);
    const at = new Map(placed.map((spot) => [spot.id, spot]));
    expect(at.get("r1")!.depth).toBe(2);
    expect(ring(at.get("r1")!)).toBeCloseTo(1, 2);
    // The first ring sits a little over half way out, so its names clear the centre's.
    expect(ring(at.get("right")!)).toBeCloseTo(0.55, 2);
    // Ideas hanging from "right" sit nearer it than the idea on the other side.
    const apart = (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
    for (const kid of ["r1", "r2"]) expect(apart(kid, "right")).toBeLessThan(apart(kid, "left"));
    expect(apart("r1", "r2")).toBeGreaterThan(10);
  });

  it("sets one or two ideas beside the centre rather than above it, and still places an idea no link reaches", () => {
    expect(layoutMindMap(ids("c", "a"), [{ from: "a", to: "c" }])).toEqual([
      { id: "c", x: 50, y: 50, depth: 0 },
      { id: "a", x: 91, y: 50, depth: 1 },
    ]);
    const placed = layoutMindMap(ids("c", "a", "lost"), [{ from: "c", to: "a" }]);
    expect(placed.map((spot) => spot.depth)).toEqual([0, 1, 1]);
    expect(placed[1]!.x).toBeGreaterThan(50);
    expect(placed[2]!.x).toBeLessThan(50);
  });

  it("places nothing for an empty map, and every idea once for a link written both ways", () => {
    expect(layoutMindMap([], [])).toEqual([]);
    const placed = layoutMindMap(ids("c", "a"), [
      { from: "c", to: "a" },
      { from: "a", to: "c" },
    ]);
    expect(placed.map((spot) => spot.id)).toEqual(["c", "a"]);
  });
});

describe("the links of one idea", () => {
  it("reads each from that idea's side", () => {
    const links = [
      { from: "sun", to: "p", text: "powers" },
      { from: "p", to: "o2", text: "gives off" },
      { from: "x", to: "y", text: "unrelated" },
    ];
    expect(linksOf("p", links)).toEqual([
      { link: links[0], other: "sun", outgoing: false },
      { link: links[1], other: "o2", outgoing: true },
    ]);
  });
});

describe("names on the map", () => {
  it("never cover each other, and stay inside the box", () => {
    const nodes = [
      ["p", "Photosynthesis"],
      ["light", "Light reactions"],
      ["calvin", "Calvin cycle"],
      ["chl", "Chlorophyll"],
      ["o2", "Oxygen"],
      ["atp", "ATP and NADPH"],
      ["co2", "Carbon dioxide"],
      ["rubisco", "RuBisCO"],
      ["glucose", "Glucose"],
      ["stomata", "Stomata"],
    ].map(([id, text]) => ({ id: id!, text: text! }));
    const links = [
      ["light", "p"],
      ["calvin", "p"],
      ["chl", "light"],
      ["light", "o2"],
      ["light", "atp"],
      ["atp", "calvin"],
      ["co2", "calvin"],
      ["rubisco", "calvin"],
      ["calvin", "glucose"],
      ["stomata", "co2"],
    ].map(([from, to]) => ({ from: from!, to: to! }));
    const placed = layoutMindMap(nodes, links);
    const boxes = nodes.map((node, index) => nameBox(node.text, index === 0));
    expect(placed[0]).toMatchObject({ x: 50, y: 50 });
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i]!;
      expect(a.x - boxes[i]!.w / 2).toBeGreaterThanOrEqual(0);
      expect(a.x + boxes[i]!.w / 2).toBeLessThanOrEqual(100);
      expect(a.y - boxes[i]!.h / 2).toBeGreaterThanOrEqual(0);
      expect(a.y + boxes[i]!.h / 2).toBeLessThanOrEqual(100);
      for (let j = i + 1; j < placed.length; j++) {
        const b = placed[j]!;
        const apart = Math.abs(a.x - b.x) >= (boxes[i]!.w + boxes[j]!.w) / 2 || Math.abs(a.y - b.y) >= (boxes[i]!.h + boxes[j]!.h) / 2;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    }
  });

  it("are sized by their words: a long name wraps to more lines rather than growing past its width", () => {
    const short = nameBox("Oxygen");
    const long = nameBox("The light-independent reactions of the stroma");
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.h).toBeGreaterThan(short.h);
    expect(nameBox("x".repeat(400)).w).toBe(long.w);
  });
});

test("a map fits its box at any width: scaled down below its narrowest, to the height in the full view, and times the zoom", () => {
  expect(fitMap({ w: 324, h: 0 })).toEqual({ laid: 540, scale: 0.6 });
  expect(fitMap({ w: 810, h: 0 })).toEqual({ laid: 810, scale: 1 });
  expect(fitMap({ w: 1200, h: 400 }, 1, true)).toEqual({ laid: 600, scale: 1 });
  expect(fitMap({ w: 270, h: 800 }, 2, true)).toEqual({ laid: 540, scale: 1 });
});
