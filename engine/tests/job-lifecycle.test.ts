import { describe, expect, it } from "vitest";
import {
  JobSupersededError,
  cancelJob,
  claimJob,
  markDead,
  resetJobForNewMaker,
  retryJob,
  type ClaimOutcome,
  type JobRun,
} from "../src/jobs/lifecycle";
import type { GenerationJobStore } from "../src/jobs/types";
import { InterleavingStore, ManualClock, STORE_FACTORIES } from "./support/job-harness";

const STALE_MS = 120_000;

function setup(make: (clock: ManualClock) => GenerationJobStore) {
  const clock = new ManualClock();
  const inner = make(clock);
  const store = new InterleavingStore(inner);
  const options = { now: clock.now, staleAfterMs: STALE_MS };
  return { clock, inner, store, options };
}

async function claimed(outcome: Promise<ClaimOutcome>): Promise<JobRun> {
  const result = await outcome;
  if (result.kind !== "claimed") throw new Error(`expected a claim, got ${result.kind}`);
  return result.run;
}

describe.each(STORE_FACTORIES)("job lifecycle: $name", ({ make }) => {
  describe("cancel race", () => {
    it("a cancel landing between a run's read and its progress write wins", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(store, job.id, options));
      await run.progress("writing", 0.3);

      // The run holds the row at version v. The cancel is committed after
      // the run has read v and before its compare-and-set reaches the store.
      store.beforeNextWrite(() => cancelJob(inner, job.id));
      const write = run.progress("writing", 0.6);

      await expect(write).rejects.toBeInstanceOf(JobSupersededError);
      const after = await inner.get(job.id);
      expect(after).toMatchObject({ status: "cancelled", progress: 0.3, stage: "writing" });
      // The run's write was attempted once, at the stale version, and lost.
      expect(store.writes.at(-1)).toMatchObject({ ok: false, patch: { progress: 0.6 } });
      expect(run.signal.aborted).toBe(true);
      // Nothing the run does afterwards reaches the row.
      await expect(run.complete({ outputId: "out" })).rejects.toBeInstanceOf(JobSupersededError);
      await expect(run.fail("late", true)).rejects.toBeInstanceOf(JobSupersededError);
      expect(await inner.get(job.id)).toEqual(after);
    });

    it("a cancel landing between a run's read and its completion keeps the job cancelled", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(store, job.id, options));
      store.beforeNextWrite(() => cancelJob(inner, job.id));
      await expect(run.complete({ outputId: "out-1" })).rejects.toBeInstanceOf(JobSupersededError);
      const after = await inner.get(job.id);
      expect(after?.status).toBe("cancelled");
      expect(after?.outputId).toBeUndefined();
    });

    it("a progress write landing between the cancel's read and write does not lose the cancel", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(inner, job.id, options));

      // Now the run is the one that sneaks in: cancel reads, the run writes,
      // cancel's compare-and-set fails and it decides again from the new row.
      store.beforeNextWrite(() => run.progress("writing", 0.5));
      const outcome = await cancelJob(store, job.id);

      expect(outcome.kind).toBe("cancelled");
      expect(store.writes.map((write) => write.ok)).toEqual([false, true]);
      expect(await inner.get(job.id)).toMatchObject({ status: "cancelled", progress: 0.5 });
      await expect(run.progress("writing", 0.7)).rejects.toBeInstanceOf(JobSupersededError);
    });

    it("a cancel landing between a claim's read and write stops the job before it runs", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      store.beforeNextWrite(() => cancelJob(inner, job.id));
      const outcome = await claimJob(store, job.id, options);
      expect(outcome.kind).toBe("final");
      expect(await inner.get(job.id)).toMatchObject({ status: "cancelled", attempt: 0 });
    });

    it("cancel is idempotent and refuses a finished job", async () => {
      const { store, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      expect((await cancelJob(store, job.id)).kind).toBe("cancelled");
      expect((await cancelJob(store, job.id)).kind).toBe("unchanged");

      const other = (await store.create({ ownerId: "o", idempotencyKey: "k2" })).job;
      const run = await claimed(claimJob(store, other.id, options));
      await run.complete();
      expect((await cancelJob(store, other.id)).kind).toBe("done");
    });
  });

  describe("claims", () => {
    it("two consumers racing for one queued job: exactly one claims it", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      let second: ClaimOutcome | undefined;
      // Consumer B claims after consumer A has read the queued row.
      store.beforeNextWrite(async () => {
        second = await claimJob(inner, job.id, options);
      });
      const first = await claimJob(store, job.id, options);
      expect(second?.kind).toBe("claimed");
      expect(first.kind).toBe("busy");
      expect(await inner.get(job.id)).toMatchObject({ status: "running", attempt: 1 });
    });

    it("claims a failed retryable job again on redelivery, keeping saved state", async () => {
      const { store, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const first = await claimed(claimJob(store, job.id, options));
      await first.saveState("blueprint", { sections: ["intro", "body"] });
      await first.progress("writing", 0.7);
      await first.fail("provider timed out", true);

      const second = await claimed(claimJob(store, job.id, options));
      expect(second.attempt).toBe(2);
      expect(second.job).toMatchObject({
        status: "running",
        stage: "starting",
        progress: 0,
        retryable: false,
        state: { blueprint: { sections: ["intro", "body"] } },
      });
      expect(second.job.errorMessage).toBeUndefined();
      expect(second.job.finishedAt).toBeUndefined();
    });

    it("does not claim a final failure, a finished, cancelled or dead job", async () => {
      const { store, options } = setup(make);
      const make1 = async (key: string) => (await store.create({ ownerId: "o", idempotencyKey: key })).job.id;

      const finalFailure = await make1("final");
      await (await claimed(claimJob(store, finalFailure, options))).fail("bad input", false);
      expect((await claimJob(store, finalFailure, options)).kind).toBe("failed");

      const done = await make1("done");
      await (await claimed(claimJob(store, done, options))).complete();
      expect((await claimJob(store, done, options)).kind).toBe("final");

      const cancelled = await make1("cancelled");
      await cancelJob(store, cancelled);
      expect((await claimJob(store, cancelled, options)).kind).toBe("final");

      expect((await claimJob(store, "missing", options)).kind).toBe("missing");
    });

    it("leaves a running job with a fresh heartbeat alone and takes over a stale one", async () => {
      const { store, clock, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const old = await claimed(claimJob(store, job.id, options));

      clock.advance(STALE_MS - 1);
      expect((await claimJob(store, job.id, options)).kind).toBe("busy");
      await old.heartbeat();
      clock.advance(STALE_MS - 1);
      expect((await claimJob(store, job.id, options)).kind).toBe("busy");

      clock.advance(1);
      const takeover = await claimed(claimJob(store, job.id, options));
      expect(takeover.attempt).toBe(2);

      // The first attempt was not dead after all; its writes are fenced off.
      await expect(old.progress("writing", 0.9)).rejects.toThrow(/superseded by attempt 2/);
      await takeover.progress("writing", 0.2);
      await takeover.complete({ outputId: "out-2" });
      expect(await store.get(job.id)).toMatchObject({ status: "done", outputId: "out-2", attempt: 2, progress: 1 });
    });
  });

  describe("runs", () => {
    it("never moves progress backwards within an attempt and clamps it", async () => {
      const { store, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(store, job.id, options));
      expect((await run.progress("writing", 0.6)).progress).toBe(0.6);
      expect((await run.progress("verifying", 0.4)).progress).toBe(0.6);
      expect((await run.progress("verifying", 7)).progress).toBe(1);
      expect((await run.progress("verifying", Number.NaN)).progress).toBe(1);
      expect((await run.progress("verifying", 0.9)).stage).toBe("verifying");
    });

    it("re-applies a write that lost only to its own heartbeat", async () => {
      const { store, inner, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(store, job.id, options));
      // Same attempt, still running: a heartbeat landing in between is benign.
      store.beforeNextWrite(async () => {
        const current = await inner.get(job.id);
        await inner.compareAndSet(job.id, current!.version, {});
      });
      const written = await run.saveState("research", { claims: 2 });
      expect(written.state).toEqual({ research: { claims: 2 } });
      // After the claim: the lost write, then the same write re-applied.
      expect(store.writes.slice(1).map((write) => write.ok)).toEqual([false, true]);
    });

    it("completes with output id and merged state", async () => {
      const { store, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(store, job.id, options));
      await run.saveState("blueprint", { n: 1 });
      const done = await run.complete({ outputId: "out-1", state: { repairRounds: 1 } });
      expect(done).toMatchObject({
        status: "done",
        stage: "done",
        progress: 1,
        outputId: "out-1",
        state: { blueprint: { n: 1 }, repairRounds: 1 },
      });
      expect(done.finishedAt).toBeDefined();
    });
  });

  describe("manual retry", () => {
    it("requeues a retryable failure or a dead job, and refuses anything else", async () => {
      const { store, clock, options } = setup(make);
      const id = async (key: string) => (await store.create({ ownerId: "o", idempotencyKey: key })).job.id;

      const retryable = await id("retryable");
      await (await claimed(claimJob(store, retryable, options))).fail("429", true);
      const queued = await retryJob(store, retryable);
      expect(queued).toMatchObject({ kind: "queued", job: { status: "queued", stage: "queued", progress: 0, attempt: 1 } });
      expect(queued.job.errorMessage).toBeUndefined();

      const final = await id("final");
      await (await claimed(claimJob(store, final, options))).fail("unsupported file", false);
      expect((await retryJob(store, final)).kind).toBe("refused");

      const dead = await id("dead");
      await claimed(claimJob(store, dead, options));
      clock.advance(STALE_MS);
      expect((await markDead(store, dead, options)).kind).toBe("dead");
      expect((await retryJob(store, dead)).kind).toBe("queued");

      const fresh = await id("fresh");
      expect((await retryJob(store, fresh)).kind).toBe("refused");
    });
  });

  describe("dead letter", () => {
    it("marks a queued, failed or stale running job dead with the last error", async () => {
      const { store, clock, options } = setup(make);
      const id = async (key: string) => (await store.create({ ownerId: "o", idempotencyKey: key })).job.id;

      const failed = await id("failed");
      for (let i = 0; i < 3; i += 1) {
        await (await claimed(claimJob(store, failed, options))).fail("upstream 503", true);
      }
      const outcome = await markDead(store, failed, options);
      expect(outcome).toMatchObject({
        kind: "dead",
        job: { status: "dead", retryable: false, errorMessage: "The queue gave up after 3 attempts. Last error: upstream 503" },
      });

      const queued = await id("queued");
      expect(await markDead(store, queued, options)).toMatchObject({
        kind: "dead",
        job: { errorMessage: "The queue gave up after 0 attempts." },
      });

      const running = await id("running");
      await claimed(claimJob(store, running, options));
      expect((await markDead(store, running, options)).kind).toBe("busy");
      clock.advance(STALE_MS);
      expect(await markDead(store, running, options)).toMatchObject({ kind: "dead", job: { status: "dead", attempt: 1 } });

      expect((await markDead(store, "missing", options)).kind).toBe("missing");
    });

    it("a completion landing between the dead-letter read and write is kept", async () => {
      const { store, inner, clock, options } = setup(make);
      const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
      const run = await claimed(claimJob(inner, job.id, options));
      clock.advance(STALE_MS);
      // The run was slow, not dead: it completes after the dead-letter
      // consumer has read it as stale and before that consumer writes.
      store.beforeNextWrite(() => run.complete({ outputId: "out-late" }));
      const outcome = await markDead(store, job.id, options);
      expect(outcome.kind).toBe("unchanged");
      expect(await inner.get(job.id)).toMatchObject({ status: "done", outputId: "out-late" });
    });

    it("leaves done, cancelled and final failures alone", async () => {
      const { store, options } = setup(make);
      const id = async (key: string) => (await store.create({ ownerId: "o", idempotencyKey: key })).job.id;
      const done = await id("done");
      await (await claimed(claimJob(store, done, options))).complete();
      const cancelled = await id("cancelled");
      await cancelJob(store, cancelled);
      const final = await id("final");
      await (await claimed(claimJob(store, final, options))).fail("bad", false);
      for (const jobId of [done, cancelled, final]) {
        const before = await store.get(jobId);
        expect((await markDead(store, jobId, options)).kind).toBe("unchanged");
        expect(await store.get(jobId)).toEqual(before);
      }
    });
  });
});

describe.each(STORE_FACTORIES)("a job given a new maker: $name", ({ make }) => {
  it("takes the new input and loses its saved steps, only when cancelled or failed", async () => {
    const { store, options } = setup(make);
    const { job } = await store.create({ ownerId: "o", idempotencyKey: "k", input: { title: "t", settings: { agent: "agent:claude" } } });
    // Queued: refused, and untouched.
    expect((await resetJobForNewMaker(store, job.id, { title: "t", settings: { agent: "agent:codex" } })).kind).toBe("refused");
    const run = await claimed(claimJob(store, job.id, options));
    await run.progress("writing", 0.4);
    // Running: refused.
    expect((await resetJobForNewMaker(store, job.id, { title: "t", settings: { agent: "agent:codex" } })).kind).toBe("refused");
    await cancelJob(store, job.id);
    const reset = await resetJobForNewMaker(store, job.id, { title: "t", settings: { agent: "agent:codex" } });
    expect(reset.kind).toBe("reset");
    const after = (await store.get(job.id))!;
    expect(after).toMatchObject({ status: "cancelled", attempt: 0, state: {}, input: { title: "t", settings: { agent: "agent:codex" } } });
  });

  it("is refused for a job that is done", async () => {
    const { store, options } = setup(make);
    const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
    const run = await claimed(claimJob(store, job.id, options));
    await run.complete({ outputId: "out" });
    expect((await resetJobForNewMaker(store, job.id, {})).kind).toBe("refused");
  });
});
