import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  handleDeadLetterBatch,
  handleJobBatch,
  type JobConsumerOptions,
  type JobRunner,
} from "../src/jobs/consumer";
import { JobFailure, JobSupersededError, cancelJob, type JobRun } from "../src/jobs/lifecycle";
import type { GenerationJob, GenerationJobStore, JobQueueBatch } from "../src/jobs/types";
import { FakeQueue, ManualClock, STORE_FACTORIES, gate, until } from "./support/job-harness";
import { createSqliteD1 } from "./support/sqlite-d1";

const STALE_MS = 120_000;
const MAX_RETRIES = 3;

function setup(make: (clock: ManualClock) => GenerationJobStore, runner: JobRunner) {
  const clock = new ManualClock();
  const store = make(clock);
  const dlq = new FakeQueue("jobs-dlq", clock, { maxRetries: MAX_RETRIES });
  const queue = new FakeQueue("jobs", clock, { maxRetries: MAX_RETRIES, deadLetter: dlq });
  const logs: string[] = [];
  const options: JobConsumerOptions = {
    store,
    runners: { output: runner },
    now: clock.now,
    staleAfterMs: STALE_MS,
    heartbeatMs: 0,
    log: (line) => void logs.push(line),
  };
  const consume = (batch: JobQueueBatch) => handleJobBatch(batch, options);
  const consumeDead = (batch: JobQueueBatch) =>
    handleDeadLetterBatch(batch, { store, now: clock.now, staleAfterMs: STALE_MS, maxDeliveries: MAX_RETRIES + 1 });
  const enqueue = async (key = "k") => {
    const { job } = await store.create({ ownerId: "o", idempotencyKey: key, type: "byte" });
    queue.send(job.id);
    return job.id;
  };
  return { clock, store, queue, dlq, consume, consumeDead, enqueue, logs };
}

describe.each(STORE_FACTORIES)("job consumer: $name", ({ make }) => {
  it("runs a queued job to done and acks", async () => {
    const seen: number[] = [];
    const { store, queue, consume, enqueue } = setup(make, {
      async run(run) {
        seen.push(run.attempt);
        await run.progress("writing", 0.5);
        return { outputId: "out-1" };
      },
    });
    const id = await enqueue();
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
    expect(seen).toEqual([1]);
    expect(await store.get(id)).toMatchObject({ status: "done", progress: 1, outputId: "out-1", attempt: 1 });
    expect(queue.size).toBe(0);
  });

  it("redelivery of a failed retryable job runs it again and resumes from saved state", async () => {
    const attempts: Array<{ attempt: number; state: unknown }> = [];
    const { store, queue, consume, enqueue } = setup(make, {
      async run(run) {
        attempts.push({ attempt: run.attempt, state: run.job.state });
        if (run.attempt === 1) {
          await run.saveState("blueprint", { sections: 3 });
          throw new Error("provider returned 503");
        }
        return { outputId: "out-2" };
      },
    });
    const id = await enqueue();

    const first = await queue.deliverNext(consume);
    expect(first).toMatchObject({ result: "retry", delaySeconds: 15 });
    expect(await store.get(id)).toMatchObject({ status: "failed", retryable: true, errorMessage: "provider returned 503" });

    // August acked this redelivery because the job said "failed".
    const second = await queue.deliverNext(consume);
    expect(second).toMatchObject({ attempts: 2, result: "ack" });
    expect(attempts).toEqual([
      { attempt: 1, state: {} },
      { attempt: 2, state: { blueprint: { sections: 3 } } },
    ]);
    expect(await store.get(id)).toMatchObject({ status: "done", attempt: 2, outputId: "out-2" });
  });

  it("acks a final failure and never runs it again", async () => {
    let runs = 0;
    const { store, queue, consume, enqueue } = setup(make, {
      async run() {
        runs += 1;
        throw new JobFailure("the upload is not a supported file", false);
      },
    });
    const id = await enqueue();
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
    expect(await store.get(id)).toMatchObject({ status: "failed", retryable: false });
    // An at-least-once duplicate of the same message.
    queue.send(id);
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
    expect(runs).toBe(1);
  });

  it("redelivery of a job still marked running: defers while it is fresh, takes over once stale", async () => {
    const firstRun = gate<JobRun>();
    const attempts: number[] = [];
    const { store, clock, queue, consume, enqueue } = setup(make, {
      async run(run) {
        attempts.push(run.attempt);
        if (run.attempt === 1) {
          firstRun.open(run);
          return new Promise(() => undefined); // the isolate is killed mid-run
        }
        await run.progress("writing", 0.5);
        return { outputId: "out-takeover" };
      },
    });
    const id = await enqueue();

    // Delivery 1 claims the job, starts running, and the isolate dies.
    await queue.deliverAndKill(consume, async () => void (await firstRun.promise));
    const orphan = await firstRun.promise;
    expect(await store.get(id)).toMatchObject({ status: "running", attempt: 1 });

    // Delivery 2 arrives at once: the row was written moments ago.
    expect(await queue.deliverNext(consume)).toMatchObject({ attempts: 2, result: "retry", delaySeconds: 60 });
    expect(attempts).toEqual([1]);

    // Delivery 3, 60 s later, is still inside the window.
    expect(await queue.deliverNext(consume)).toMatchObject({ attempts: 3, result: "retry" });

    // Delivery 4 is 120 s after the last write: the job is taken over.
    expect(await queue.deliverNext(consume)).toMatchObject({ attempts: 4, result: "ack" });
    expect(clock.now() - Date.parse((await store.get(id))!.startedAt!)).toBe(0);
    expect(attempts).toEqual([1, 2]);
    expect(await store.get(id)).toMatchObject({ status: "done", attempt: 2, outputId: "out-takeover" });

    // The first attempt wakes up after all; it can no longer touch the row.
    await expect(orphan.progress("writing", 0.99)).rejects.toThrow("is done; attempt 1 stops");
    await expect(orphan.complete({ outputId: "out-orphan" })).rejects.toBeInstanceOf(JobSupersededError);
    expect((await store.get(id))?.outputId).toBe("out-takeover");
  });

  it("max retries reached: the message goes to the dead-letter queue and the job ends dead", async () => {
    let runs = 0;
    const { store, queue, dlq, consume, consumeDead, enqueue } = setup(make, {
      async run() {
        runs += 1;
        throw new Error(`upstream 503 on run ${runs}`);
      },
    });
    const id = await enqueue();

    const results = [];
    while (queue.size > 0) results.push(await queue.deliverNext(consume));
    expect(results.map((record) => [record.attempts, record.result, record.delaySeconds])).toEqual([
      [1, "retry", 15],
      [2, "retry", 30],
      [3, "retry", 60],
      [4, "retry", 120],
    ]);
    expect(runs).toBe(MAX_RETRIES + 1);
    expect(await store.get(id)).toMatchObject({ status: "failed", retryable: true, attempt: 4 });

    expect(dlq.size).toBe(1);
    expect(await dlq.deliverNext(consumeDead)).toMatchObject({ result: "ack" });
    expect(await store.get(id)).toMatchObject({
      status: "dead",
      retryable: false,
      errorMessage: "The queue gave up after 4 attempts. Last error: upstream 503 on run 4",
    });
    expect(dlq.size).toBe(0);
  });

  it("max retries reached while the job is marked running: dead once its heartbeat is stale", async () => {
    const { store, clock, queue, dlq, consume, consumeDead, enqueue } = setup(make, {
      async run() {
        return new Promise(() => undefined);
      },
    });
    const id = await enqueue();
    // Every delivery that claims the job dies in the isolate; the ones in
    // between find it freshly running and are deferred.
    const kinds: string[] = [];
    while (queue.size > 0) {
      clock.advanceTo(queue.nextReadyAt!);
      const before = (await store.get(id))!;
      const stale = before.status !== "running" || clock.now() - Date.parse(before.updatedAt) >= STALE_MS;
      if (stale) {
        await queue.deliverAndKill(consume, () =>
          until(async () => (await store.get(id))?.attempt === before.attempt + 1, "claim"),
        );
        kinds.push("claimed, killed");
      } else {
        await queue.deliverNext(consume);
        kinds.push("deferred");
      }
    }
    expect(kinds).toEqual(["claimed, killed", "deferred", "deferred", "claimed, killed"]);
    expect(await store.get(id)).toMatchObject({ status: "running" });

    // The last kill happened just now: the dead-letter consumer waits.
    const wait = await dlq.deliverNext(consumeDead);
    expect(wait).toMatchObject({ result: "retry", delaySeconds: STALE_MS / 1000 });
    expect(await store.get(id)).toMatchObject({ status: "running" });

    expect(await dlq.deliverNext(consumeDead)).toMatchObject({ result: "ack" });
    expect(await store.get(id)).toMatchObject({ status: "dead" });
    expect((await store.get(id))?.errorMessage).toBe("The queue gave up after 2 attempts.");
  });

  it("a dead-letter message for a job a live delivery still runs lets the live run finish", async () => {
    const { store, clock, consumeDead } = setup(make, { async run() {} });
    const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
    await store.compareAndSet(job.id, 0, { status: "running", attempt: 1 });
    const acked: string[] = [];
    const retried: string[] = [];
    const message = (attempts: number) => ({
      body: { jobId: job.id },
      attempts,
      ack: () => void acked.push(`#${attempts}`),
      retry: () => void retried.push(`#${attempts}`),
    });
    for (let attempts = 1; attempts <= MAX_RETRIES + 1; attempts += 1) {
      clock.advance(10_000);
      const current = await store.get(job.id);
      await store.compareAndSet(job.id, current!.version, {}); // the live run's heartbeat
      await consumeDead({ queue: "jobs-dlq", messages: [message(attempts)] });
    }
    expect(retried).toEqual(["#1", "#2", "#3"]);
    expect(acked).toEqual(["#4"]);
    expect(await store.get(job.id)).toMatchObject({ status: "running" });
  });

  it("a user cancel during a run stops it: no retry, the job stays cancelled", async () => {
    const midRun = gate();
    const resume = gate();
    let caught: unknown;
    const { store, queue, consume, enqueue } = setup(make, {
      async run(run) {
        await run.progress("writing", 0.4);
        midRun.open();
        await resume.promise;
        try {
          await run.progress("writing", 0.8);
        } catch (error) {
          caught = error;
          throw error;
        }
        return { outputId: "never" };
      },
    });
    const id = await enqueue();
    const delivery = queue.deliverNext(consume);
    await midRun.promise;
    expect((await cancelJob(store, id)).kind).toBe("cancelled");
    resume.open();
    expect(await delivery).toMatchObject({ result: "ack" });
    expect((caught as Error).name).toBe("JobSupersededError");
    expect(await store.get(id)).toMatchObject({ status: "cancelled", progress: 0.4 });
    expect((await store.get(id))?.outputId).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it("a runner that ignores the cancel and returns still cannot complete the job", async () => {
    const { store, queue, consume, enqueue } = setup(make, {
      async run(run) {
        await cancelJob(store, run.job.id);
        return { outputId: "ignored" };
      },
    });
    const id = await enqueue();
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
    expect(await store.get(id)).toMatchObject({ status: "cancelled" });
  });

  it("fails a job of an unregistered kind for good", async () => {
    const { store, queue, consume } = setup(make, { async run() {} });
    const { job } = await store.create({ ownerId: "o", idempotencyKey: "k", kind: "extract" });
    queue.send(job.id);
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
    expect(await store.get(job.id)).toMatchObject({
      status: "failed",
      retryable: false,
      errorMessage: 'No runner is registered for job kind "extract".',
    });
  });

  it("acks a message whose job no longer exists", async () => {
    const { queue, consume } = setup(make, { async run() {} });
    queue.send("gone");
    expect(await queue.deliverNext(consume)).toMatchObject({ result: "ack" });
  });
});

describe("job consumer: finished-job listener", () => {
  function listening(runner: JobRunner, listener: (job: GenerationJob) => Promise<void>) {
    const t = setup(STORE_FACTORIES[0].make, runner);
    const options: JobConsumerOptions = { store: t.store, runners: { output: runner }, now: t.clock.now, heartbeatMs: 0, log: () => undefined, onFinished: listener };
    return { ...t, consume: (batch: JobQueueBatch) => handleJobBatch(batch, options) };
  }

  it("hears a job once it is done or failed for good, not while a retry is coming", async () => {
    const heard: string[] = [];
    let attempt = 0;
    const t = listening(
      {
        async run() {
          attempt += 1;
          if (attempt === 1) throw new Error("503");
          if (attempt === 2) return { outputId: "out" };
          throw new JobFailure("invalid", false);
        },
      },
      async (job) => void heard.push(`${job.id}:${job.status}`),
    );
    const done = await t.enqueue("a");
    expect(await t.queue.deliverNext(t.consume)).toMatchObject({ result: "retry" });
    expect(heard).toEqual([]);
    await t.queue.deliverNext(t.consume);
    expect(heard).toEqual([`${done}:done`]);
    const failed = await t.enqueue("b");
    await t.queue.deliverNext(t.consume);
    expect(heard).toEqual([`${done}:done`, `${failed}:failed`]);
  });

  it("hears a settled job again on a duplicate delivery, and retries the message when the listener throws", async () => {
    let calls = 0;
    const t = listening({ run: async () => ({}) }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("D1 hiccup");
    });
    const id = await t.enqueue();
    expect(await t.queue.deliverNext(t.consume)).toMatchObject({ result: "retry" });
    expect(await t.store.get(id)).toMatchObject({ status: "done" });
    expect(await t.queue.deliverNext(t.consume)).toMatchObject({ result: "ack" });
    expect(calls).toBe(2);
  });

  it("hears a job the dead-letter consumer ends", async () => {
    const heard: string[] = [];
    const t = setup(STORE_FACTORIES[0].make, { run: async () => ({}) });
    const id = await t.enqueue();
    t.dlq.send(id);
    await t.dlq.deliverNext((batch) =>
      handleDeadLetterBatch(batch, { store: t.store, now: t.clock.now, onFinished: async (job) => void heard.push(job.status) }),
    );
    expect(heard).toEqual(["dead"]);
  });
});

describe("job consumer: infrastructure", () => {
  it("retries the message when the store itself fails", async () => {
    const clock = new ManualClock();
    const broken: GenerationJobStore = {
      create: () => Promise.reject(new Error("D1 unavailable")),
      get: () => Promise.reject(new Error("D1 unavailable")),
      findByKey: () => Promise.reject(new Error("D1 unavailable")),
      compareAndSet: () => Promise.reject(new Error("D1 unavailable")),
    };
    const queue = new FakeQueue("jobs", clock, { maxRetries: 3 });
    queue.send("job-1");
    const logs: string[] = [];
    const record = await queue.deliverNext((batch) =>
      handleJobBatch(batch, { store: broken, runners: {}, now: clock.now, log: (line) => void logs.push(line) }),
    );
    expect(record.result).toBe("retry");
    expect(logs[0]).toContain("D1 unavailable");
  });

  it("writes heartbeats while a runner works and stops the run once it is cancelled", async () => {
    const [{ make }] = STORE_FACTORIES;
    const store = make(new ManualClock());
    // Real time here: the heartbeat is a real interval.
    const { job } = await store.create({ ownerId: "o", idempotencyKey: "k" });
    let versionsSeen = 0;
    const record: string[] = [];
    await handleJobBatch(
      {
        queue: "jobs",
        messages: [{ body: { jobId: job.id }, ack: () => void record.push("ack"), retry: () => void record.push("retry") }],
      },
      {
        store,
        heartbeatMs: 2,
        runners: {
          output: {
            async run(run) {
              await until(async () => ((await store.get(job.id))?.version ?? 0) >= 4, "heartbeats");
              versionsSeen = (await store.get(job.id))!.version;
              await cancelJob(store, job.id);
              // The next heartbeat sees the cancel and aborts the signal.
              await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve()));
              run.signal.throwIfAborted();
            },
          },
        },
      },
    );
    expect(versionsSeen).toBeGreaterThanOrEqual(4);
    expect(record).toEqual(["ack"]);
    expect(await store.get(job.id)).toMatchObject({ status: "cancelled" });
  });

  it("limits how many jobs of a batch run at once", async () => {
    const [{ make }] = STORE_FACTORIES;
    const store = make(new ManualClock());
    let active = 0;
    let peak = 0;
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await store.create({ ownerId: "o", idempotencyKey: `k${i}` })).job.id);
    await handleJobBatch(
      { queue: "jobs", messages: ids.map((jobId) => ({ body: { jobId }, ack: () => undefined, retry: () => undefined })) },
      {
        store,
        heartbeatMs: 0,
        runners: {
          output: {
            async run() {
              active += 1;
              peak = Math.max(peak, active);
              await new Promise((resolve) => setTimeout(resolve, 3));
              active -= 1;
            },
          },
        },
      },
    );
    expect(peak).toBe(2);
    for (const id of ids) expect((await store.get(id))?.status).toBe("done");
  });
});

describe("worker queue handler", () => {
  it("sends dead-letter batches to the dead-letter consumer and the rest to the job consumer", async () => {
    const db = createSqliteD1();
    const env = { RE_JOB_DB: db, RE_JOB_DEAD_LETTER_QUEUE: "re-byte-jobs-dlq" };
    const insert = (id: string, status: string, retryable = false) =>
      db.raw
        .prepare(
          "INSERT INTO generation_jobs (id, owner_id, idempotency_key, kind, status, retryable, created_at, updated_at) VALUES (?, 'o', ?, 'output', ?, ?, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        )
        .run(id, id, status, retryable ? 1 : 0);
    insert("queued-job", "queued");
    insert("failed-job", "failed", true);
    const settle: string[] = [];
    const message = (jobId: string) => ({
      body: { jobId },
      ack: () => void settle.push(`ack ${jobId}`),
      retry: () => void settle.push(`retry ${jobId}`),
    });

    await worker.queue({ queue: "re-byte-jobs", messages: [message("queued-job")] }, env);
    await worker.queue({ queue: "re-byte-jobs-dlq", messages: [message("failed-job")] }, env);

    // No runner is registered yet, so the main queue fails the job for good.
    const row = (id: string) => db.raw.prepare("SELECT status, error_message FROM generation_jobs WHERE id = ?").get(id);
    expect(row("queued-job")).toMatchObject({ status: "failed" });
    expect(row("failed-job")).toMatchObject({ status: "dead" });
    expect(settle).toEqual(["ack queued-job", "ack failed-job"]);
  });

  it("throws without a database so the batch is retried", async () => {
    await expect(worker.queue({ queue: "re-byte-jobs", messages: [] }, {})).rejects.toThrow(/RE_JOB_DB/);
  });
});
