import { proposalLine } from "./commands";

test("the card says its kind once and never 'Your agent'", () => {
  expect(proposalLine("set of flashcards", "flashcards · Your agent · 15 cards", undefined)).toBe("set of flashcards · 15 cards · not made yet");
  expect(proposalLine("quiz", "", undefined)).toBe("quiz · not made yet");
});

test("the card names who would make it by model and effort when a pick is known", () => {
  expect(proposalLine("video", "Your agent · 3 min", "Z Mid · low")).toBe("video · 3 min · Z Mid · low · not made yet");
});
