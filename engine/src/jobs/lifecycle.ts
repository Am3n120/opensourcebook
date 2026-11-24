/**
 * Job state transitions, all on top of `compareAndSet`. Each one reads the
 * row, decides, and writes against the version it read; when another writer
 * got there first it re-reads and decides again from the new row. That is
 * what keeps a cancel (or the dead-letter consumer, or a newer attempt) from
 * being overwritten by a running job's progress write.
 *
 *   queued ──claim──▶ running ──complete──▶ done
 *     ▲                 │  ├──fail(retryable)──▶ failed ──claim (redelivery)──▶ running
 *     │                 │  └──fail(final)──────▶ failed (stays)
 *     ├──retry── failed/dead            cancel: queued/running/failed ──▶ cancelled
 *     └──resume of its plan── cancelled
 *                                       dead letter: queued/stale running/failed ──▶ dead
 *
 *   running ──wait (maker gone quiet, agent at its limit)──▶ waiting ──claim when due──▶ running
 *   running, not run anywhere, silent ──orphan──▶ waiting      waiting past its patience ──giveUp──▶ failed
 *   waiting ──wake (the person's "try now")──▶ due now           cancel works on waiting too
 */
import type { GenerationJob, GenerationJobPatch, GenerationJobStore, JsonObject } from "./types";
import type { JsonValue } from "../studio/types";
import { withFailureCode, type JobFailureCode } from "./failure-words";
import { isDue, nextWait, readChoice, waitOf, withWait, type JobWait, type JobWaitState, type WaitChoice } from "./waits";

/** A writer that keeps losing the race this many times gives up loudly. */
const MAX_CAS_ATTEMPTS = 16;

/** Statuses nothing moves a job out of, except a manual retry of `dead`. */
export function isFinal(job: GenerationJob): boolean {
  return job.status === "done" || job.status === "cancelled" || job.status === "dead";
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} does not exist.`);
    this.name = "JobNotFoundError";
  }
}

/**
 * Thrown inside a run once the row says the run no longer owns the job: it
 * was cancelled, dead-lettered, or claimed by a newer attempt. The run must
 * stop and write nothing more.
 */
export class JobSupersededError extends Error {
  constructor(readonly job: GenerationJob, readonly attempt: number) {
    super(
      job.status === "running"
        ? `Job ${job.id} attempt ${attempt} was superseded by attempt ${job.attempt}.`
        : `Job ${job.id} is ${job.status}; attempt ${attempt} stops.`,
    );
    this.name = "JobSupersededError";
  }
}

/**
 * A failure with an explicit verdict. Anything else thrown by a runner counts
 * as retryable. `failureCode` names the cause, which picks the plain line a
 * person reads (./failure-words); the message is the technical text.
 */
export class JobFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureCode?: JobFailureCode,
    /** The agent's own words on why it failed, for the person (`agent_error`). */
    readonly said?: string,
  ) {
    super(message);
    this.name = "JobFailure";
  }
}

/**
 * The person's agent ended in an error of its own before it did any work (a
 * model its account does not offer, a setting it refused): final, since the
 * same turn again meets the same error, and said as that with its own words
 * when it gave some. Every maker that runs the person's agent fails this way.
 */
export function agentErrorFailure(message: string, said?: string): JobFailure {
  const words = said?.trim() ? said.trim().slice(0, 300) : undefined;
  return new JobFailure(message, false, "agent_error", words);
}

type Decision<R> = { write: GenerationJobPatch; then: (job: GenerationJob) => R } | { result: R };

/** Read, decide, compare-and-set; on a lost race decide again from the fresh row. */
async function transition<R>(
  store: GenerationJobStore,
  id: string,
  decide: (job: GenerationJob) => Decision<R>,
  first?: GenerationJob,
): Promise<R> {
  let current = first ?? (await store.get(id));
  for (let tries = 0; tries < MAX_CAS_ATTEMPTS; tries += 1) {
    if (!current) throw new JobNotFoundError(id);
    const decision = decide(current);
    if ("result" in decision) return decision.result;
    const written = await store.compareAndSet(id, current.version, decision.write);
    if (written.ok) return decision.then(written.job);
    current = written.current;
  }
  throw new Error(`Job ${id}: gave up after ${MAX_CAS_ATTEMPTS} conflicting writes.`);
}

export interface ClaimOptions {
  now: () => number;
  /** A running job whose last write is older than this is presumed dead. */
  staleAfterMs: number;
}

export type ClaimOutcome =
  | { kind: "claimed"; run: JobRun }
  /** done, cancelled or dead: nothing to do. */
  | { kind: "final"; job: GenerationJob }
  /** failed and not retryable. */
  | { kind: "failed"; job: GenerationJob }
  /** Another consumer is running it and has written recently. */
  | { kind: "busy"; job: GenerationJob }
  /** It waits, and is not due yet: the keeper brings it back when it is. */
  | { kind: "waiting"; job: GenerationJob }
  | { kind: "missing" };

/**
 * Called for every queue delivery. A queued job, a failed retryable job (the
 * queue redelivering after `fail`) and a running job with a stale heartbeat
 * (its consumer died) are all claimed as a new attempt. Saved `state` is kept
 * so the attempt resumes.
 */
export async function claimJob(store: GenerationJobStore, id: string, options: ClaimOptions): Promise<ClaimOutcome> {
  try {
    return await transition<ClaimOutcome>(store, id, (job) => {
      if (isFinal(job)) return { result: { kind: "final", job } };
      if (job.status === "failed" && !job.retryable) return { result: { kind: "failed", job } };
      if (job.status === "running" && options.now() - Date.parse(job.updatedAt) < options.staleAfterMs) {
        return { result: { kind: "busy", job } };
      }
      if (job.status === "waiting" && !isDue(job, options.now())) return { result: { kind: "waiting", job } };
      return {
        write: {
          status: "running",
          stage: "starting",
          progress: 0,
          attempt: job.attempt + 1,
          retryable: false,
          errorMessage: null,
          startedAt: new Date(options.now()).toISOString(),
          finishedAt: null,
        },
        then: (claimed) => ({ kind: "claimed", run: new JobRun(store, claimed, options.now) }),
      };
    });
  } catch (error) {
    if (error instanceof JobNotFoundError) return { kind: "missing" };
    throw error;
  }
}

/**
 * One attempt's handle on a job. Every write is fenced on (status running,
 * this attempt): if the row moved on, the write is dropped, the signal is
 * aborted and `JobSupersededError` is thrown.
 */
export class JobRun {
  readonly attempt: number;
  private snapshot: GenerationJob;
  private readonly controller = new AbortController();

  constructor(
    private readonly store: GenerationJobStore,
    claimed: GenerationJob,
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = claimed;
    this.attempt = claimed.attempt;
  }

  get job(): GenerationJob {
    return this.snapshot;
  }

  /** Aborted once this attempt loses the job. Engines pass it down. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Progress never moves backwards within the attempt. */
  progress(stage: string, progress: number): Promise<GenerationJob> {
    return this.write((job) => ({ stage, progress: Math.max(job.progress, clamp01(progress)) }));
  }

  /** Writes nothing but a fresh `updatedAt`, so the job does not look abandoned. */
  heartbeat(): Promise<GenerationJob> {
    return this.write(() => ({}));
  }

  /** Saves one step's result so a later attempt can skip the step. */
  saveState(key: string, value: JsonValue): Promise<GenerationJob> {
    return this.write((job) => ({ state: { ...job.state, [key]: value } }));
  }

  /**
   * Saves one entry of an object kept in state (`state[key][field]`). Read
   * and written against the current row, so entries saved at the same time by
   * parallel work in this attempt all land.
   */
  saveStateEntry(key: string, field: string, value: JsonValue): Promise<GenerationJob> {
    return this.write((job) => {
      const current = job.state[key];
      const entries = current && typeof current === "object" && !Array.isArray(current) ? current : {};
      return { state: { ...job.state, [key]: { ...entries, [field]: value } } };
    });
  }

  complete(result: { outputId?: string; state?: JsonObject } = {}): Promise<GenerationJob> {
    return this.write((job) => ({
      status: "done",
      stage: "done",
      progress: 1,
      retryable: false,
      errorMessage: null,
      finishedAt: new Date(this.now()).toISOString(),
      ...(result.outputId ? { outputId: result.outputId } : {}),
      state: withWait(result.state ? { ...job.state, ...result.state } : job.state, undefined),
    }));
  }

  /**
   * The maker went quiet or the agent is at its limit: the job waits, with
   * what it made kept, and is carried on when it is due. Past its patience it
   * fails instead, as `wait.code`, still keeping what was made. Answers the
   * row as written.
   */
  wait(wait: JobWait): Promise<GenerationJob> {
    return this.write((job) => {
      const next = nextWait(waitOf(job), wait.reason, wait.code, wait.limit, this.now(), wait.more);
      if (!next) return failedPatch(job, wait.message, wait.code, this.now(), waitOf(job));
      return { status: "waiting", stage: "waiting", retryable: true, errorMessage: wait.message, state: withWait(withFailureCode(job.state, undefined), next) };
    });
  }

  /** `message` is the technical text (log, `errorDetail`); `code` picks what the person reads, with `said`, the agent's own words, when it gave some. */
  fail(message: string, retryable: boolean, code?: JobFailureCode, said?: string): Promise<GenerationJob> {
    return this.write((job) => ({
      status: "failed",
      retryable,
      errorMessage: message,
      state: withWait(withFailureCode(job.state, code, said), undefined),
      finishedAt: new Date(this.now()).toISOString(),
    }));
  }

  private async write(build: (job: GenerationJob) => GenerationJobPatch): Promise<GenerationJob> {
    this.signal.throwIfAborted();
    try {
      const job = await transition(
        this.store,
        this.snapshot.id,
        (current) => {
          if (current.status !== "running" || current.attempt !== this.attempt) {
            throw new JobSupersededError(current, this.attempt);
          }
          return { write: build(current), then: (written) => written };
        },
        this.snapshot,
      );
      this.snapshot = job;
      return job;
    } catch (error) {
      if (error instanceof JobSupersededError) this.controller.abort(error);
      throw error;
    }
  }
}

export type CancelOutcome =
  | { kind: "cancelled"; job: GenerationJob }
  /** Already cancelled or dead; cancelling again is a no-op. */
  | { kind: "unchanged"; job: GenerationJob }
  | { kind: "done"; job: GenerationJob };

export function cancelJob(store: GenerationJobStore, id: string, now: () => number = Date.now): Promise<CancelOutcome> {
  return transition<CancelOutcome>(store, id, (job) => {
    if (job.status === "done") return { result: { kind: "done", job } };
    if (job.status === "cancelled" || job.status === "dead") return { result: { kind: "unchanged", job } };
    return {
      write: { status: "cancelled", retryable: false, finishedAt: new Date(now()).toISOString() },
      then: (cancelled) => ({ kind: "cancelled", job: cancelled }),
    };
  });
}

export type RetryOutcome = { kind: "queued"; job: GenerationJob } | { kind: "refused"; job: GenerationJob };

/**
 * A user's retry: a retryable failure, or a job the queue gave up on, goes
 * back to queued. The caller enqueues it. Saved state is kept.
 */
export function retryJob(store: GenerationJobStore, id: string): Promise<RetryOutcome> {
  return transition<RetryOutcome>(store, id, (job) => {
    const allowed = job.status === "dead" || (job.status === "failed" && job.retryable);
    if (!allowed) return { result: { kind: "refused", job } };
    return {
      write: { status: "queued", stage: "queued", progress: 0, errorMessage: null, finishedAt: null, state: withWait(job.state, undefined) },
      then: (queued) => ({ kind: "queued", job: queued }),
    };
  });
}

/**
 * The person asks for a failed plan item again: its job goes back to queued
 * whatever the failure was (they may have fixed what made it fail, such as
 * the model account). Saved state is kept, so finished steps are not paid
 * for twice. The caller enqueues it.
 */
export function requeueFailedJob(store: GenerationJobStore, id: string): Promise<RetryOutcome> {
  return transition<RetryOutcome>(store, id, (job) => {
    if (job.status !== "failed" && job.status !== "dead") return { result: { kind: "refused", job } };
    return {
      write: { status: "queued", stage: "queued", progress: 0, errorMessage: null, finishedAt: null, retryable: true, state: withWait(job.state, undefined) },
      then: (queued) => ({ kind: "queued", job: queued }),
    };
  });
}

/**
 * A stopped plan is started again: a job cancelled with it goes back to
 * queued. Saved state is kept, so finished steps are not paid for twice.
 * The caller enqueues it.
 */
export function requeueCancelledJob(store: GenerationJobStore, id: string): Promise<RetryOutcome> {
  return transition<RetryOutcome>(store, id, (job) => {
    if (job.status !== "cancelled") return { result: { kind: "refused", job } };
    return {
      write: { status: "queued", stage: "queued", progress: 0, errorMessage: null, finishedAt: null, retryable: true },
      then: (queued) => ({ kind: "queued", job: queued }),
    };
  });
}

export type ResetOutcome = { kind: "reset"; job: GenerationJob } | { kind: "refused"; job: GenerationJob };

/**
 * A cancelled or failed job's item gets another maker (a stopped plan's
 * "Change maker for what's left"): its input is replaced and its saved
 * steps cleared, since they were the old maker's. Only from cancelled or
 * failed (and dead, which a failure becomes); it stays as it is, so nothing
 * starts until the plan is resumed or the item retried.
 */
export function resetJobForNewMaker(store: GenerationJobStore, id: string, input: JsonObject): Promise<ResetOutcome> {
  return transition<ResetOutcome>(store, id, (job) => {
    if (job.status !== "cancelled" && job.status !== "failed" && job.status !== "dead") return { result: { kind: "refused", job } };
    return {
      write: { input, state: {}, attempt: 0 },
      then: (reset) => ({ kind: "reset", job: reset }),
    };
  });
}

export type DeadLetterOutcome =
  | { kind: "dead"; job: GenerationJob }
  /** Already final, or failed for good: left as it is. */
  | { kind: "unchanged"; job: GenerationJob }
  /**
   * Running with a fresh heartbeat. Another delivery of the same job still
   * owns it (a duplicate message gave up, not the run), or the run died a
   * moment ago; the caller checks again once the heartbeat can go stale.
   */
  | { kind: "busy"; job: GenerationJob }
  | { kind: "missing" };

/**
 * The dead-letter consumer's write: the queue has given up, so the job will
 * not be redelivered. It ends `dead` instead of sitting in queued, failed or
 * running forever.
 */
export async function markDead(store: GenerationJobStore, id: string, options: ClaimOptions): Promise<DeadLetterOutcome> {
  try {
    return await transition<DeadLetterOutcome>(store, id, (job) => {
      // A waiting job is the keeper's: the queue giving up on a message of it changes nothing.
      if (isFinal(job) || job.status === "waiting" || (job.status === "failed" && !job.retryable)) return { result: { kind: "unchanged", job } };
      if (job.status === "running" && options.now() - Date.parse(job.updatedAt) < options.staleAfterMs) {
        return { result: { kind: "busy", job } };
      }
      const lastError = job.errorMessage ? ` Last error: ${job.errorMessage}` : "";
      return {
        write: {
          status: "dead",
          retryable: false,
          errorMessage: `The queue gave up after ${job.attempt} attempt${job.attempt === 1 ? "" : "s"}.${lastError}`,
          finishedAt: new Date(options.now()).toISOString(),
        },
        then: (dead) => ({ kind: "dead", job: dead }),
      };
    });
  } catch (error) {
    if (error instanceof JobNotFoundError) return { kind: "missing" };
    throw error;
  }
}

export type KeepOutcome = { kind: "moved"; job: GenerationJob } | { kind: "unchanged"; job: GenerationJob } | { kind: "missing" };

/**
 * A job left `running` that nothing runs any more (the engine restarted
 * under it, or its run died) and that has been silent for `quietMs`: it
 * waits to be carried on, as after any restart, counting toward the bound.
 */
export async function orphanJob(store: GenerationJobStore, id: string, options: { now: () => number; quietMs: number }): Promise<KeepOutcome> {
  return keep(store, id, (job) => {
    if (job.status !== "running" || options.now() - Date.parse(job.updatedAt) < options.quietMs) return undefined;
    const next = nextWait(waitOf(job), "restart", "agent_dropped", {}, options.now());
    const message = "Nothing was running this item any more: the engine restarted while it was being made.";
    if (!next) return failedPatch(job, message, waitOf(job)?.code ?? "agent_dropped", options.now(), waitOf(job));
    // Carried on at once: the silence was the wait that showed it was gone.
    return { status: "waiting", stage: "waiting", retryable: true, errorMessage: message, state: withWait(job.state, { ...next, nextAt: new Date(options.now()).toISOString() }) };
  });
}

/** A waiting job still at its agent's limit when it was checked again: it waits longer (or is given up on). */
export async function waitLonger(store: GenerationJobStore, id: string, limit: { resetsAt?: string; resets?: string }, now: () => number): Promise<KeepOutcome> {
  return keep(store, id, (job) => {
    const wait = waitOf(job);
    if (job.status !== "waiting" || !wait) return undefined;
    const next = nextWait(wait, wait.reason, wait.code, limit, now());
    if (!next) return failedPatch(job, job.errorMessage ?? "Open Sourcebook stopped waiting.", wait.code, now(), wait);
    return { state: withWait(job.state, next) };
  });
}

/** A waiting job past its patience: it fails plainly, keeping what was made, so trying again carries on from there. */
export async function giveUpWaiting(store: GenerationJobStore, id: string, now: () => number): Promise<KeepOutcome> {
  return keep(store, id, (job) => {
    const wait = waitOf(job);
    if (job.status !== "waiting" || !wait || Date.parse(wait.giveUpAt) > now()) return undefined;
    return failedPatch(job, job.errorMessage ?? "Open Sourcebook stopped waiting.", wait.code, now(), wait);
  });
}

/** The person asks a waiting job to be tried now, rather than when it is due. */
export async function wakeJob(store: GenerationJobStore, id: string, now: () => number = Date.now): Promise<KeepOutcome> {
  return keep(store, id, (job) => {
    const wait = waitOf(job);
    if (job.status !== "waiting" || !wait) return undefined;
    return { state: withWait(job.state, { ...wait, nextAt: new Date(now()).toISOString() }) };
  });
}

/** The key in a job's state that holds the way on the person chose (`WaitChoice.id`), read by its maker as `EngineServices.chosen`. */
export const CHOSEN_KEY = "chosen";

/** The way on a job offers the person now: while it waits, or after it was given up on waiting. */
export function choiceOf(job: GenerationJob): WaitChoice | undefined {
  if (job.status === "waiting") return waitOf(job)?.choice;
  const waited = job.state.waited;
  if (job.status !== "failed" || !waited || typeof waited !== "object" || Array.isArray(waited)) return undefined;
  return readChoice((waited as Record<string, JsonValue>).choice);
}

/**
 * The person takes the way on a job offers (`choiceOf`): it is kept on the
 * job for its maker, and a waiting job is due now. Unchanged when the job
 * offers no such way.
 */
export async function chooseWayOn(store: GenerationJobStore, id: string, choice: string, now: () => number = Date.now): Promise<KeepOutcome> {
  return keep(store, id, (job) => {
    if (choiceOf(job)?.id !== choice) return undefined;
    const state = { ...job.state, [CHOSEN_KEY]: choice };
    const wait = waitOf(job);
    return { state: job.status === "waiting" && wait ? withWait(state, { ...wait, nextAt: new Date(now()).toISOString() }) : state };
  });
}

/** One keeper write: `decide` answers the patch, or undefined to leave the row. */
async function keep(store: GenerationJobStore, id: string, decide: (job: GenerationJob) => GenerationJobPatch | undefined): Promise<KeepOutcome> {
  try {
    return await transition<KeepOutcome>(store, id, (job) => {
      const patch = decide(job);
      return patch ? { write: patch, then: (moved) => ({ kind: "moved", job: moved }) } : { result: { kind: "unchanged", job } };
    });
  } catch (error) {
    if (error instanceof JobNotFoundError) return { kind: "missing" };
    throw error;
  }
}

/** A failure after waiting: final, keeping what was made, saying it waited (`state.waited`) for the words. */
function failedPatch(job: GenerationJob, message: string, code: JobFailureCode, now: number, wait: JobWaitState | undefined): GenerationJobPatch {
  const state = withWait(withFailureCode(job.state, code), undefined);
  return {
    status: "failed",
    retryable: false,
    errorMessage: message,
    // What it waited for, and the way on it offered, stay with it: the person may still choose that way.
    state: wait ? { ...state, waited: { reason: wait.reason, tries: wait.tries, ...(wait.trouble ? { trouble: wait.trouble } : {}), ...(wait.choice ? { choice: { ...wait.choice } } : {}) } } : state,
    finishedAt: new Date(now).toISOString(),
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
