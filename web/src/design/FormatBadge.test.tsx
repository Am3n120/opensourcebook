import { render, screen } from "@testing-library/react";
import { FormatBadge } from "./FormatBadge";
import { lookFor, NEUTRAL_SLOT, type FormatLike } from "./formatLook";

const formats: FormatLike[] = [
  { id: "alpha", label: "alpha", colorSlot: 2, icon: "feed" },
  { id: "beta", label: "beta two", colorSlot: 4, icon: "flip", aliases: ["oldBeta"] },
  { id: "gamma", label: "gamma", colorSlot: 42, icon: "nope" },
];

test("takes label, slot and icon from the descriptor", () => {
  expect(lookFor(formats, "beta")).toEqual({ id: "beta", label: "beta two", colorSlot: 4, icon: "flip" });
});

test("resolves an alias to its format", () => {
  expect(lookFor(formats, "oldBeta").label).toBe("beta two");
});

test("an unknown id keeps its text on the neutral slot", () => {
  expect(lookFor(formats, "mystery")).toEqual({ id: "mystery", label: "mystery", colorSlot: NEUTRAL_SLOT, icon: "doc" });
});

test("a slot outside the palette falls back to neutral", () => {
  expect(lookFor(formats, "gamma").colorSlot).toBe(NEUTRAL_SLOT);
});

test("the badge paints the slot's colours", () => {
  render(<FormatBadge id="oldBeta" formats={formats} />);
  const badge = screen.getByText("beta two");
  expect(badge.getAttribute("style")).toContain("--fmt-bg: var(--fmt-4-bg)");
  expect(badge.dataset.format).toBe("beta");
});
