import { describe, expect, it } from "vitest";
import { DEPTH_TARGETS, liftDepthCapForResearch } from "../src/types";

describe("depth targets", () => {
  it("enables research for standard and deeper requests only", () => {
    expect(DEPTH_TARGETS.saveOnly.research).toBe(false);
    expect(DEPTH_TARGETS.light.research).toBe(false);
    expect(DEPTH_TARGETS.standard.research).toBe(true);
    expect(DEPTH_TARGETS.deep.research).toBe(true);
  });
});

describe("liftDepthCapForResearch", () => {
  it("lifts the extraction cap by exactly one tier", () => {
    expect(liftDepthCapForResearch("tiny")).toBe("light");
    expect(liftDepthCapForResearch("light")).toBe("medium");
    expect(liftDepthCapForResearch("medium")).toBe("deep");
    expect(liftDepthCapForResearch("deep")).toBe("veryDeep");
  });

  it("never lifts saveOnly or past veryDeep (source-honesty ceiling)", () => {
    expect(liftDepthCapForResearch("saveOnly")).toBe("saveOnly");
    expect(liftDepthCapForResearch("veryDeep")).toBe("veryDeep");
  });
});
