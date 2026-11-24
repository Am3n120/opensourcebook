/**
 * `outputs` (migrations/0004): one generated thing. Regenerating an item adds
 * a row; the newest wins. Prompt, settings and sources are copied in at
 * generation time so "view brief and sources" stays true after edits.
 */
import { assetIdsIn } from "../../assets";
import { withoutRemotePictures } from "../../cards/pictures";
import { isFormatId, type Citation, type FormatId, type JsonValue, type SourceLocator } from "../types";
import type { Settings } from "./projects";
import {
  InvalidRecordError,
  afterKey,
  all,
  compact,
  first,
  fromJson,
  nullable,
  opt,
  run,
  toJson,
  toPage,
  type Page,
  type PageQuery,
  type RepositoryContext,
} from "./shared";

export interface OutputSourceUse {
  sourceId: string;
  range?: SourceLocator;
}

export interface Output<Payload = JsonValue> {
  id: string;
  ownerId: string;
  projectId?: string;
  nodeId?: string;
  /** As stored; may be an id no registry knows (shown neutrally, never rejected). */
  type: FormatId;
  /** OutputEngine.schemaVersion that wrote the payload. */
  schemaVersion: number;
  title: string;
  /** What later items are told this output covered. */
  summary: string;
  category?: string;
  payload: Payload;
  citations: Citation[];
  prompt?: string;
  settings?: Settings;
  sources: OutputSourceUse[];
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface NewOutput<Payload = unknown> {
  ownerId: string;
  projectId?: string;
  nodeId?: string;
  type: FormatId;
  schemaVersion: number;
  title: string;
  summary?: string;
  category?: string;
  payload: Payload;
  citations?: Citation[];
  prompt?: string;
  settings?: Settings;
  sources?: OutputSourceUse[];
  costUsd?: number;
}

/**
 * An output with the plan its item belongs to, as lists show it, and whether
 * the person ticked it done: true when their item's done tick names this
 * output, or names none and this is the item's newest (as the plan view
 * picks it). Absent when it was not made from a plan item.
 */
export type PlacedOutput<Payload = JsonValue> = Output<Payload> & { planId?: string; done?: boolean };

/** The columns `placedFromRow` reads besides the output's own, over `outputs o` joined to its item `n` and the item's result `r`. */
const PLACED_COLUMNS =
  "o.*, n.plan_id AS plan_id, " +
  "CASE WHEN o.node_id IS NULL THEN NULL WHEN r.done_at IS NULL THEN 0 WHEN r.output_id IS NOT NULL THEN r.output_id = o.id " +
  "ELSE NOT EXISTS (SELECT 1 FROM outputs newer WHERE newer.node_id = o.node_id AND newer.archived_at IS NULL " +
  "AND (newer.created_at > o.created_at OR (newer.created_at = o.created_at AND newer.rowid > o.rowid))) END AS item_done";
const RESULT_JOIN = "LEFT JOIN item_results r ON r.node_id = o.node_id";

type PlacedRow = OutputRow & { plan_id: string | null; item_done: number | null };

/** Which outputs a Library page shows. `projectId: null` is things made outside any project. */
export interface OutputFilter {
  ownerId: string;
  projectId?: string | null;
  /** Any of these stored types: a format's id and its old aliases. */
  types?: FormatId[];
  /** Words its title or summary contains, any case. */
  search?: string;
}

interface OutputRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  node_id: string | null;
  type: string;
  schema_version: number;
  title: string;
  summary: string;
  category: string | null;
  payload_json: string;
  citations_json: string;
  prompt: string | null;
  settings_json: string | null;
  sources_json: string;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** The outputs a plan's items made. */
const MADE_BY_PLAN = "node_id IN (SELECT id FROM plan_nodes WHERE plan_id = ?)";

export class OutputRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create<Payload>(input: NewOutput<Payload>): Promise<Output<Payload>> {
    if (!isFormatId(input.type)) throw new InvalidRecordError(`"${input.type}" is not a format id.`);
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new InvalidRecordError("schemaVersion must be a positive integer.");
    }
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO outputs (id, owner_id, project_id, node_id, type, schema_version, title, summary, category, payload_json, citations_json, prompt, settings_json, sources_json, cost_usd, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      nullable(input.projectId),
      nullable(input.nodeId),
      input.type,
      input.schemaVersion,
      input.title,
      input.summary ?? "",
      nullable(input.category),
      // A picture that is not one Open Sourcebook keeps is never stored (cards/pictures.ts), from a maker or an imported project.
      toJson(withoutRemotePictures(input.payload)),
      toJson(input.citations ?? []),
      nullable(input.prompt),
      input.settings === undefined ? null : toJson(input.settings),
      toJson(input.sources ?? []),
      nullable(input.costUsd),
      now,
      now,
    );
    return (await this.get<Payload>(id))!;
  }

  async get<Payload = JsonValue>(id: string): Promise<Output<Payload> | undefined> {
    const row = await first<OutputRow>(this.ctx.db, "SELECT * FROM outputs WHERE id = ?", id);
    return row ? fromRow<Payload>(row) : undefined;
  }

  /** The newest output for an item: what the plan shows. */
  async latestForNode<Payload = JsonValue>(nodeId: string): Promise<Output<Payload> | undefined> {
    const row = await first<OutputRow>(
      this.ctx.db,
      "SELECT * FROM outputs WHERE node_id = ? AND archived_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      nodeId,
    );
    return row ? fromRow<Payload>(row) : undefined;
  }

  async listByProject(projectId: string): Promise<Output[]> {
    return (
      await all<OutputRow>(this.ctx.db, "SELECT * FROM outputs WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at, rowid", projectId)
    ).map((row) => fromRow(row));
  }

  /** The Library: everything made, newest first, optionally one format. */
  async listByOwner(ownerId: string, options: { type?: FormatId; limit?: number } = {}): Promise<Output[]> {
    const rows = await all<OutputRow>(
      this.ctx.db,
      `SELECT * FROM outputs WHERE owner_id = ? AND archived_at IS NULL${options.type ? " AND type = ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ownerId,
      ...(options.type ? [options.type] : []),
      options.limit ?? 100,
    );
    return rows.map((row) => fromRow(row));
  }

  /** One page of outputs, newest first, archived ones left out, each with its item's plan. */
  async page(filter: OutputFilter, query: PageQuery): Promise<Page<PlacedOutput>> {
    const where = ["o.owner_id = ?", "o.archived_at IS NULL"];
    const values: unknown[] = [filter.ownerId];
    if (filter.projectId === null) where.push("o.project_id IS NULL");
    else if (filter.projectId !== undefined) {
      where.push("o.project_id = ?");
      values.push(filter.projectId);
    }
    if (filter.types !== undefined && filter.types.length > 0) {
      where.push(`o.type IN (${filter.types.map(() => "?").join(", ")})`);
      values.push(...filter.types);
    }
    // Every word must be in the title or the summary; LIKE's own marks are taken literally.
    for (const word of (filter.search ?? "").split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${word.replace(/[\\%_]/g, (mark) => `\\${mark}`)}%`;
      where.push("(o.title LIKE ? ESCAPE '\\' OR o.summary LIKE ? ESCAPE '\\')");
      values.push(like, like);
    }
    const after = afterKey("o.created_at", "o.id", "DESC", query.after);
    const rows = await all<PlacedRow>(
      this.ctx.db,
      `SELECT ${PLACED_COLUMNS} FROM outputs o LEFT JOIN plan_nodes n ON n.id = o.node_id ${RESULT_JOIN} ` +
        `WHERE ${where.join(" AND ")}${after.sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
      ...values,
      ...after.values,
      query.limit + 1,
    );
    return toPage(rows.map((row) => placedFromRow<JsonValue>(row)), query.limit, (output) => [output.createdAt, output.id]);
  }

  /** A plan's outputs, archived ones left out: in item run order, newest first within an item. */
  async listByPlan(planId: string): Promise<PlacedOutput[]> {
    const rows = await all<PlacedRow>(
      this.ctx.db,
      `SELECT ${PLACED_COLUMNS} FROM outputs o JOIN plan_nodes n ON n.id = o.node_id ${RESULT_JOIN} ` +
        "WHERE n.plan_id = ? AND o.archived_at IS NULL ORDER BY n.level, n.ord, n.id, o.created_at DESC, o.rowid DESC",
      planId,
    );
    return rows.map((row) => placedFromRow<JsonValue>(row));
  }

  /** One output with its item's plan, archived or not. */
  async getPlaced<Payload = JsonValue>(id: string): Promise<PlacedOutput<Payload> | undefined> {
    const row = await first<PlacedRow>(
      this.ctx.db,
      `SELECT ${PLACED_COLUMNS} FROM outputs o LEFT JOIN plan_nodes n ON n.id = o.node_id ${RESULT_JOIN} WHERE o.id = ?`,
      id,
    );
    return row ? placedFromRow<Payload>(row) : undefined;
  }

  async setCost(id: string, costUsd: number): Promise<void> {
    await run(this.ctx.db, "UPDATE outputs SET cost_usd = ?, updated_at = ? WHERE id = ?", costUsd, this.ctx.now(), id);
  }

  /** Keeps a made output as the person changed it by hand: its payload, citations and title (`FormatDefinition.edit`). */
  async setEdited(id: string, change: { payload: unknown; citations: Citation[]; title: string }): Promise<void> {
    await run(this.ctx.db, "UPDATE outputs SET payload_json = ?, citations_json = ?, title = ?, updated_at = ? WHERE id = ?", toJson(withoutRemotePictures(change.payload)), toJson(change.citations), change.title, this.ctx.now(), id);
  }

  async setCategory(id: string, category: string | null): Promise<void> {
    await run(this.ctx.db, "UPDATE outputs SET category = ?, updated_at = ? WHERE id = ?", category, this.ctx.now(), id);
  }

  async archive(id: string): Promise<void> {
    const now = this.ctx.now();
    await run(this.ctx.db, "UPDATE outputs SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, id);
  }

  /** Deletes everything made in a project (the project is being deleted). Answers how many. */
  /** Everything made in the project, archived too: what `deleteByProject` deletes. */
  async countByProject(projectId: string): Promise<number> {
    const row = await first<{ n: number }>(this.ctx.db, "SELECT COUNT(*) AS n FROM outputs WHERE project_id = ?", projectId);
    return row?.n ?? 0;
  }

  /** Every kept file (`/v1/assets/<id>`) the things made in a project point at: a video's or an audio's file, its pictures. */
  async filesByProject(projectId: string): Promise<string[]> {
    const rows = await all<{ payload_json: string }>(this.ctx.db, "SELECT payload_json FROM outputs WHERE project_id = ?", projectId);
    return [...new Set(rows.flatMap((row) => assetIdsIn(row.payload_json)))];
  }

  /**
   * Whether anything kept still points at a kept file: a made thing, a
   * source's reading or its chunks, a chat message, an item's result or
   * progress, or a job not finished yet. Files are kept by their content, so
   * the same file may belong to more than one of these.
   */
  async fileInUse(assetId: string): Promise<boolean> {
    const places: Array<[table: string, columns: string[], where?: string]> = [
      ["outputs", ["payload_json", "citations_json"]],
      ["source_extractions", ["envelope_json"]],
      ["source_chunks", ["text", "locator_json"]],
      ["messages", ["content_json", "citations_json", "mentions_json"]],
      ["item_results", ["result_json", "progress_json"]],
      ["generation_jobs", ["input_json", "state_json"], "status IN ('queued', 'running', 'failed')"],
    ];
    const checks = places.map(([table, columns, where]) => `EXISTS (SELECT 1 FROM ${table} WHERE ${where ? `${where} AND ` : ""}(${columns.map((column) => `instr(${column}, ?) > 0`).join(" OR ")}))`);
    const binds = places.flatMap(([, columns]) => columns.map(() => assetId));
    const row = await first<{ used: number }>(this.ctx.db, `SELECT (${checks.join(" OR ")}) AS used`, ...binds);
    return row?.used === 1;
  }

  /** Every kept file the things a plan's items made point at (the plan is being deleted). */
  async filesByPlan(planId: string): Promise<string[]> {
    const rows = await all<{ payload_json: string }>(this.ctx.db, `SELECT payload_json FROM outputs WHERE ${MADE_BY_PLAN}`, planId);
    return [...new Set(rows.flatMap((row) => assetIdsIn(row.payload_json)))];
  }

  /** Deletes everything a plan's items made, archived too (the plan is being deleted). Answers how many. */
  async deleteByPlan(planId: string): Promise<number> {
    const row = await first<{ n: number }>(this.ctx.db, `SELECT COUNT(*) AS n FROM outputs WHERE ${MADE_BY_PLAN}`, planId);
    await run(this.ctx.db, `DELETE FROM outputs WHERE ${MADE_BY_PLAN}`, planId);
    return row?.n ?? 0;
  }

  async deleteByProject(projectId: string): Promise<number> {
    const count = await this.countByProject(projectId);
    await run(this.ctx.db, "DELETE FROM outputs WHERE project_id = ?", projectId);
    return count;
  }
}

function fromRow<Payload>(row: OutputRow): Output<Payload> {
  return compact({
    id: row.id,
    ownerId: row.owner_id,
    projectId: opt(row.project_id),
    nodeId: opt(row.node_id),
    type: row.type,
    schemaVersion: row.schema_version,
    title: row.title,
    summary: row.summary,
    category: opt(row.category),
    // An output stored before pictures had to be kept draws without the remote ones.
    payload: withoutRemotePictures(JSON.parse(row.payload_json)) as Payload,
    citations: fromJson<Citation[]>(row.citations_json, []),
    prompt: opt(row.prompt),
    settings: row.settings_json === null ? undefined : fromJson<Settings>(row.settings_json, {}),
    sources: fromJson<OutputSourceUse[]>(row.sources_json, []),
    costUsd: opt(row.cost_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: opt(row.archived_at),
  });
}

function placedFromRow<Payload>(row: PlacedRow): PlacedOutput<Payload> {
  return compact({ ...fromRow<Payload>(row), planId: opt(row.plan_id), done: row.item_done === null || row.item_done === undefined ? undefined : row.item_done === 1 });
}
