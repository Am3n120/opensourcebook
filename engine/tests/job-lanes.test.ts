/**
 * A quick thing never waits behind a slow one: heavy items (a format that says making one uses most of this
 * computer) go in a line of their own, made one at a time, and every other item goes in the shared line beside it.
 * A queued item says it waits only for what is ahead of it in its own line.
 */
import { describe, expect, it } from "vitest";
import { batchConcurrency, laneOf, sameLine, sendToLane } from "../src/jobs/lanes";
import { queuedStep } from "../src/routes/plans";
import type { GenerationJob } from "../src/jobs/types";

const registry = {
  get: (type: string) => (type === "slow" ? ({ heavy: true } as never) : type === "quick" ? ({} as never) : undefined),
};

function job(id: string, type: string, overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id,
    ownerId: "owner-1",
    idempotencyKey: id,
    kind: "output",
    type,
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

describe("lanes", () => {
  it("puts a heavy format's items in the heavy line, and everything else in the shared one", () => {
    expect(laneOf(job("a", "slow"), registry, true)).toBe("heavy");
    expect(laneOf(job("b", "quick"), registry, true)).toBe("shared");
    expect(laneOf(job("c", "unknown"), registry, true)).toBe("shared");
    // With no heavy line bound, there is one line for all.
    expect(laneOf(job("a", "slow"), registry, false)).toBe("shared");
  });

  it("sends each job to its line's queue", async () => {
    const sent: string[] = [];
    const queues = { shared: { send: async (body: { jobId: string }) => void sent.push(`shared ${body.jobId}`) }, heavy: { send: async (body: { jobId: string }) => void sent.push(`heavy ${body.jobId}`) } };
    const jobs = new Map([
      ["v", job("v", "slow")],
      ["f", job("f", "quick")],
    ]);
    const read = async (id: string) => jobs.get(id);
    await sendToLane("v", queues, read, registry);
    await sendToLane("f", queues, read, registry);
    await sendToLane("gone", queues, read, registry);
    await sendToLane("v", { shared: queues.shared }, read, registry);
    expect(sent).toEqual(["heavy v", "shared f", "shared gone", "shared v"]);
  });

  it("says a quick item waits for nothing while a heavy one is made, and a heavy one waits for the heavy one ahead", () => {
    const video = job("v", "slow", { input: { title: "The 1887 experiment" } });
    const cards = job("f", "quick", { status: "queued" });
    const second = job("v2", "slow", { status: "queued" });
    const ahead = (waiting: GenerationJob) => [video].filter((other) => sameLine(waiting, other, registry, true));
    expect(queuedStep(cards, ahead(cards))).toBeUndefined();
    expect(queuedStep(second, ahead(second))).toBe("Waiting to start: “The 1887 experiment” is being made first.");
    // One line for all: the quick item waits, and says so.
    expect(queuedStep(cards, [video].filter((other) => sameLine(cards, other, registry, false)))).toBe("Waiting to start: “The 1887 experiment” is being made first.");
  });
});

describe("the heavy queue's consumer", () => {
  it("makes a batch from the heavy queue one job at a time, and leaves the other lines at their own pace", () => {
    expect(batchConcurrency("re-heavy-jobs", "re-heavy-jobs")).toBe(1);
    expect(batchConcurrency("re-byte-jobs", "re-heavy-jobs")).toBeUndefined();
    expect(batchConcurrency("re-heavy-jobs", undefined)).toBeUndefined();
  });
});
