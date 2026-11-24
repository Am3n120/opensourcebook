/**
 * `generation_jobs` on D1. Every write is one conditional UPDATE ... RETURNING,
 * so there is no read-merge-write window for a cancel to fall into.
 */
import type { D1DatabaseLike } from "../types/bindings";
import {
  isJobStatus,
  type CompareAndSetResult,
  type CreateGenerationJobInput,
  type GenerationJob,
  type GenerationJobPatch,
  type GenerationJobStore,
  type JobStatus,
  type JsonObject,
} from "./types";

interface JobRow {
  id: string;
  owner_id: string;
  idempotency_key: string;
  kind: string;
  type: string | null;
  project_id: string | null;
  plan_id: string | null;
  node_id: string | null;
  source_id: string | null;
  output_id: string | null;
  status: string;
  stage: string;
  progress: number;
  attempt: number;
  version: number;
  retryable: number;
  error_message: string | null;
  input_json: string;
  state_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Patch field → column and how to bind it. Nothing else can be written. */
const PATCH_COLUMNS: { [K in keyof Required<GenerationJobPatch>]: [string, (value: GenerationJobPatch[K]) => unknown] } = {
  status: ["status", (value) => value],
  stage: ["stage", (value) => value],
  progress: ["progress", (value) => value],
  attempt: ["attempt", (value) => value],
  retryable: ["retryable", (value) => (value ? 1 : 0)],
  errorMessage: ["error_message", (value) => value ?? null],
  outputId: ["output_id", (value) => value ?? null],
  state: ["state_json", (value) => JSON.stringify(value ?? {})],
  input: ["input_json", (value) => JSON.stringify(value ?? {})],
  startedAt: ["started_at", (value) => value ?? null],
  finishedAt: ["finished_at", (value) => value ?? null],
};

const INSERT =
  "INSERT INTO generation_jobs (id, owner_id, idempotency_key, kind, type, project_id, plan_id, node_id, source_id, input_json, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING *";
const SELECT_BY_ID = "SELECT * FROM generation_jobs WHERE id = ?";
/** A plan's jobs: named on the plan, or on one of its items (a remake of what an item made names only the item). */
const OF_PLAN = "(plan_id = ? OR node_id IN (SELECT id FROM plan_nodes WHERE plan_id = ?))";
const SELECT_BY_KEY = "SELECT * FROM generation_jobs WHERE owner_id = ? AND idempotency_key = ?";

export interface D1GenerationJobStoreOptions {
  now?: () => string;
  newId?: () => string;
}

export class D1GenerationJobStore implements GenerationJobStore {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly db: D1DatabaseLike,
    options: D1GenerationJobStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Reads go to the primary so a write from another isolate is visible at once. */
  private reader(): D1DatabaseLike {
    return typeof this.db.withConstraint === "function" ? this.db.withConstraint("primary") : this.db;
  }

  async create(input: CreateGenerationJobInput): Promise<{ job: GenerationJob; created: boolean }> {
    const now = this.now();
    // First write wins: a racing request with the same key gets no row back
    // and reads the winner's.
    const inserted = await this.db
      .prepare(INSERT)
      .bind(
        this.newId(),
        input.ownerId,
        input.idempotencyKey,
        input.kind ?? "output",
        input.type ?? null,
        input.projectId ?? null,
        input.planId ?? null,
        input.nodeId ?? null,
        input.sourceId ?? null,
        JSON.stringify(input.input ?? {}),
        now,
        now,
      )
      .first<JobRow>();
    if (inserted) return { job: fromRow(inserted), created: true };
    const existing = await this.reader()
      .prepare(SELECT_BY_KEY)
      .bind(input.ownerId, input.idempotencyKey)
      .first<JobRow>();
    if (!existing) throw new Error("Job insert was ignored but no job holds its idempotency key.");
    return { job: fromRow(existing), created: false };
  }

  async get(id: string): Promise<GenerationJob | undefined> {
    const row = await this.reader().prepare(SELECT_BY_ID).bind(id).first<JobRow>();
    return row ? fromRow(row) : undefined;
  }

  async findByKey(ownerId: string, idempotencyKey: string): Promise<GenerationJob | undefined> {
    const row = await this.reader().prepare(SELECT_BY_KEY).bind(ownerId, idempotencyKey).first<JobRow>();
    return row ? fromRow(row) : undefined;
  }

  async findByOutput(outputId: string): Promise<GenerationJob | undefined> {
    const row = await this.reader().prepare("SELECT * FROM generation_jobs WHERE output_id = ? ORDER BY created_at, rowid LIMIT 1").bind(outputId).first<JobRow>();
    return row ? fromRow(row) : undefined;
  }

  async listByNode(nodeId: string, limit: number): Promise<GenerationJob[]> {
    const { results } = await this.reader()
      .prepare("SELECT * FROM generation_jobs WHERE node_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .bind(nodeId, Math.max(1, Math.floor(limit)))
      .all<JobRow>();
    return (results ?? []).map(fromRow);
  }

  async listByStatus(statuses: readonly JobStatus[], limit: number): Promise<GenerationJob[]> {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const { results } = await this.reader()
      .prepare(`SELECT * FROM generation_jobs WHERE status IN (${marks}) ORDER BY updated_at LIMIT ?`)
      .bind(...statuses, Math.max(1, Math.floor(limit)))
      .all<JobRow>();
    return (results ?? []).map(fromRow);
  }

  async listByPlan(planId: string): Promise<GenerationJob[]> {
    const { results } = await this.reader().prepare(`SELECT * FROM generation_jobs WHERE ${OF_PLAN} ORDER BY created_at, rowid`).bind(planId, planId).all<JobRow>();
    return (results ?? []).map(fromRow);
  }

  async deleteByPlan(planId: string): Promise<number> {
    const row = await this.reader().prepare(`SELECT COUNT(*) AS n FROM generation_jobs WHERE ${OF_PLAN}`).bind(planId, planId).first<{ n: number }>();
    await this.db.prepare(`DELETE FROM generation_jobs WHERE ${OF_PLAN}`).bind(planId, planId).run();
    return row?.n ?? 0;
  }

  async compareAndSet(id: string, expectedVersion: number, patch: GenerationJobPatch): Promise<CompareAndSetResult> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(patch) as (keyof GenerationJobPatch)[]) {
      if (patch[key] === undefined) continue;
      const [column, encode] = PATCH_COLUMNS[key] as [string, (value: unknown) => unknown];
      assignments.push(`${column} = ?`);
      values.push(encode(patch[key]));
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(this.now());
    const row = await this.db
      .prepare(`UPDATE generation_jobs SET ${assignments.join(", ")} WHERE id = ? AND version = ? RETURNING *`)
      .bind(...values, id, expectedVersion)
      .first<JobRow>();
    if (row) return { ok: true, job: fromRow(row) };
    return { ok: false, current: await this.get(id) };
  }
}

function fromRow(row: JobRow): GenerationJob {
  if (!isJobStatus(row.status)) throw new Error(`Job ${row.id} has unknown status "${row.status}".`);
  return {
    id: row.id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    ...optional("type", row.type),
    ...optional("projectId", row.project_id),
    ...optional("planId", row.plan_id),
    ...optional("nodeId", row.node_id),
    ...optional("sourceId", row.source_id),
    ...optional("outputId", row.output_id),
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempt: row.attempt,
    version: row.version,
    retryable: row.retryable === 1,
    ...optional("errorMessage", row.error_message),
    input: parseObject(row.input_json),
    state: parseObject(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...optional("startedAt", row.started_at),
    ...optional("finishedAt", row.finished_at),
  };
}

function optional<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: string };
}

function parseObject(json: string): JsonObject {
  const value: unknown = JSON.parse(json);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
