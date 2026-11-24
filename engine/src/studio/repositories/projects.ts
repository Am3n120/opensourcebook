/** `projects` (migrations/0004_studio.sql). */
import type { JsonValue } from "../types";
import {
  afterKey,
  all,
  assignments,
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

/** Which projects a list shows: the live ones (default), all, or only archived. */
export type ArchivedFilter = "exclude" | "include" | "only";

export type Settings = { [key: string]: JsonValue };

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  icon?: string;
  colorHex?: number;
  category?: string;
  settings: Settings;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface NewProject {
  ownerId: string;
  title: string;
  icon?: string;
  colorHex?: number;
  category?: string;
  settings?: Settings;
}

export interface ProjectPatch {
  title?: string;
  icon?: string | null;
  colorHex?: number | null;
  category?: string | null;
  settings?: Settings;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  icon: string | null;
  color_hex: number | null;
  category: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class ProjectRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: NewProject): Promise<Project> {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO projects (id, owner_id, title, icon, color_hex, category, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      input.title,
      nullable(input.icon),
      nullable(input.colorHex),
      nullable(input.category),
      toJson(input.settings ?? {}),
      now,
      now,
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Project | undefined> {
    const row = await first<ProjectRow>(this.ctx.db, "SELECT * FROM projects WHERE id = ?", id);
    return row ? fromRow(row) : undefined;
  }

  /** Most recently updated first. Archived projects only when asked. */
  async listByOwner(ownerId: string, options: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const rows = await all<ProjectRow>(
      this.ctx.db,
      `SELECT * FROM projects WHERE owner_id = ?${options.includeArchived ? "" : " AND archived_at IS NULL"} ORDER BY updated_at DESC, id`,
      ownerId,
    );
    return rows.map(fromRow);
  }

  /** One page of an owner's projects, most recently updated first. */
  async page(ownerId: string, query: PageQuery, archived: ArchivedFilter = "exclude"): Promise<Page<Project>> {
    const filter = { exclude: " AND archived_at IS NULL", include: "", only: " AND archived_at IS NOT NULL" }[archived];
    const after = afterKey("updated_at", "id", "DESC", query.after);
    const rows = await all<ProjectRow>(
      this.ctx.db,
      `SELECT * FROM projects WHERE owner_id = ?${filter}${after.sql} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ownerId,
      ...after.values,
      query.limit + 1,
    );
    return toPage(rows.map(fromRow), query.limit, (project) => [project.updatedAt, project.id]);
  }

  async update(id: string, patch: ProjectPatch): Promise<Project | undefined> {
    const set = assignments(patch, {
      title: ["title"],
      icon: ["icon"],
      colorHex: ["color_hex"],
      category: ["category"],
      settings: ["settings_json", toJson],
    });
    await run(
      this.ctx.db,
      `UPDATE projects SET ${[...set.sql, "updated_at = ?"].join(", ")} WHERE id = ?`,
      ...set.values,
      this.ctx.now(),
      id,
    );
    return this.get(id);
  }

  async archive(id: string): Promise<Project | undefined> {
    const now = this.ctx.now();
    await run(this.ctx.db, "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", now, now, id);
    return this.get(id);
  }

  /** Brings an archived project back; its first archive time is not kept. */
  async unarchive(id: string): Promise<Project | undefined> {
    await run(this.ctx.db, "UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL", this.ctx.now(), id);
    return this.get(id);
  }

  /** Its sources go back to the Inbox; chats and plans go with it (0004 foreign keys). */
  async delete(id: string): Promise<void> {
    await run(this.ctx.db, "DELETE FROM projects WHERE id = ?", id);
  }
}

function fromRow(row: ProjectRow): Project {
  return compact({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    icon: opt(row.icon),
    colorHex: opt(row.color_hex),
    category: opt(row.category),
    settings: fromJson<Settings>(row.settings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: opt(row.archived_at),
  });
}
