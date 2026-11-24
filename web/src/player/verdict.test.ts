import { withoutVerdict } from "./verdict";

test("a verdict the feedback opens with is taken off; words that only start alike are kept", () => {
  expect(withoutVerdict("Right. Two pivots.")).toBe("Two pivots.");
  expect(withoutVerdict("Not quite: the rule says one.")).toBe("The rule says one.");
  expect(withoutVerdict("Wrong — it reverses cause and effect.")).toBe("It reverses cause and effect.");
  expect(withoutVerdict("That's correct, because the columns span.")).toBe("Because the columns span.");
  expect(withoutVerdict("Right angles add up to 180 degrees in pairs.")).toBe("Right angles add up to 180 degrees in pairs.");
  expect(withoutVerdict("No two isotopes share a mass number here.")).toBe("No two isotopes share a mass number here.");
});
