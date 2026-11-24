import { becauseWords, branchesTaken } from "./branches";

const low = { title: "Fix it", condition: { kind: "metric", metric: "score", below: 0.7 }, made: false };
const high = { title: "Go on", condition: { kind: "metric", metric: "score", atLeast: 0.7 }, made: true };
const ask = { title: "Ask", condition: { kind: "ask", question: "Want more?" }, made: false };

test("a result takes the branches whose mark it is under or over, never one the person answers", () => {
  expect(branchesTaken([low, high, ask], { score: 0.5 }).map((b) => b.title)).toEqual(["Fix it"]);
  expect(branchesTaken([low, high, ask], { score: 0.7 }).map((b) => b.title)).toEqual(["Go on"]);
  expect(branchesTaken([low], { other: 1 })).toEqual([]);
  expect(branchesTaken(undefined, { score: 0 })).toEqual([]);
});

test("why a branch was taken reads as a mark", () => {
  expect(becauseWords(low.condition)).toBe("you scored under 70%");
  expect(becauseWords(high.condition)).toBe("you scored 70% or more");
  expect(becauseWords({ kind: "metric", metric: "seconds", below: 60 })).toBe("seconds was below 60");
});
