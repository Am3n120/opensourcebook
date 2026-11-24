/**
 * A queued item says what it waits for: the things of the person's being made on this computer now, by their titles,
 * and that one was carried on after Open Sourcebook restarted, so a request made after a restart is never silent behind it.
 */
import { describe, expect, it } from "vitest";
import { doneByView, queuedStep } from "../src/routes/plans";
import type { GenerationJob } from "../src/jobs/types";

function job(id: string, overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id,
    ownerId: "owner-1",
    idempotencyKey: id,
    kind: "output",
    type: "video",
    status: "running",
    stage: "writing",
    progress: 0.4,
    attempt: 1,
    version: 1,
    retryable: true,
    input: { title: `Item ${id}` },
    state: {},
    createdAt: "2026-11-19T13:00:00.000Z",
    updatedAt: "2026-11-19T13:00:00.000Z",
    ...overrides,
  };
}

describe("a queued item's step", () => {
  const waiting = job("new", { status: "queued", stage: "queued", progress: 0, input: { title: "Photosynthesis" } });

  it("names the one thing being made first, and says it was carried on after a restart", () => {
    const carried = job("old", { attempt: 2, input: { title: "How a bill becomes a law" } });
    expect(queuedStep(waiting, [carried])).toBe("Waiting to start: “How a bill becomes a law” is being made first. Open Sourcebook carried it on after a restart.");
    expect(queuedStep(waiting, [job("old", { input: { title: "How a bill becomes a law" } })])).toBe("Waiting to start: “How a bill becomes a law” is being made first.");
  });

  it("names a few by title and counts more, and says nothing when nothing else of the person's is being made", () => {
    expect(queuedStep(waiting, [job("a"), job("b")])).toBe("Waiting to start: “Item a” and “Item b” are being made first.");
    expect(queuedStep(waiting, [job("a"), job("b"), job("c"), job("d")])).toBe("Waiting to start: 4 other items are being made first.");
    expect(queuedStep(waiting, [])).toBeUndefined();
    expect(queuedStep(waiting, [waiting])).toBeUndefined();
    expect(queuedStep(waiting, [job("x", { ownerId: "someone-else" }), job("y", { kind: "source" }), job("z", { status: "waiting" })])).toBeUndefined();
  });
});

describe("a running item's end time", () => {
  it("is the maker's word in this attempt: when it expects to be done, or that it cannot know; an older attempt's word is dropped", () => {
    expect(doneByView(job("a", { attempt: 2, state: { doneBy: { attempt: 2, at: "2026-11-19T13:10:00.000Z" } } }))).toEqual({ doneBy: "2026-11-19T13:10:00.000Z" });
    expect(doneByView(job("a", { attempt: 2, state: { doneBy: { attempt: 2, at: null } } }))).toEqual({ leftUnknown: true });
    expect(doneByView(job("a", { attempt: 3, state: { doneBy: { attempt: 2, at: "2026-11-19T13:10:00.000Z" } } }))).toEqual({});
    expect(doneByView(job("a"))).toEqual({});
  });
});
