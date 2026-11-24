/**
 * In-memory twin of D1GenerationJobStore with the same compare-and-set
 * contract. The shared store suite runs against both.
 */
import type {
  CompareAndSetResult,
  CreateGenerationJobInput,
  GenerationJob,
  GenerationJobPatch,
  GenerationJobStore,
  JobStatus,
} from "../../src/jobs/types";

export class InMemoryGenerationJobStore implements GenerationJobStore {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly keys = new Map<string, string>();
  private counter = 0;

  constructor(private readonly options: { now?: () => string } = {}) {}

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  async create(input: CreateGenerationJobInput): Promise<{ job: GenerationJob; created: boolean }> {
    const key = JSON.stringify([input.ownerId, input.idempotencyKey]);
    const existing = this.keys.get(key);
    if (existing) return { job: clone(this.jobs.get(existing)!), created: false };
    const now = this.now();
    this.counter += 1;
    const job: GenerationJob = {
      id: `job-${this.counter}`,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind ?? "output",
      ...(input.type ? { type: input.type } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      status: "queued",
      stage: "queued",
      progress: 0,
      attempt: 0,
      version: 0,
      retryable: false,
      input: clone(input.input ?? {}),
      state: {},
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.keys.set(key, job.id);
    return { job: clone(job), created: true };
  }

  async get(id: string): Promise<GenerationJob | undefined> {
    const job = this.jobs.get(id);
    return job ? clone(job) : undefined;
  }

  async findByKey(ownerId: string, idempotencyKey: string): Promise<GenerationJob | undefined> {
    const id = this.keys.get(JSON.stringify([ownerId, idempotencyKey]));
    return id ? this.get(id) : undefined;
  }

  async listByStatus(statuses: readonly JobStatus[], limit: number): Promise<GenerationJob[]> {
    return [...this.jobs.values()]
      .filter((job) => statuses.includes(job.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map(clone);
  }

  async compareAndSet(id: string, expectedVersion: number, patch: GenerationJobPatch): Promise<CompareAndSetResult> {
    const current = this.jobs.get(id);
    if (!current || current.version !== expectedVersion) {
      return { ok: false, ...(current ? { current: clone(current) } : {}) };
    }
    const next: GenerationJob = { ...current };
    for (const [key, value] of Object.entries(patch) as [keyof GenerationJobPatch, unknown][]) {
      if (value === undefined) continue;
      if (value === null) delete (next as unknown as Record<string, unknown>)[key];
      else (next as unknown as Record<string, unknown>)[key] = clone(value);
    }
    next.version = current.version + 1;
    next.updatedAt = this.now();
    this.jobs.set(id, next);
    return { ok: true, job: clone(next) };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
