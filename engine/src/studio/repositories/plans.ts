/**
 * `plans`, `plan_nodes`, `plan_node_sources` and `plan_edges`
 * (migrations/0004), `plan_stages` (0005) and `plan_stage_dates` (0017): the plan graph. Level order, branches and edges are
 * stored as written; walking them is the plan runner's job.
 */
import { isDay } from "../days";
import { isFormatId, type FormatId, type JsonValue, type SourceLocator } from "../types";
import type { Settings } from "./projects";
import {
  InvalidRecordError,
  all,
  assignments,
  bool,
  compact,
  first,
  fromJson,
  nullable,
  oneOf,
  opt,
  run,
  runAll,
  toJson,
  type RepositoryContext,
} from "./shared";

/**
 * `failed`: the plan ran to the end and at least one item failed (the others still ran).
 * `cancelled`: stopped after Start; it can be started again from what is not made yet.
 * `discarded`: cancelled before Start; it never ran and never will. Rows
 * stored before Nov 13, 2026 as `cancelled` with no Start read as `discarded`.
 */
export const PLAN_STATUSES = ["draft", "approved", "running", "done", "failed", "cancelled", "discarded"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Statuses nothing moves a plan out of by itself: Start, edits and approve refuse them. */
export const FINISHED_PLAN_STATUSES: readonly PlanStatus[] = ["done", "failed", "cancelled", "discarded"];

export function isPlanFinished(status: PlanStatus): boolean {
  return FINISHED_PLAN_STATUSES.includes(status);
}

export const NODE_STATUSES = ["pending", "queued", "running", "done", "failed", "skipped", "cancelled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * An edge's kind is open. The plan runner reads `assumes` as "may rely on";
 * every other kind (`fix_of`, ...) makes the earlier item's output and
 * result an input of the later one (studio/edge-kinds.ts lists the known
 * kinds in words). New kinds must be lower snake_case or camelCase
 * (`isEdgeKind`); stored rows read back with any kind.
 */
export type EdgeKind = string;

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === "string" && /^[a-z][A-Za-z0-9_]{0,39}$/.test(value);
}

export class PlanLockedError extends Error {
  constructor(readonly planId: string) {
    super(`Plan ${planId} has been kicked off; supersede it with a new plan instead of editing it.`);
    this.name = "PlanLockedError";
  }
}

export interface Plan {
  id: string;
  ownerId: string;
  projectId: string;
  sessionId?: string;
  supersedesPlanId?: string;
  version: number;
  title?: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  kickedOffAt?: string;
  /** Spending cap for the whole plan in USD; absent means none. */
  budgetUsd?: number;
  /** Made for one thing asked for on its own: one item, started at once, shown as that thing (0016). */
  direct?: boolean;
}

export interface PlanNode {
  id: string;
  planId: string;
  parentId?: string;
  level: number;
  ord: number;
  /** As stored; may be an id no registry knows (shown neutrally, never rejected). */
  type: FormatId;
  title: string;
  prompt: string;
  settings: Settings;
  /** When a branch runs, as a condition on the parent's result. */
  condition?: JsonValue;
  enabled: boolean;
  estCostUsd?: number;
  status: NodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewPlanNode {
  planId: string;
  parentId?: string;
  level: number;
  ord: number;
  type: FormatId;
  title: string;
  prompt?: string;
  settings?: Settings;
  condition?: JsonValue;
  enabled?: boolean;
  estCostUsd?: number;
}

export interface PlanNodePatch {
  parentId?: string | null;
  level?: number;
  ord?: number;
  type?: FormatId;
  title?: string;
  prompt?: string;
  settings?: Settings;
  condition?: JsonValue | null;
  enabled?: boolean;
  estCostUsd?: number | null;
  status?: NodeStatus;
}

export interface PlanNodeSource {
  nodeId: string;
  sourceId: string;
  range?: SourceLocator;
}

/** An optional label on a stage (a level). Levels without one have no row. */
export interface PlanStage {
  planId: string;
  level: number;
  label: string;
}

/** The day a stage is meant to be gone through by (0017). Levels without one have no row. */
export interface PlanStageDate {
  planId: string;
  level: number;
  /** YYYY-MM-DD, a day on the person's calendar. */
  dueOn: string;
}

/** A dated stage of a plan that counts for what is due: see `listDatedStages`. */
export interface DatedStage extends PlanStageDate {
  projectId: string;
}

export interface PlanEdge {
  fromNode: string;
  toNode: string;
  kind: EdgeKind;
}

interface PlanRow {
  id: string;
  owner_id: string;
  project_id: string;
  session_id: string | null;
  supersedes_plan_id: string | null;
  version: number;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  kicked_off_at: string | null;
  budget_usd: number | null;
  direct?: number | null;
}

interface NodeRow {
  id: string;
  plan_id: string;
  parent_id: string | null;
  level: number;
  ord: number;
  type: string;
  title: string;
  prompt: string;
  settings_json: string;
  condition_json: string | null;
  enabled: number;
  est_cost_usd: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export class PlanRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /**
   * A new plan. Superseding a plan (a changed plan after Start) gives the
   * new one the next version.
   */
  async create(input: { ownerId: string; projectId: string; sessionId?: string; supersedesPlanId?: string; title?: string; budgetUsd?: number; direct?: boolean }): Promise<Plan> {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO plans (id, owner_id, project_id, session_id, supersedes_plan_id, version, title, budget_usd, direct, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, COALESCE((SELECT version + 1 FROM plans WHERE id = ?), 1), ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      input.projectId,
      nullable(input.sessionId),
      nullable(input.supersedesPlanId),
      nullable(input.supersedesPlanId),
      nullable(input.title),
      nullable(input.budgetUsd),
      input.direct ? 1 : 0,
      now,
      now,
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Plan | undefined> {
    const row = await first<PlanRow>(this.ctx.db, "SELECT * FROM plans WHERE id = ?", id);
    return row ? planFromRow(row) : undefined;
  }

  async listByProject(projectId: string): Promise<Plan[]> {
    return (await all<PlanRow>(this.ctx.db, "SELECT * FROM plans WHERE project_id = ? ORDER BY created_at, version, id", projectId)).map(planFromRow);
  }

  /** The plans a chat made, newest first. */
  async listBySession(sessionId: string): Promise<Plan[]> {
    return (await all<PlanRow>(this.ctx.db, "SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC, version DESC, id", sessionId)).map(planFromRow);
  }

  /** Sets or clears (undefined) the plan's spending cap. */
  async setBudget(id: string, budgetUsd: number | undefined): Promise<Plan | undefined> {
    if (budgetUsd !== undefined && !(budgetUsd >= 0)) throw new Error("budget must be zero or more");
    await run(this.ctx.db, "UPDATE plans SET budget_usd = ?, updated_at = ? WHERE id = ?", nullable(budgetUsd), this.ctx.now(), id);
    return this.get(id);
  }

  async setStatus(id: string, status: PlanStatus): Promise<Plan | undefined> {
    oneOf(status, PLAN_STATUSES, "status");
    const now = this.ctx.now();
    // The first move to running is the Start; it is never overwritten.
    await run(
      this.ctx.db,
      "UPDATE plans SET status = ?, updated_at = ?, kicked_off_at = CASE WHEN ? = 'running' AND kicked_off_at IS NULL THEN ? ELSE kicked_off_at END WHERE id = ?",
      status,
      now,
      status,
      now,
      id,
    );
    return this.get(id);
  }

  /**
   * Moves the plan to `status` only if it is in one of `from` now, in one
   * statement, so two requests cannot both act on the same old status (an
   * edit and approve, Start and an edit, cancel and the last job). Answers
   * the plan as it is afterwards; its status says whether the move held.
   */
  async transition(id: string, from: readonly PlanStatus[], status: PlanStatus): Promise<Plan | undefined> {
    oneOf(status, PLAN_STATUSES, "status");
    for (const old of from) oneOf(old, PLAN_STATUSES, "status");
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      `UPDATE plans SET status = ?, updated_at = ?, kicked_off_at = CASE WHEN ? = 'running' AND kicked_off_at IS NULL THEN ? ELSE kicked_off_at END WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
      status,
      now,
      status,
      now,
      id,
      ...from,
    );
    return this.get(id);
  }

  async rename(id: string, title: string | null): Promise<Plan | undefined> {
    await run(this.ctx.db, "UPDATE plans SET title = ?, updated_at = ? WHERE id = ?", title, this.ctx.now(), id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await run(this.ctx.db, "DELETE FROM plans WHERE id = ?", id);
  }

  /**
   * Links a plan no chat made (a thing made from the Studio) to a chat, the
   * first time someone talks about it there. A plan that has a chat keeps it.
   */
  async linkSession(id: string, sessionId: string): Promise<Plan | undefined> {
    await run(this.ctx.db, "UPDATE plans SET session_id = ? WHERE id = ? AND session_id IS NULL", sessionId, id);
    return this.get(id);
  }

  /**
   * Takes a removed source out of every item of a plan not started yet, so
   * nothing that has not run reads it. Answers the plans it changed; an
   * approved one goes back to draft, since its approval no longer covers
   * what would run. Started plans keep it: their items are fixed.
   */
  async dropSourceFromUnstarted(sourceId: string): Promise<string[]> {
    const rows = await all<{ plan_id: string }>(
      this.ctx.db,
      "SELECT DISTINCT n.plan_id FROM plan_node_sources ns JOIN plan_nodes n ON n.id = ns.node_id JOIN plans p ON p.id = n.plan_id " +
        "WHERE ns.source_id = ? AND p.kicked_off_at IS NULL",
      sourceId,
    );
    const planIds = rows.map((row) => row.plan_id);
    if (planIds.length === 0) return [];
    const db = this.ctx.db;
    const now = this.ctx.now();
    const marks = planIds.map(() => "?").join(", ");
    await runAll(db, [
      db
        .prepare(
          `UPDATE plan_nodes SET updated_at = ? WHERE id IN (SELECT node_id FROM plan_node_sources WHERE source_id = ?) AND plan_id IN (${marks})`,
        )
        .bind(now, sourceId, ...planIds),
      db
        .prepare(`DELETE FROM plan_node_sources WHERE source_id = ? AND node_id IN (SELECT id FROM plan_nodes WHERE plan_id IN (${marks}))`)
        .bind(sourceId, ...planIds),
      db.prepare(`UPDATE plans SET status = 'draft', updated_at = ? WHERE status = 'approved' AND kicked_off_at IS NULL AND id IN (${marks})`).bind(now, ...planIds),
    ]);
    return planIds;
  }

  async addNode(input: NewPlanNode): Promise<PlanNode> {
    checkNode(input);
    await this.assertEditable(input.planId);
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO plan_nodes (id, plan_id, parent_id, level, ord, type, title, prompt, settings_json, condition_json, enabled, est_cost_usd, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.planId,
      nullable(input.parentId),
      input.level,
      input.ord,
      input.type,
      input.title,
      input.prompt ?? "",
      toJson(input.settings ?? {}),
      input.condition === undefined ? null : toJson(input.condition),
      input.enabled === false ? 0 : 1,
      nullable(input.estCostUsd),
      now,
      now,
    );
    return (await this.getNode(id))!;
  }

  async getNode(id: string): Promise<PlanNode | undefined> {
    const row = await first<NodeRow>(this.ctx.db, "SELECT * FROM plan_nodes WHERE id = ?", id);
    return row ? nodeFromRow(row) : undefined;
  }

  /** In run order: by level, then position within the level. */
  async listNodes(planId: string): Promise<PlanNode[]> {
    return (await all<NodeRow>(this.ctx.db, "SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY level, ord, id", planId)).map(nodeFromRow);
  }

  /** Status and cost may change at any time; anything else only before Start. */
  async updateNode(id: string, patch: PlanNodePatch): Promise<PlanNode | undefined> {
    checkNode(patch);
    if (patch.status) oneOf(patch.status, NODE_STATUSES, "status");
    const structural = Object.keys(patch).some((key) => key !== "status" && key !== "estCostUsd" && patch[key as keyof PlanNodePatch] !== undefined);
    if (structural) await this.assertEditableNode(id);
    const set = assignments(patch, {
      parentId: ["parent_id"],
      level: ["level"],
      ord: ["ord"],
      type: ["type"],
      title: ["title"],
      prompt: ["prompt"],
      settings: ["settings_json", toJson],
      condition: ["condition_json", toJson],
      enabled: ["enabled", (value) => (value ? 1 : 0)],
      estCostUsd: ["est_cost_usd"],
      status: ["status"],
    });
    await run(this.ctx.db, `UPDATE plan_nodes SET ${[...set.sql, "updated_at = ?"].join(", ")} WHERE id = ?`, ...set.values, this.ctx.now(), id);
    return this.getNode(id);
  }

  /**
   * The one change a started plan's item takes (a stopped plan's "Change
   * maker for what's left"): only the setting keys in `keys` (the maker's
   * agent and the reviewer's, agent-fields.ts) of an item not made, in a
   * plan stopped (`cancelled`) or `failed`. A value null removes the key.
   * Compare-and-set on the item's settings and status and the plan's
   * status, so a resume or a finish that lands meanwhile wins; undefined
   * then, and when the item is not there.
   */
  async setMakerAfterStart(planId: string, nodeId: string, keys: Record<string, JsonValue | null>): Promise<PlanNode | undefined> {
    const row = await first<NodeRow>(this.ctx.db, "SELECT * FROM plan_nodes WHERE id = ? AND plan_id = ?", nodeId, planId);
    if (!row || row.status === "done") return undefined;
    const settings = { ...fromJson<Record<string, JsonValue>>(row.settings_json, {}) };
    for (const [key, value] of Object.entries(keys)) {
      if (value === null) delete settings[key];
      else settings[key] = value;
    }
    const written = await first<{ id: string }>(
      this.ctx.db,
      "UPDATE plan_nodes SET settings_json = ?, updated_at = ? WHERE id = ? AND plan_id = ? AND status = ? AND settings_json = ? " +
        "AND (SELECT status FROM plans WHERE id = ?) IN ('cancelled', 'failed') RETURNING id",
      toJson(settings),
      this.ctx.now(),
      nodeId,
      planId,
      row.status,
      row.settings_json,
      planId,
    );
    return written ? this.getNode(nodeId) : undefined;
  }

  /**
   * Sets level and position of several items of one plan in one
   * transaction. A plan started meanwhile refuses all of them.
   */
  async moveNodes(planId: string, moves: Array<{ id: string; level: number; ord: number }>): Promise<void> {
    for (const move of moves) checkNode(move);
    await this.assertEditable(planId);
    const db = this.ctx.db;
    const now = this.ctx.now();
    await runAll(
      db,
      moves.map((move) =>
        db
          .prepare(
            "UPDATE plan_nodes SET level = ?, ord = ?, updated_at = ? WHERE id = ? AND plan_id = ? AND (SELECT kicked_off_at FROM plans WHERE id = ?) IS NULL",
          )
          .bind(move.level, move.ord, now, move.id, planId, planId),
      ),
    );
  }

  async deleteNode(id: string): Promise<void> {
    await this.assertEditableNode(id);
    await run(this.ctx.db, "DELETE FROM plan_nodes WHERE id = ?", id);
  }

  /**
   * Replaces the item's sources, in one transaction where the binding
   * allows. It is an edit of the item, so the item's `updatedAt` moves
   * (a chat changing the plan reads it to leave hand edits alone).
   */
  async setNodeSources(nodeId: string, sources: Array<{ sourceId: string; range?: SourceLocator }>): Promise<PlanNodeSource[]> {
    await this.assertEditableNode(nodeId);
    const db = this.ctx.db;
    await runAll(db, [
      db.prepare("UPDATE plan_nodes SET updated_at = ? WHERE id = ?").bind(this.ctx.now(), nodeId),
      db.prepare("DELETE FROM plan_node_sources WHERE node_id = ?").bind(nodeId),
      ...sources.map((source) =>
        db
          .prepare("INSERT INTO plan_node_sources (node_id, source_id, range_json) VALUES (?, ?, ?)")
          .bind(nodeId, source.sourceId, source.range ? toJson(source.range) : null),
      ),
    ]);
    return this.listNodeSources(nodeId);
  }

  async listNodeSources(nodeId: string): Promise<PlanNodeSource[]> {
    const rows = await all<{ node_id: string; source_id: string; range_json: string | null }>(
      this.ctx.db,
      "SELECT * FROM plan_node_sources WHERE node_id = ? ORDER BY source_id",
      nodeId,
    );
    return rows.map((row) =>
      compact({ nodeId: row.node_id, sourceId: row.source_id, range: row.range_json ? fromJson<SourceLocator>(row.range_json, {}) : undefined }),
    );
  }

  async addEdge(edge: PlanEdge): Promise<void> {
    if (!isEdgeKind(edge.kind)) throw new InvalidRecordError(`"${edge.kind}" is not an edge kind.`);
    if (edge.fromNode === edge.toNode) throw new InvalidRecordError("A node cannot depend on itself.");
    const [from, to] = await Promise.all([this.getNode(edge.fromNode), this.getNode(edge.toNode)]);
    if (from && to && from.planId !== to.planId) throw new InvalidRecordError("Edges join nodes of one plan.");
    if (to) await this.assertEditable(to.planId);
    await run(
      this.ctx.db,
      "INSERT INTO plan_edges (from_node, to_node, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      edge.fromNode,
      edge.toNode,
      edge.kind,
    );
  }

  async removeEdge(edge: PlanEdge): Promise<void> {
    await run(this.ctx.db, "DELETE FROM plan_edges WHERE from_node = ? AND to_node = ? AND kind = ?", edge.fromNode, edge.toNode, edge.kind);
  }

  /**
   * Labels a stage, or clears its label with null or blank text. Display
   * only, so allowed after Start like the plan's title.
   */
  async setStageLabel(planId: string, level: number, label: string | null): Promise<PlanStage[]> {
    checkNode({ level });
    const text = label?.trim();
    if (text) {
      await run(
        this.ctx.db,
        "INSERT INTO plan_stages (plan_id, level, label) VALUES (?, ?, ?) ON CONFLICT (plan_id, level) DO UPDATE SET label = excluded.label",
        planId,
        level,
        text,
      );
    } else {
      await run(this.ctx.db, "DELETE FROM plan_stages WHERE plan_id = ? AND level = ?", planId, level);
    }
    return this.listStages(planId);
  }

  /** Labelled stages, lowest level first. */
  async listStages(planId: string): Promise<PlanStage[]> {
    const rows = await all<{ plan_id: string; level: number; label: string }>(
      this.ctx.db,
      "SELECT * FROM plan_stages WHERE plan_id = ? ORDER BY level",
      planId,
    );
    return rows.map((row) => ({ planId: row.plan_id, level: row.level, label: row.label }));
  }

  /**
   * Dates a stage, or clears its date with null. Like a label it is display
   * and reminders only, so it may change after Start.
   */
  async setStageDate(planId: string, level: number, dueOn: string | null): Promise<PlanStageDate[]> {
    checkNode({ level });
    if (dueOn === null) {
      await run(this.ctx.db, "DELETE FROM plan_stage_dates WHERE plan_id = ? AND level = ?", planId, level);
    } else {
      if (!isDay(dueOn)) throw new InvalidRecordError("dueOn must be a day written YYYY-MM-DD.");
      await run(
        this.ctx.db,
        "INSERT INTO plan_stage_dates (plan_id, level, due_on) VALUES (?, ?, ?) ON CONFLICT (plan_id, level) DO UPDATE SET due_on = excluded.due_on",
        planId,
        level,
        dueOn,
      );
    }
    return this.listStageDates(planId);
  }

  /** Dated stages, lowest level first. */
  async listStageDates(planId: string): Promise<PlanStageDate[]> {
    const rows = await all<{ plan_id: string; level: number; due_on: string }>(
      this.ctx.db,
      "SELECT * FROM plan_stage_dates WHERE plan_id = ? ORDER BY level",
      planId,
    );
    return rows.map((row) => ({ planId: row.plan_id, level: row.level, dueOn: row.due_on }));
  }

  /**
   * Every dated stage of the owner's plans that can still be gone through:
   * not discarded or cancelled, not made for one thing at once, not
   * superseded by a newer version, in a project that is not archived.
   * Earliest day first.
   */
  async listDatedStages(ownerId: string): Promise<DatedStage[]> {
    const rows = await all<{ plan_id: string; project_id: string; level: number; due_on: string }>(
      this.ctx.db,
      "SELECT d.plan_id, p.project_id, d.level, d.due_on FROM plan_stage_dates d " +
        "JOIN plans p ON p.id = d.plan_id JOIN projects j ON j.id = p.project_id " +
        "WHERE p.owner_id = ? AND p.status NOT IN ('discarded', 'cancelled') AND p.direct = 0 AND j.archived_at IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM plans n WHERE n.supersedes_plan_id = p.id AND n.status <> 'discarded') " +
        "ORDER BY d.due_on, p.created_at, d.plan_id, d.level",
      ownerId,
    );
    return rows.map((row) => ({ planId: row.plan_id, projectId: row.project_id, level: row.level, dueOn: row.due_on }));
  }

  /**
   * A started plan is never edited; a
   * changed plan is a new row that supersedes it (0004).
   */
  private async assertEditable(planId: string): Promise<void> {
    const plan = await first<{ kicked_off_at: string | null }>(this.ctx.db, "SELECT kicked_off_at FROM plans WHERE id = ?", planId);
    if (plan?.kicked_off_at) throw new PlanLockedError(planId);
  }

  private async assertEditableNode(nodeId: string): Promise<void> {
    const node = await first<{ plan_id: string }>(this.ctx.db, "SELECT plan_id FROM plan_nodes WHERE id = ?", nodeId);
    if (node) await this.assertEditable(node.plan_id);
  }

  async listEdges(planId: string): Promise<PlanEdge[]> {
    const rows = await all<{ from_node: string; to_node: string; kind: string }>(
      this.ctx.db,
      "SELECT e.* FROM plan_edges e JOIN plan_nodes n ON n.id = e.to_node WHERE n.plan_id = ? ORDER BY e.from_node, e.to_node, e.kind",
      planId,
    );
    return rows.map((row) => ({ fromNode: row.from_node, toNode: row.to_node, kind: row.kind }));
  }
}

function checkNode(node: { type?: string; level?: number; ord?: number; title?: string }): void {
  if (node.type !== undefined && !isFormatId(node.type)) throw new InvalidRecordError(`"${node.type}" is not a format id.`);
  if (node.level !== undefined && !(Number.isInteger(node.level) && node.level >= 0)) {
    throw new InvalidRecordError("level must be a non-negative integer.");
  }
  if (node.ord !== undefined && !Number.isInteger(node.ord)) throw new InvalidRecordError("ord must be an integer.");
  if (node.title !== undefined && !node.title.trim()) throw new InvalidRecordError("A node needs a title.");
}

function planFromRow(row: PlanRow): Plan {
  return compact({
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    sessionId: opt(row.session_id),
    supersedesPlanId: opt(row.supersedes_plan_id),
    version: row.version,
    title: opt(row.title),
    status: row.status === "cancelled" && row.kicked_off_at === null ? "discarded" : oneOf(row.status, PLAN_STATUSES, "status"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kickedOffAt: opt(row.kicked_off_at),
    budgetUsd: opt(row.budget_usd),
    direct: row.direct ? true : undefined,
  });
}

function nodeFromRow(row: NodeRow): PlanNode {
  return compact({
    id: row.id,
    planId: row.plan_id,
    parentId: opt(row.parent_id),
    level: row.level,
    ord: row.ord,
    type: row.type,
    title: row.title,
    prompt: row.prompt,
    settings: fromJson<Settings>(row.settings_json, {}),
    condition: row.condition_json === null ? undefined : fromJson<JsonValue>(row.condition_json, null),
    enabled: bool(row.enabled),
    estCostUsd: opt(row.est_cost_usd),
    status: oneOf(row.status, NODE_STATUSES, "status"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
