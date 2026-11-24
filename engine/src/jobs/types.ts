/**
 * Generation jobs: one unit of queued work, for any format
 * (migrations/0003_generation_jobs.sql). The store only reads and
 * compare-and-sets rows; what a transition means lives in `lifecycle.ts`.
 */
import type { JsonValue } from "../studio/types";

/**
 * `waiting`: its maker went quiet (a program restarted, the computer slept)
 * or the person's agent reached its plan's limit. What was made is kept, and
 * the keeper (`keeper.ts`) carries it on by itself when it is due.
 */
export const JOB_STATUSES = ["queued", "running", "waiting", "done", "failed", "cancelled", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export type JsonObject = { [key: string]: JsonValue };

export interface GenerationJob {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  /** What the job does; picks the runner. 'output' runs an engine. */
  kind: string;
  /** Format id, for kind 'output'. */
  type?: string;
  projectId?: string;
  planId?: string;
  nodeId?: string;
  sourceId?: string;
  outputId?: string;
  status: JobStatus;
  /** Engine-reported stage, free text for display. */
  stage: string;
  /** 0...1, never backwards within one attempt. */
  progress: number;
  /** Times a consumer has picked the job up. */
  attempt: number;
  /** Compare-and-set counter; bumped by every write. */
  version: number;
  retryable: boolean;
  errorMessage?: string;
  /** The request as received. */
  input: JsonObject;
  /** Saved step results, so a redelivered job resumes instead of starting over. */
  state: JsonObject;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CreateGenerationJobInput {
  ownerId: string;
  idempotencyKey: string;
  kind?: string;
  type?: string;
  projectId?: string;
  planId?: string;
  nodeId?: string;
  sourceId?: string;
  input?: JsonObject;
}

/** Fields a write may change. `null` clears a nullable column. */
export interface GenerationJobPatch {
  status?: JobStatus;
  stage?: string;
  progress?: number;
  attempt?: number;
  retryable?: boolean;
  errorMessage?: string | null;
  outputId?: string | null;
  state?: JsonObject;
  /** Only for a job not running: its input replaced (`resetJobForNewMaker`, a stopped plan's item given a new maker). */
  input?: JsonObject;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type CompareAndSetResult =
  | { ok: true; job: GenerationJob }
  /** The version moved (or the row is gone). `current` is a fresh read. */
  | { ok: false; current?: GenerationJob };

export interface GenerationJobStore {
  /** Idempotent on (ownerId, idempotencyKey): a repeat returns the first job. */
  create(input: CreateGenerationJobInput): Promise<{ job: GenerationJob; created: boolean }>;
  get(id: string): Promise<GenerationJob | undefined>;
  /** The job a client created with this idempotency key, if any. */
  findByKey(ownerId: string, idempotencyKey: string): Promise<GenerationJob | undefined>;
  /**
   * Applies `patch` only if the row is still at `expectedVersion`, bumping the
   * version and `updatedAt`. There is no unconditional write.
   */
  compareAndSet(id: string, expectedVersion: number, patch: GenerationJobPatch): Promise<CompareAndSetResult>;
  /** The job that wrote this output, if a job did. Absent: no output can be traced to its job. */
  findByOutput?(outputId: string): Promise<GenerationJob | undefined>;
  /** An item's jobs, newest first: its own and the remakes of what it made. Absent: none are listed. */
  listByNode?(nodeId: string, limit: number): Promise<GenerationJob[]>;
  /** Jobs in these statuses, oldest write first, for the keeper (`keeper.ts`). Absent: nothing is kept. */
  listByStatus?(statuses: readonly JobStatus[], limit: number): Promise<GenerationJob[]>;
  /** Every job of a plan (named on it, or on one of its items), oldest first. Absent: none are listed. */
  listByPlan?(planId: string): Promise<GenerationJob[]>;
  /** Deletes every job of a plan with its saved steps (the plan is being deleted). Answers how many. Absent: they stay. */
  deleteByPlan?(planId: string): Promise<number>;
}

/** What the queue carries. Everything else is read from the row. */
export interface JobQueueMessageBody {
  jobId: string;
}

/** Structural view of a Cloudflare Queues message; the real one satisfies it. */
export interface JobQueueMessage {
  body: JobQueueMessageBody;
  /** Deliveries so far, starting at 1. */
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface JobQueueBatch {
  queue: string;
  messages: readonly JobQueueMessage[];
}
