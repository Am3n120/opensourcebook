/**
 * Test harness for the job store, lifecycle and consumers: a manual clock,
 * a store wrapper that runs code at an exact point between a writer's read
 * and its write, and a queue that behaves like Cloudflare Queues
 * (at-least-once, retry with delay, max_retries, dead-letter queue).
 */
import { D1GenerationJobStore } from "../../src/jobs/d1-store";
import type {
  CompareAndSetResult,
  GenerationJobPatch,
  GenerationJobStore,
  JobQueueBatch,
  JobQueueMessage,
} from "../../src/jobs/types";
import { InMemoryGenerationJobStore } from "./memory-job-store";
import { createSqliteD1 } from "./sqlite-d1";

export class ManualClock {
  constructor(private ms = Date.parse("2026-11-10T09:00:00.000Z")) {}
  now = (): number => this.ms;
  iso = (): string => new Date(this.ms).toISOString();
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceTo(ms: number): void {
    this.ms = Math.max(this.ms, ms);
  }
}

export interface StoreFactory {
  name: string;
  make(clock: ManualClock): GenerationJobStore;
}

let idCounter = 0;

export const STORE_FACTORIES: StoreFactory[] = [
  {
    name: "D1 (SQLite with the real migrations)",
    make: (clock) => new D1GenerationJobStore(createSqliteD1(), { now: clock.iso, newId: () => `d1-job-${++idCounter}` }),
  },
  { name: "in-memory", make: (clock) => new InMemoryGenerationJobStore({ now: clock.iso }) },
];

/**
 * Delegates to a real store. `beforeNextWrite(fn)` runs `fn` once, right
 * before the next compareAndSet reaches the store: the writer has already
 * read the row and chosen its expected version, and `fn` lands in between.
 */
export class InterleavingStore implements GenerationJobStore {
  private hooks: Array<() => Promise<unknown>> = [];
  readonly writes: Array<{ id: string; expectedVersion: number; patch: GenerationJobPatch; ok: boolean }> = [];

  constructor(readonly inner: GenerationJobStore) {}

  beforeNextWrite(fn: () => Promise<unknown>): void {
    this.hooks.push(fn);
  }

  create: GenerationJobStore["create"] = (input) => this.inner.create(input);
  get: GenerationJobStore["get"] = (id) => this.inner.get(id);
  findByKey: GenerationJobStore["findByKey"] = (ownerId, key) => this.inner.findByKey(ownerId, key);
  listByStatus: NonNullable<GenerationJobStore["listByStatus"]> = (statuses, limit) => this.inner.listByStatus?.(statuses, limit) ?? Promise.resolve([]);

  async compareAndSet(id: string, expectedVersion: number, patch: GenerationJobPatch): Promise<CompareAndSetResult> {
    const hook = this.hooks.shift();
    if (hook) await hook();
    const result = await this.inner.compareAndSet(id, expectedVersion, patch);
    this.writes.push({ id, expectedVersion, patch, ok: result.ok });
    return result;
  }
}

interface Pending {
  id: number;
  jobId: string;
  attempts: number;
  readyAt: number;
}

export interface DeliveryRecord {
  queue: string;
  jobId: string;
  attempts: number;
  result: "ack" | "retry" | "crash";
  delaySeconds?: number;
}

/**
 * One Cloudflare queue. A delivery is acked, retried (with optional delay)
 * or crashes (the handler throws or the isolate dies); retried and crashed
 * messages come back with attempts + 1 until they have been retried
 * `maxRetries` times, then go to the dead-letter queue.
 */
export class FakeQueue {
  private pending: Pending[] = [];
  private nextId = 1;
  readonly log: DeliveryRecord[] = [];

  constructor(
    readonly name: string,
    private readonly clock: ManualClock,
    private readonly options: { maxRetries: number; deadLetter?: FakeQueue },
  ) {}

  send(jobId: string): void {
    this.enqueue(jobId, 1, 0);
  }

  get size(): number {
    return this.pending.length;
  }

  /** When the next message is due; delivering it moves the clock there. */
  get nextReadyAt(): number | undefined {
    return this.pending[0]?.readyAt;
  }

  private enqueue(jobId: string, attempts: number, delaySeconds: number): void {
    this.pending.push({ id: this.nextId++, jobId, attempts, readyAt: this.clock.now() + delaySeconds * 1000 });
    this.pending.sort((a, b) => a.readyAt - b.readyAt || a.id - b.id);
  }

  private requeue(message: Pending, delaySeconds: number): void {
    if (message.attempts > this.options.maxRetries) {
      this.options.deadLetter?.enqueue(message.jobId, 1, 0);
      return;
    }
    this.enqueue(message.jobId, message.attempts + 1, delaySeconds);
  }

  /** Takes the next message (moving the clock to when it is due) and runs `handler` on it. */
  async deliverNext(handler: (batch: JobQueueBatch) => Promise<void>): Promise<DeliveryRecord> {
    const message = this.pending.shift();
    if (!message) throw new Error(`${this.name} is empty`);
    this.clock.advanceTo(message.readyAt);
    let settled: { kind: "ack" } | { kind: "retry"; delaySeconds?: number } | undefined;
    const queueMessage: JobQueueMessage = {
      body: { jobId: message.jobId },
      attempts: message.attempts,
      ack: () => void (settled ??= { kind: "ack" }),
      retry: (options) => void (settled ??= { kind: "retry", delaySeconds: options?.delaySeconds }),
    };
    let crashed = false;
    try {
      await handler({ queue: this.name, messages: [queueMessage] });
    } catch {
      crashed = true;
    }
    let record: DeliveryRecord;
    if (crashed) {
      record = { queue: this.name, jobId: message.jobId, attempts: message.attempts, result: "crash" };
      this.requeue(message, 0);
    } else if (settled?.kind === "retry") {
      record = { queue: this.name, jobId: message.jobId, attempts: message.attempts, result: "retry", delaySeconds: settled.delaySeconds };
      this.requeue(message, settled.delaySeconds ?? 0);
    } else {
      // Returning without an explicit call acks, as in Cloudflare Queues.
      record = { queue: this.name, jobId: message.jobId, attempts: message.attempts, result: "ack" };
    }
    this.log.push(record);
    return record;
  }

  /**
   * The isolate dies while `handler` is still running (an OOM, a deploy):
   * the handler is started, allowed to get as far as `untilSettled`, and the
   * message is redelivered as if it had crashed. The handler's promise is
   * left behind, as a killed isolate's would be.
   */
  async deliverAndKill(handler: (batch: JobQueueBatch) => Promise<void>, untilSettled: () => Promise<void>): Promise<DeliveryRecord> {
    const message = this.pending.shift();
    if (!message) throw new Error(`${this.name} is empty`);
    this.clock.advanceTo(message.readyAt);
    const queueMessage: JobQueueMessage = {
      body: { jobId: message.jobId },
      attempts: message.attempts,
      ack: () => undefined,
      retry: () => undefined,
    };
    void handler({ queue: this.name, messages: [queueMessage] });
    await untilSettled();
    const record: DeliveryRecord = { queue: this.name, jobId: message.jobId, attempts: message.attempts, result: "crash" };
    this.requeue(message, 0);
    this.log.push(record);
    return record;
  }
}

/** Resolves once `predicate` holds, polling on the microtask/macrotask queue. */
export async function until(predicate: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A promise with its resolve exposed, for runners that must stop at a known point. */
export function gate<T = void>(): { promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}
