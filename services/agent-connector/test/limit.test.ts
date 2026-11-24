/** Reading when an agent said its usage limit resets: only what it really said, never a guess. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { epochToIso, heardLimit, resetWords } from "../src/agents/limit.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

test("an epoch the agent gave is kept as ISO, in seconds or milliseconds; anything else is nothing", () => {
  const iso = new Date(1763503200 * 1000).toISOString();
  assert.equal(epochToIso(1763503200), iso);
  assert.equal(epochToIso(1763503200000), iso);
  assert.equal(epochToIso("1763503200"), iso);
  for (const value of [undefined, null, "soon", Number.NaN, Number.POSITIVE_INFINITY, -1, 0, {}]) assert.equal(epochToIso(value), undefined);
});

test("the stream's reset time wins, and the older epoch after a pipe is read", () => {
  assert.deepEqual(heardLimit("You've hit your limit", "2026-11-18T15:00:00.000Z", NOW), { resetsAt: "2026-11-18T15:00:00.000Z" });
  assert.deepEqual(heardLimit("Claude AI usage limit reached|1763503200", undefined, NOW), { resetsAt: new Date(1763503200 * 1000).toISOString() });
  assert.deepEqual(heardLimit("You've hit your limit · resets 3pm (Europe/Berlin)", "2026-11-18T14:00:00.000Z", NOW), { resetsAt: "2026-11-18T14:00:00.000Z", resets: "3pm (Europe/Berlin)" });
});

test("the agent's own words for when are kept; a clock time gets no date", () => {
  assert.deepEqual(heardLimit("You've hit your limit · resets 3pm (Europe/Berlin)", undefined, NOW), { resets: "3pm (Europe/Berlin)" });
  assert.deepEqual(heardLimit("5-hour limit reached ∙ resets 3pm", undefined, NOW), { resets: "3pm" });
  assert.deepEqual(heardLimit("Usage limit reached. Your limit will reset at 5:00 PM.\nother things", undefined, NOW), { resets: "5:00 PM" });
  assert.deepEqual(heardLimit("You've hit your usage limit. Upgrade to Pro (https://example.com/pricing), or try again at Nov 20th, 2026 3:05 PM.", undefined, NOW), { resets: "Nov 20th, 2026 3:05 PM" });
  assert.deepEqual(heardLimit("Weekly limit reached | resets Monday at 9am | upgrade", undefined, NOW), { resets: "Monday at 9am" });
  const long = resetWords(`resets ${"9 and then some more words ".repeat(6)}`)!;
  assert.ok(long.length <= 60 && long.startsWith("9 and then"));
});

test("an exact delay ('try again in 2 hours') also gives the time", () => {
  assert.deepEqual(heardLimit("Rate limit exceeded. Please try again in 2 hours.", undefined, NOW), { resetsAt: "2026-11-18T14:00:00.000Z", resets: "in 2 hours" });
  assert.deepEqual(heardLimit("You've hit your usage limit. Upgrade to Pro, or try again in 4 days 2 hours 31 minutes.", undefined, NOW), {
    resetsAt: new Date(NOW + 4 * 86_400_000 + 2 * 3_600_000 + 31 * 60_000).toISOString(),
    resets: "in 4 days 2 hours 31 minutes",
  });
  assert.deepEqual(heardLimit("quota exceeded, resets in 45 minutes", undefined, NOW), { resetsAt: "2026-11-18T12:45:00.000Z", resets: "in 45 minutes" });
});

test("a limit that says nothing about its reset gives nothing", () => {
  for (const said of ["", "Claude AI usage limit reached", "Rate limit exceeded. Please try again later.", "insufficient_quota: You exceeded your current quota", "429 Too Many Requests", "rate limit: the counter was reset by the server", "You've hit your limit"]) {
    assert.equal(heardLimit(said, undefined, NOW), undefined, said);
  }
});
