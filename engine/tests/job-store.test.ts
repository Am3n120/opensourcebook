import { describe, expect, it } from "vitest";
import { D1GenerationJobStore } from "../src/jobs/d1-store";
import { ManualClock, STORE_FACTORIES } from "./support/job-harness";
import { createSqliteD1, migrationFiles } from "./support/sqlite-d1";

describe.each(STORE_FACTORIES)("GenerationJobStore: $name", ({ make }) => {
  it("creates a queued job with defaults", async () => {
    const clock = new ManualClock();
    const store = make(clock);
    const { job, created } = await store.create({
      ownerId: "owner-1",
      idempotencyKey: "key-1",
      type: "byte",
      nodeId: "node-1",
      input: { sourceText: "hello", nested: { n: 1, list: [true, null] } },
    });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      ownerId: "owner-1",
      idempotencyKey: "key-1",
      kind: "output",
      type: "byte",
      nodeId: "node-1",
      status: "queued",
      stage: "queued",
      progress: 0,
      attempt: 0,
      version: 0,
      retryable: false,
      input: { sourceText: "hello", nested: { n: 1, list: [true, null] } },
      state: {},
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    expect(job.projectId).toBeUndefined();
    expect(job.errorMessage).toBeUndefined();
    expect(await store.get(job.id)).toEqual(job);
  });

  it("returns the first job for a repeated idempotency key, per owner", async () => {
    const store = make(new ManualClock());
    const first = await store.create({ ownerId: "a", idempotencyKey: "k", input: { n: 1 } });
    const again = await store.create({ ownerId: "a", idempotencyKey: "k", input: { n: 2 } });
    const otherOwner = await store.create({ ownerId: "b", idempotencyKey: "k" });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.input).toEqual({ n: 1 });
    expect(otherOwner.created).toBe(true);
    expect(otherOwner.job.id).not.toBe(first.job.id);
  });

  it("finds a job by its owner and idempotency key", async () => {
    const store = make(new ManualClock());
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    expect(await store.findByKey("a", "k")).toEqual(job);
    expect(await store.findByKey("b", "k")).toBeUndefined();
    expect(await store.findByKey("a", "other")).toBeUndefined();
  });

  it("applies a write at the expected version and bumps version and updatedAt", async () => {
    const clock = new ManualClock();
    const store = make(clock);
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    clock.advance(1_000);
    const result = await store.compareAndSet(job.id, 0, {
      status: "running",
      stage: "writing",
      progress: 0.4,
      attempt: 1,
      retryable: true,
      errorMessage: "transient",
      state: { blueprint: { sections: ["a", "b"] } },
      startedAt: clock.iso(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job).toMatchObject({
      status: "running",
      stage: "writing",
      progress: 0.4,
      attempt: 1,
      retryable: true,
      errorMessage: "transient",
      state: { blueprint: { sections: ["a", "b"] } },
      version: 1,
      startedAt: clock.iso(),
      updatedAt: clock.iso(),
      createdAt: job.createdAt,
    });
    expect(await store.get(job.id)).toEqual(result.job);
  });

  it("rejects a write at a stale version and returns the current row untouched", async () => {
    const store = make(new ManualClock());
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    const winner = await store.compareAndSet(job.id, 0, { status: "cancelled" });
    expect(winner.ok).toBe(true);
    const loser = await store.compareAndSet(job.id, 0, { status: "running", progress: 0.9 });
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.current).toMatchObject({ status: "cancelled", progress: 0, version: 1 });
    expect(await store.get(job.id)).toMatchObject({ status: "cancelled", version: 1 });
  });

  it("clears nullable fields with null and ignores undefined ones", async () => {
    const store = make(new ManualClock());
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    const failed = await store.compareAndSet(job.id, 0, { errorMessage: "boom", finishedAt: "2026-11-10T09:00:00.000Z", outputId: "out-1" });
    expect(failed.ok).toBe(true);
    const cleared = await store.compareAndSet(job.id, 1, { errorMessage: null, finishedAt: null, stage: undefined });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.job.errorMessage).toBeUndefined();
    expect(cleared.job.finishedAt).toBeUndefined();
    expect(cleared.job.outputId).toBe("out-1");
    expect(cleared.job.stage).toBe("queued");
  });

  it("treats an empty patch as a heartbeat", async () => {
    const clock = new ManualClock();
    const store = make(clock);
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    clock.advance(5_000);
    const beat = await store.compareAndSet(job.id, 0, {});
    expect(beat.ok && beat.job.updatedAt).toBe(clock.iso());
    expect(beat.ok && beat.job.version).toBe(1);
  });

  it("reports a missing job as not found on read and write", async () => {
    const store = make(new ManualClock());
    expect(await store.get("nope")).toBeUndefined();
    expect(await store.compareAndSet("nope", 0, { status: "running" })).toEqual({ ok: false });
  });
});

describe("D1GenerationJobStore specifics", () => {
  it("writes with one conditional UPDATE, never an unconditional upsert", async () => {
    const db = createSqliteD1();
    const store = new D1GenerationJobStore(db);
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    await store.compareAndSet(job.id, 0, { progress: 0.5 });
    const writes = db.statements.filter((sql) => /^\s*(UPDATE|INSERT)/i.test(sql));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatch(/^UPDATE generation_jobs SET progress = \?, version = version \+ 1, updated_at = \? WHERE id = \? AND version = \? RETURNING \*$/);
    expect(writes[0]).toMatch(/ON CONFLICT \(owner_id, idempotency_key\) DO NOTHING RETURNING \*/);
  });

  it("is idempotent across two store instances on one database (two isolates)", async () => {
    const db = createSqliteD1();
    const a = new D1GenerationJobStore(db);
    const b = new D1GenerationJobStore(db);
    const [first, second] = await Promise.all([
      a.create({ ownerId: "o", idempotencyKey: "same" }),
      b.create({ ownerId: "o", idempotencyKey: "same" }),
    ]);
    expect(first.job.id).toBe(second.job.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM generation_jobs").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("keeps the August tables, which the deployed database already has", () => {
    expect(migrationFiles().slice(0, 3)).toEqual([
      "0001_create_jobs.sql",
      "0002_create_assets.sql",
      "0003_generation_jobs.sql",
    ]);
    const db = createSqliteD1({ upTo: "0003_generation_jobs.sql" });
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((row) => row.name);
    expect(tables).toEqual(["assets", "generation_jobs", "jobs"]);
  });

  it("refuses a row whose status is not one the code knows", async () => {
    const db = createSqliteD1();
    const store = new D1GenerationJobStore(db);
    const { job } = await store.create({ ownerId: "a", idempotencyKey: "k" });
    db.raw.prepare("UPDATE generation_jobs SET status = 'paused' WHERE id = ?").run(job.id);
    await expect(store.get(job.id)).rejects.toThrow(/unknown status "paused"/);
  });
});
