/**
 * `usage` (migrations/0004): one row per provider call. The D1 sink is what
 * the providers report to in production (docs/DECISIONS.md #11, cost
 * everywhere from day one); the sums give cost per job, item, plan and
 * project from one indexed query each.
 */
import type { UsageEvent, UsageSink } from "../../types/provider";
import { first, nullable, run, type RepositoryContext } from "./shared";

/** Who a call is billed to. Copied onto every row the sink writes. */
export interface UsageScope {
  ownerId: string;
  jobId?: string;
  projectId?: string;
  planId?: string;
  nodeId?: string;
  sessionId?: string;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  /** Successful calls with no `usd`: their model has no price, so `usd` understates the spend. */
  unpricedCalls: number;
  /**
   * Calls the engine stopped waiting for (`error = 'timeout'`). The provider
   * may still have billed them, and they add nothing to `usd`, so when this
   * is above 0 `usd` may be undercounted.
   */
  timedOutCalls: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export type UsageGroup = "job" | "node" | "plan" | "project" | "session";

const GROUP_COLUMN: Record<UsageGroup, string> = {
  job: "job_id",
  node: "node_id",
  plan: "plan_id",
  project: "project_id",
  session: "session_id",
};

export class UsageRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async record(scope: UsageScope, event: UsageEvent): Promise<void> {
    await run(
      this.ctx.db,
      "INSERT INTO usage (id, owner_id, job_id, project_id, plan_id, node_id, session_id, provider, model, task, tokens_in, tokens_out, usd, latency_ms, ok, error, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      this.ctx.newId(),
      scope.ownerId,
      nullable(event.jobId ?? scope.jobId),
      nullable(scope.projectId),
      nullable(scope.planId),
      nullable(scope.nodeId),
      nullable(scope.sessionId),
      event.provider,
      event.model,
      nullable(event.task),
      nullable(event.tokensIn),
      nullable(event.tokensOut),
      nullable(event.usd),
      Math.round(event.latencyMs),
      event.ok ? 1 : 0,
      event.ok ? null : nullable(event.error),
      this.ctx.now(),
    );
  }

  /** Spend for one job, item, plan, project or chat. Calls without a known price add nothing to `usd` and are counted in `unpricedCalls`. */
  async totals(group: UsageGroup, id: string): Promise<UsageTotals> {
    const row = await first<{ calls: number; failed: number | null; unpriced: number | null; timed_out: number | null; tokens_in: number | null; tokens_out: number | null; usd: number | null }>(
      this.ctx.db,
      `SELECT COUNT(*) AS calls, SUM(1 - ok) AS failed, SUM(CASE WHEN ok = 1 AND usd IS NULL THEN 1 ELSE 0 END) AS unpriced, SUM(CASE WHEN error = 'timeout' THEN 1 ELSE 0 END) AS timed_out, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(usd) AS usd FROM usage WHERE ${GROUP_COLUMN[group]} = ?`,
      id,
    );
    return {
      calls: row?.calls ?? 0,
      failedCalls: row?.failed ?? 0,
      unpricedCalls: row?.unpriced ?? 0,
      timedOutCalls: row?.timed_out ?? 0,
      tokensIn: row?.tokens_in ?? 0,
      tokensOut: row?.tokens_out ?? 0,
      usd: Math.round((row?.usd ?? 0) * 1_000_000) / 1_000_000,
    };
  }

  /** A sink bound to one scope, for a job's providers or a chat. */
  sink(scope: UsageScope): UsageSink {
    return new D1UsageSink(this, scope);
  }
}

/** UsageSink that writes each event to `usage`. Providers report through `safeRecord`, so a failed write never fails a call. */
export class D1UsageSink implements UsageSink {
  constructor(
    private readonly repository: UsageRepository,
    private readonly scope: UsageScope,
  ) {}

  record(event: UsageEvent): Promise<void> {
    return this.repository.record(this.scope, event);
  }
}
