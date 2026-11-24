import { markSpan } from "./spot";

test("a cited spot marks its quote when the quote is inside it, else the whole span", () => {
  const text = "Intro. A limit exists only when both one-sided limits agree. More.";
  expect(markSpan(text, { charStart: 7, charEnd: 61, quote: "Both one-sided limits agree" })).toEqual([32, 59]);
  expect(markSpan(text, { charStart: 7, charEnd: 61, quote: "not there" })).toEqual([7, 61]);
  expect(markSpan(text, { charStart: 900, charEnd: 950 })).toBeUndefined();
});
