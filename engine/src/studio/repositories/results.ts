/**
 * `item_results` (migrations/0005, 0015): what the person did with an item.
 * The done tick (`doneAt`), the result a branch condition or a later item's
 * input reads, and where they stopped in it (`progress`), which nothing
 * decides on. One row per plan item; the result's and the progress's shape
 * belong to the item's format and are stored as given.
 */
import type { JsonValue } from "../types";
import { all, compact, first, fromJson, opt, run, type RepositoryContext } from "./shared";

export interface ItemResult {
  nodeId: string;
  outputId?: string;
  /** When the item was ticked done; absent while it is not. */
  doneAt?: string;
  result?: JsonValue;
  /** Where the person stopped in it and what they did: a card and each card's memory, the answers so far, a time. Never read by a branch. */
  progress?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

/** Fields left undefined keep their stored value; `null` clears one. */
export interface ItemResultPatch {
  done?: boolean;
  result?: JsonValue | null;
  outputId?: string | null;
  progress?: JsonValue | null;
}

interface ResultRow {
  node_id: string;
  output_id: string | null;
  done_at: string | null;
  result_json: string | null;
  progress_json?: string | null;
  created_at: string;
  updated_at: string;
}

export class ItemResultRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async get(nodeId: string): Promise<ItemResult | undefined> {
    const row = await first<ResultRow>(this.ctx.db, "SELECT * FROM item_results WHERE node_id = ?", nodeId);
    return row ? resultFromRow(row) : undefined;
  }

  /** Every result recorded for a plan's items, in item id order. */
  async listByPlan(planId: string): Promise<ItemResult[]> {
    return (
      await all<ResultRow>(
        this.ctx.db,
        "SELECT r.* FROM item_results r JOIN plan_nodes n ON n.id = r.node_id WHERE n.plan_id = ? ORDER BY r.node_id",
        planId,
      )
    ).map(resultFromRow);
  }

  /**
   * Creates or updates the item's row in one statement, so a tick, a result
   * and a progress written at the same moment (phone and web) all land.
   * Ticking an item already done keeps its first `doneAt`; un-ticking clears
   * it and keeps the result and the progress.
   */
  async set(nodeId: string, patch: ItemResultPatch): Promise<ItemResult> {
    const now = this.ctx.now();
    const done = patch.done === undefined ? "keep" : patch.done ? "tick" : "clear";
    const result = patch.result === undefined || patch.result === null ? null : JSON.stringify(patch.result);
    const progress = patch.progress === undefined || patch.progress === null ? null : JSON.stringify(patch.progress);
    const outputId = patch.outputId ?? null;
    await run(
      this.ctx.db,
      "INSERT INTO item_results (node_id, output_id, done_at, result_json, progress_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (node_id) DO UPDATE SET " +
        "output_id = CASE WHEN ? THEN item_results.output_id ELSE excluded.output_id END, " +
        "done_at = CASE ? WHEN 'keep' THEN item_results.done_at WHEN 'tick' THEN COALESCE(item_results.done_at, excluded.done_at) ELSE NULL END, " +
        "result_json = CASE WHEN ? THEN item_results.result_json ELSE excluded.result_json END, " +
        "progress_json = CASE WHEN ? THEN item_results.progress_json ELSE excluded.progress_json END, " +
        "updated_at = excluded.updated_at",
      nodeId,
      outputId,
      done === "tick" ? now : null,
      result,
      progress,
      now,
      now,
      patch.outputId === undefined ? 1 : 0,
      done,
      patch.result === undefined ? 1 : 0,
      patch.progress === undefined ? 1 : 0,
    );
    return (await this.get(nodeId))!;
  }

  async delete(nodeId: string): Promise<void> {
    await run(this.ctx.db, "DELETE FROM item_results WHERE node_id = ?", nodeId);
  }
}

function resultFromRow(row: ResultRow): ItemResult {
  return compact({
    nodeId: row.node_id,
    outputId: opt(row.output_id),
    doneAt: opt(row.done_at),
    result: row.result_json === null ? undefined : fromJson<JsonValue>(row.result_json, null),
    progress: row.progress_json === null || row.progress_json === undefined ? undefined : fromJson<JsonValue>(row.progress_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
