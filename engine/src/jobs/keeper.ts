/**
 * The keeper: nothing Open Sourcebook is making stays stuck, and nothing waits for ever.
 *
 * It runs by itself on the engine's own requests (at most every few
 * seconds: the web app's polls, the connector's calls, the launcher's
 * check that the engine is up), so it needs no timer that would die with
 * the engine: the first request after a restart runs it, and everything it
 * needs is on the job rows. Each pass:
 *
 *   - a job left `running` that this engine is not running and that has
 *     been silent for `QUIET_MS` was orphaned by a restart: it waits to be
 *     carried on from what it made (lifecycle.ts `orphanJob`);
 *   - a job waiting after a restart is carried on when it is due;
 *   - jobs waiting for the agent's plan, when one is due, cost one cheap
 *     check of the agent (the connector says when it knows; otherwise the
 *     smallest turn there is): still limited, they all wait longer; free
 *     again, they are all carried on;
 *   - jobs waiting for the voice are the same, with one free check of the
 *     voice (the scenes service reads its account without speaking);
 *   - a job waiting past its patience fails plainly, keeping what was made.
 *
 * A job this engine is running is never touched, however old its last write
 * looks: after the computer slept its own run checks its maker again.
 */
import { isRunningHere } from "./consumer";
import { giveUpWaiting, orphanJob, waitLonger } from "./lifecycle";
import type { GenerationJob, GenerationJobStore } from "./types";
import { isDue, waitOf, type LimitReset } from "./waits";

/** A running job silent this long, and not run by this engine, is taken to be orphaned. */
export const QUIET_MS = 50_000;
/** The keeper runs at most this often. */
export const KEEP_EVERY_MS = 10_000;
const MAX_JOBS = 200;

/** What a check of the person's agent found. */
export type AgentCheck = { free: true } | { free: false; limit: LimitReset } | { free?: undefined };
/** What a check of the voice found: it can speak, it still cannot, or nothing could be told. */
export type VoiceCheck = { free: boolean } | { free?: undefined };

export interface KeeperOptions {
  store: GenerationJobStore;
  /** Hands a job to the queue (or runs it), as the plan runner does. */
  schedule(jobId: string): Promise<void>;
  /** The cheapest honest check of the agent's plan; absent: a due job is just carried on (its own turn says). */
  checkAgent?: () => Promise<AgentCheck>;
  /** Whether the voice can speak, checked for free; absent: a due job is just carried on (its own voicing says). */
  checkVoice?: () => Promise<VoiceCheck>;
  /** Told about a job that failed for good here, as the consumer tells. */
  onFinished?: (job: GenerationJob) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface KeeperPass {
  orphaned: string[];
  carriedOn: string[];
  stillWaiting: string[];
  gaveUp: string[];
}

/** One pass of the keeper. */
export async function keepJobs(options: KeeperOptions): Promise<KeeperPass> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const pass: KeeperPass = { orphaned: [], carriedOn: [], stillWaiting: [], gaveUp: [] };
  if (!options.store.listByStatus) return pass;
  const jobs = await options.store.listByStatus(["running", "waiting"], MAX_JOBS);

  const due: GenerationJob[] = [];
  for (const job of jobs) {
    if (job.status === "running") {
      if (isRunningHere(job.id)) continue;
      const moved = await orphanJob(options.store, job.id, { now, quietMs: QUIET_MS });
      if (moved.kind !== "moved") continue;
      pass.orphaned.push(job.id);
      log(`Job ${job.id}: nothing was running it any more (quiet since ${job.updatedAt}); ${moved.job.status === "waiting" ? "carrying it on" : "it has been carried on enough"}.`);
      if (moved.job.status === "waiting") due.push(moved.job);
      else await finished(options, moved.job, pass);
      continue;
    }
    const given = await giveUpWaiting(options.store, job.id, now);
    if (given.kind === "moved") {
      log(`Job ${job.id}: waited long enough (${waitOf(job)?.reason ?? "?"}); it fails, keeping what was made.`);
      await finished(options, given.job, pass);
      continue;
    }
    if (isDue(job, now())) due.push(job);
  }

  const limited = due.filter((job) => waitOf(job)?.reason === "agent_limit");
  const voiced = due.filter((job) => waitOf(job)?.reason === "voice");
  const others = due.filter((job) => waitOf(job)?.reason !== "agent_limit" && waitOf(job)?.reason !== "voice");
  // One check for every job waiting on the same thing, however many there are; still not free, they all wait longer.
  const checks: Array<{ jobs: GenerationJob[]; check?: () => Promise<AgentCheck | VoiceCheck>; still: string }> = [
    { jobs: limited, ...(options.checkAgent ? { check: options.checkAgent } : {}), still: "Your agent is still at its plan's limit" },
    { jobs: voiced, ...(options.checkVoice ? { check: options.checkVoice } : {}), still: "The voice still cannot speak" },
  ];
  for (const { jobs: waiting, check: ask, still } of checks) {
    if (waiting.length === 0) continue;
    const check: AgentCheck | VoiceCheck = ask ? await ask().catch(() => ({})) : {};
    if (check.free !== false) {
      others.push(...waiting);
      continue;
    }
    for (const job of waiting) {
      const moved = await waitLonger(options.store, job.id, (check as { limit?: LimitReset }).limit ?? {}, now);
      if (moved.kind !== "moved") continue;
      if (moved.job.status === "waiting") pass.stillWaiting.push(job.id);
      else await finished(options, moved.job, pass);
    }
    log(`${still}; ${waiting.length} item${waiting.length === 1 ? "" : "s"} keep waiting.`);
  }
  for (const job of others) {
    pass.carriedOn.push(job.id);
    await options.schedule(job.id);
  }
  return pass;
}

async function finished(options: KeeperOptions, job: GenerationJob, pass: KeeperPass): Promise<void> {
  pass.gaveUp.push(job.id);
  await options.onFinished?.(job);
}

let lastPass = Number.NEGATIVE_INFINITY;
let passing: Promise<unknown> | undefined;

/**
 * Runs a pass unless one ran in the last `KEEP_EVERY_MS` or one is under
 * way; never throws. The first call in a fresh engine always runs, which is
 * how jobs left running by the last one are found at start-up.
 */
export function keepJobsSoon(options: KeeperOptions): Promise<unknown> {
  const now = (options.now ?? Date.now)();
  if (passing || now - lastPass < KEEP_EVERY_MS) return passing ?? Promise.resolve();
  lastPass = now;
  passing = keepJobs(options)
    .catch((error) => (options.log ?? console.warn)(`The keeper could not look at the jobs: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      passing = undefined;
    });
  return passing;
}

/** Forgets when the keeper last ran (tests). */
export function resetKeeper(): void {
  lastPass = Number.NEGATIVE_INFINITY;
  passing = undefined;
}
