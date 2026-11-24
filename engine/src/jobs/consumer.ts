/**
 * Queue consumers for generation jobs.
 *
 * The main consumer claims each delivered job and hands it to the runner
 * registered for its kind. Three August bugs are fixed here:
 *   - a retryable failure is written as `failed`, the message is retried,
 *     and the redelivery claims and runs it again (August acked it);
 *   - a cancel is never undone: the run's writes are fenced (lifecycle.ts);
 *   - a message the queue gives up on reaches the dead-letter consumer, which
 *     marks the job `dead` instead of leaving it `running`.
 */
import { accountProblem, isFinalProviderError } from "../net";
import { failureCodeOf, failureSaidOf } from "./failure-words";
import { JobFailure, JobSupersededError, claimJob, markDead, type ClaimOptions, type JobRun } from "./lifecycle";
import type { GenerationJob, GenerationJobStore, JobQueueBatch, JobQueueMessage } from "./types";
import { JobWait } from "./waits";

/**
 * The jobs this isolate is running now. A job left `running` that is not in
 * here and has gone quiet is one nothing runs any more (the engine restarted
 * under it): the keeper (`keeper.ts`) carries it on. One that is in here is
 * alive whatever the clock says, as after the computer slept.
 */
const RUNNING_HERE = new Set<string>();

export function isRunningHere(jobId: string): boolean {
  return RUNNING_HERE.has(jobId);
}

export interface JobRunResult {
  outputId?: string;
}

/** Does the work of one kind of job. Throw `JobFailure` to say whether a retry can help. */
export interface JobRunner {
  run(run: JobRun): Promise<JobRunResult | void>;
}

export interface JobConsumerOptions {
  store: GenerationJobStore;
  /** Runner per job kind. A kind with no runner fails for good. */
  runners: Readonly<Record<string, JobRunner>>;
  now?: () => number;
  /** A running job silent for this long is presumed dead and may be taken over. */
  staleAfterMs?: number;
  /** How often a run's heartbeat is written while the runner works; 0 turns it off. */
  heartbeatMs?: number;
  /** Jobs run at once per batch. Two kept August's PDF-heavy runs under the memory limit. */
  concurrency?: number;
  /** Delay before a busy job's duplicate delivery is looked at again. */
  busyRetryDelaySeconds?: number;
  /** Delay before a failed attempt is redelivered. */
  retryDelaySeconds?: (attempt: number) => number;
  log?: (message: string) => void;
  /**
   * Called once a job will not run again (done, failed for good, cancelled,
   * dead), and again whenever a delivery of such a job arrives, so a listener
   * that failed the first time gets another chance. Listeners must be
   * idempotent. If it throws, the message is retried.
   */
  onFinished?: (job: GenerationJob) => Promise<void>;
}

export const DEFAULT_STALE_AFTER_MS = 120_000;

const defaultRetryDelay = (attempt: number) => Math.min(300, 15 * 2 ** Math.max(0, attempt - 1));

export async function handleJobBatch(batch: JobQueueBatch, options: JobConsumerOptions): Promise<void> {
  await mapBounded(batch.messages, options.concurrency ?? 2, async (message) => {
    try {
      await handleJobMessage(message, options);
    } catch (error) {
      // The store itself failed (D1 unavailable, a CAS that never settled).
      // Nothing was decided, so let the queue deliver it again.
      (options.log ?? ((line: string) => console.warn(line)))(
        `Job ${message.body.jobId}: delivery failed before it settled: ${error instanceof Error ? error.message : String(error)}`,
      );
      message.retry();
    }
  });
}

async function handleJobMessage(message: JobQueueMessage, options: JobConsumerOptions): Promise<void> {
  const claimOptions = claimOptionsFrom(options);
  const log = options.log ?? ((line: string) => console.warn(line));
  const outcome = await claimJob(options.store, message.body.jobId, claimOptions);

  switch (outcome.kind) {
    case "missing":
      message.ack();
      return;
    case "final":
    case "failed":
      // A duplicate or late delivery: the job is settled, but whoever listens
      // for that may not have heard it yet.
      await options.onFinished?.(outcome.job);
      message.ack();
      return;
    case "busy":
      message.retry({ delaySeconds: options.busyRetryDelaySeconds ?? 60 });
      return;
    case "waiting":
      // Not due yet: the keeper brings it back when it is, so this message is done.
      message.ack();
      return;
    case "claimed":
      break;
  }

  const { run } = outcome;
  const runner = options.runners[run.job.kind];
  if (!runner) {
    await settle(run.fail(`No runner is registered for job kind "${run.job.kind}".`, false));
    await options.onFinished?.(run.job);
    message.ack();
    return;
  }

  const stopHeartbeat = startHeartbeat(run, options.heartbeatMs ?? claimOptions.staleAfterMs / 4);
  RUNNING_HERE.add(run.job.id);
  try {
    await runClaimed(run, runner, message, options, stopHeartbeat, log);
  } finally {
    RUNNING_HERE.delete(run.job.id);
  }
}

async function runClaimed(run: JobRun, runner: JobRunner, message: JobQueueMessage, options: JobConsumerOptions, stopHeartbeat: () => void, log: (line: string) => void): Promise<void> {
  let finished: GenerationJob;
  try {
    const result = await runner.run(run);
    stopHeartbeat();
    finished = await run.complete(result ?? {});
  } catch (error) {
    stopHeartbeat();
    if (isSuperseded(error, run)) {
      // Cancelled, dead-lettered or taken over: whoever did that owns the row now.
      message.ack();
      return;
    }
    if (error instanceof JobWait) {
      // The maker went quiet or the agent is at its limit: what was made is kept and the keeper carries it on.
      try {
        finished = await run.wait(error);
      } catch (waitError) {
        if (isSuperseded(waitError, run)) {
          message.ack();
          return;
        }
        throw waitError;
      }
      log(`Job ${run.job.id} attempt ${run.attempt} waits (${error.reason}): ${error.message}`);
      if (finished.status === "waiting") {
        message.ack();
        return;
      }
      await options.onFinished?.(finished);
      message.ack();
      return;
    }
    // A refused model account (out of credit, bad key) fails once, in plain words: a redelivery would meet it again.
    const account = accountProblem(error);
    const retryable = error instanceof JobFailure ? error.retryable : !isFinalProviderError(error);
    const reason = account ?? (error instanceof Error ? error.message : String(error));
    try {
      finished = await run.fail(reason, retryable, failureCodeOf(error), failureSaidOf(error));
    } catch (failError) {
      if (isSuperseded(failError, run)) {
        message.ack();
        return;
      }
      throw failError;
    }
    log(`Job ${run.job.id} attempt ${run.attempt} failed (${retryable ? "will retry" : "final"}): ${reason}`);
    if (retryable) {
      message.retry({ delaySeconds: (options.retryDelaySeconds ?? defaultRetryDelay)(run.attempt) });
      return;
    }
  }
  // Outside the try: a listener that throws gets the message retried, and
  // the redelivery (seeing a settled job) calls it again.
  await options.onFinished?.(finished);
  message.ack();
}

export interface DeadLetterOptions {
  store: GenerationJobStore;
  now?: () => number;
  staleAfterMs?: number;
  /**
   * Deliveries of a dead-letter message before it is let go. A job still
   * running with a fresh heartbeat by then belongs to a live delivery.
   */
  maxDeliveries?: number;
  /** Called with a job this consumer marked dead, or found already settled. */
  onFinished?: (job: GenerationJob) => Promise<void>;
}

/**
 * Consumer for the dead-letter queue. A job whose message arrives here will
 * never be redelivered, so it is marked `dead`. One exception: a job that is
 * running and writing heartbeats is either owned by another, live delivery
 * or died moments ago; the message is retried until the heartbeat can have
 * gone stale.
 */
export async function handleDeadLetterBatch(batch: JobQueueBatch, options: DeadLetterOptions): Promise<void> {
  const claimOptions = claimOptionsFrom(options);
  const maxDeliveries = options.maxDeliveries ?? 3;
  for (const message of batch.messages) {
    const outcome = await markDead(options.store, message.body.jobId, claimOptions);
    if (outcome.kind === "busy" && (message.attempts ?? 1) < maxDeliveries) {
      message.retry({ delaySeconds: Math.ceil(claimOptions.staleAfterMs / 1000) });
      continue;
    }
    if (outcome.kind === "dead" || outcome.kind === "unchanged") await options.onFinished?.(outcome.job);
    message.ack();
  }
}

function claimOptionsFrom(options: { now?: () => number; staleAfterMs?: number }): ClaimOptions {
  return { now: options.now ?? Date.now, staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS };
}

function isSuperseded(error: unknown, run: JobRun): boolean {
  return error instanceof JobSupersededError || (run.signal.aborted && run.signal.reason instanceof JobSupersededError);
}

function startHeartbeat(run: JobRun, intervalMs: number): () => void {
  if (!(intervalMs > 0)) return () => undefined;
  // A failed or superseded heartbeat needs no handling here: superseding
  // aborts the run's signal and the runner's next write throws.
  const timer = setInterval(() => void run.heartbeat().catch(() => undefined), intervalMs);
  return () => clearInterval(timer);
}

async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof JobSupersededError)) throw error;
  }
}

async function mapBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
