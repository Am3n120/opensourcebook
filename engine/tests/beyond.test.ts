import { expect, test } from "vitest";
import { beyondSources } from "../src/sources/beyond";

const source = "The tested group scored 12.4 points higher (p < .001, d = 0.62) across 1,240 students. Students practised retrieving the material.";

test("numbers and bold terms the sources do not contain are found; ones they do are not", () => {
  const found = beyondSources("A gap of **12.4 points** over 1240 students; p below .001, so under 1 in 1000. An effect near **0.8** counts as large, and this is **retrieval practice**.", [source]);
  expect(found.numbers).toEqual(["1000", "0.8"]);
  expect(found.terms).toEqual(["0.8", "retrieval practice"]);
});

test("single digits and numbers written as the source writes them pass", () => {
  expect(beyondSources("Step 2: d is 0.62, about 62 percent of a standard deviation.", [source]).numbers).toEqual(["62 percent"]);
  expect(beyondSources("Two groups, 3 weeks.", [source]).numbers).toEqual([]);
});
