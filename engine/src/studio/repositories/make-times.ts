/** `make_times` (migrations/0020): how long things took to make here, by the pick they were made on. */
import { all, run, type RepositoryContext } from "./shared";

/** How many of the newest runs of one key a time is the middle of. */
export const TIME_RUNS = 12;

const SCOPE = /^[a-z0-9._-]{1,64}$/i;

/** One finished piece of making. `model`, `effort` and `bucket` are left out when the pick or the shape has none. */
export interface MakeTimeRow {
  ownerId: string;
  /** "chat", a format id, or "<format>.review". */
  scope: string;
  agent: string;
  model?: string;
  effort?: string;
  bucket?: string;
  seconds: number;
  /** The job (or the chat's agent turn) this time is of; a second row for the same one is ignored. */
  jobId?: string;
  madeAt?: string;
}

/** The middle of the newest runs of one key. */
export interface MakeTimeSummary {
  scope: string;
  agent: string;
  model?: string;
  effort?: string;
  bucket?: string;
  /** Runs used, at most `TIME_RUNS`. */
  runs: number;
  seconds: number;
  lastAt: string;
}

interface TimeRow {
  scope: string;
  agent: string;
  model: string;
  effort: string;
  bucket: string;
  seconds: number;
  made_at: string;
}

export class MakeTimeRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /** Keeps one time. False when it was not kept: a second time for the same job, or seconds that are not a time. */
  async record(row: MakeTimeRow): Promise<boolean> {
    if (!SCOPE.test(row.scope) || !row.agent || !Number.isFinite(row.seconds) || row.seconds <= 0) return false;
    const id = this.ctx.newId();
    const before = row.jobId ? await this.has(row.ownerId, row.jobId) : false;
    if (before) return false;
    await run(
      this.ctx.db,
      "INSERT OR IGNORE INTO make_times (id, owner_id, scope, agent, model, effort, bucket, seconds, job_id, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.ownerId,
      row.scope,
      row.agent,
      row.model ?? "",
      row.effort ?? "",
      row.bucket ?? "",
      row.seconds,
      row.jobId ?? null,
      row.madeAt ?? this.ctx.now(),
    );
    return true;
  }

  private async has(ownerId: string, jobId: string): Promise<boolean> {
    const rows = await all<{ id: string }>(this.ctx.db, "SELECT id FROM make_times WHERE owner_id = ? AND job_id = ?", ownerId, jobId);
    return rows.length > 0;
  }

  /**
   * Per exact key (scope, agent, model, effort, bucket), the middle of the
   * newest `TIME_RUNS` runs and how many there were. Never combines keys: a
   * key with no run is simply not in the list.
   */
  async summary(ownerId: string, scope?: string): Promise<MakeTimeSummary[]> {
    const rows = await all<TimeRow>(
      this.ctx.db,
      `SELECT scope, agent, model, effort, bucket, seconds, made_at FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY scope, agent, model, effort, bucket ORDER BY made_at DESC, rowid DESC) AS n
         FROM make_times WHERE owner_id = ?${scope === undefined ? "" : " AND scope = ?"}
       ) WHERE n <= ${TIME_RUNS} ORDER BY scope, agent, model, effort, bucket, made_at DESC`,
      ...(scope === undefined ? [ownerId] : [ownerId, scope]),
    );
    const groups = new Map<string, TimeRow[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.scope, row.agent, row.model, row.effort, row.bucket]);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    return [...groups.values()].map((group) => {
      const [newest] = group;
      return {
        scope: newest.scope,
        agent: newest.agent,
        ...(newest.model ? { model: newest.model } : {}),
        ...(newest.effort ? { effort: newest.effort } : {}),
        ...(newest.bucket ? { bucket: newest.bucket } : {}),
        runs: group.length,
        seconds: median(group.map((row) => row.seconds)),
        lastAt: newest.made_at,
      };
    });
  }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
