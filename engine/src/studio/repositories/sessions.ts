/** `sessions` and `messages` (migrations/0004): saved chats. */
import type { Citation, JsonValue } from "../types";
import type { Settings } from "./projects";
import {
  all,
  assignments,
  compact,
  first,
  fromJson,
  nullable,
  oneOf,
  opt,
  run,
  toJson,
  type RepositoryContext,
} from "./shared";

export const MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Something pulled into a message with @: a plan, item, source or past chat. */
export interface Mention {
  kind: string;
  id: string;
  label?: string;
}

export interface Session {
  id: string;
  ownerId: string;
  /** Absent for a chat that is not about a project. */
  projectId?: string;
  title?: string;
  settings: Settings;
  createdAt: string;
  updatedAt: string;
  /** Set while a reply is being written in this chat (migration 0007). */
  busySince?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  /** Position in the chat, from 0. */
  seq: number;
  role: MessageRole;
  content: JsonValue;
  mentions?: Mention[];
  citations?: Citation[];
  createdAt: string;
}

export interface NewMessage {
  role: MessageRole;
  content: JsonValue;
  mentions?: Mention[];
  citations?: Citation[];
}

interface SessionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
  busy_since: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content_json: string;
  mentions_json: string | null;
  citations_json: string | null;
  created_at: string;
}

export class SessionRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: { ownerId: string; projectId?: string; title?: string; settings?: Settings }): Promise<Session> {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO sessions (id, owner_id, project_id, title, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      nullable(input.projectId),
      nullable(input.title),
      toJson(input.settings ?? {}),
      now,
      now,
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Session | undefined> {
    const row = await first<SessionRow>(this.ctx.db, "SELECT * FROM sessions WHERE id = ?", id);
    return row ? sessionFromRow(row) : undefined;
  }

  async listByProject(projectId: string): Promise<Session[]> {
    return (await all<SessionRow>(this.ctx.db, "SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC, id", projectId)).map(
      sessionFromRow,
    );
  }

  async update(id: string, patch: { title?: string | null; settings?: Settings }): Promise<Session | undefined> {
    const set = assignments(patch, { title: ["title"], settings: ["settings_json", toJson] });
    await run(this.ctx.db, `UPDATE sessions SET ${[...set.sql, "updated_at = ?"].join(", ")} WHERE id = ?`, ...set.values, this.ctx.now(), id);
    return this.get(id);
  }

  /** Deletes the chat and its messages (0004 foreign keys). Plans it made keep going, with no chat. */
  async delete(id: string): Promise<void> {
    await run(this.ctx.db, "DELETE FROM sessions WHERE id = ?", id);
  }

  /**
   * Replaces the chat's settings without counting as use of the chat, so a
   * chat list ordered by last use does not move (a removed source unticked).
   */
  async replaceSettingsQuietly(id: string, settings: Settings): Promise<void> {
    await run(this.ctx.db, "UPDATE sessions SET settings_json = ? WHERE id = ?", toJson(settings), id);
  }

  /**
   * Marks the chat busy for one turn, in one statement, unless another turn
   * holds it and started after `staleBefore`. Answers whether this caller
   * got it.
   */
  async claimTurn(id: string, staleBefore: string): Promise<boolean> {
    const row = await first<{ id: string }>(
      this.ctx.db,
      "UPDATE sessions SET busy_since = ? WHERE id = ? AND (busy_since IS NULL OR busy_since < ?) RETURNING id",
      this.ctx.now(),
      id,
      staleBefore,
    );
    return row !== undefined;
  }

  async releaseTurn(id: string): Promise<void> {
    await run(this.ctx.db, "UPDATE sessions SET busy_since = NULL WHERE id = ?", id);
  }

  /** How many messages each chat holds. Chats with none are absent. */
  async countMessages(sessionIds: string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await all<{ session_id: string; n: number }>(
      this.ctx.db,
      `SELECT session_id, COUNT(*) AS n FROM messages WHERE session_id IN (${sessionIds.map(() => "?").join(", ")}) GROUP BY session_id`,
      ...sessionIds,
    );
    return new Map(rows.map((row) => [row.session_id, row.n]));
  }

  /** The last `limit` messages, oldest first. */
  async recentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const rows = await all<MessageRow>(this.ctx.db, "SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?", sessionId, limit);
    return rows.reverse().map(messageFromRow);
  }

  /**
   * Appends at the next position. The position is computed inside the
   * INSERT, so two appends racing on one chat cannot take the same seq;
   * the loser hits UNIQUE (session_id, seq) and tries the next one.
   */
  async append(sessionId: string, message: NewMessage): Promise<Message> {
    oneOf(message.role, MESSAGE_ROLES, "role");
    const now = this.ctx.now();
    for (let tries = 0; tries < 5; tries += 1) {
      const id = this.ctx.newId();
      try {
        const row = await this.ctx.db
          .prepare(
            "INSERT INTO messages (id, session_id, seq, role, content_json, mentions_json, citations_json, created_at) " +
              "SELECT ?, ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?, ?, ? FROM messages WHERE session_id = ? RETURNING *",
          )
          .bind(
            id,
            sessionId,
            message.role,
            toJson(message.content),
            message.mentions ? toJson(message.mentions) : null,
            message.citations ? toJson(message.citations) : null,
            now,
            sessionId,
          )
          .first<MessageRow>();
        await run(this.ctx.db, "UPDATE sessions SET updated_at = ? WHERE id = ?", now, sessionId);
        return messageFromRow(row!);
      } catch (error) {
        if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    throw new Error(`Could not append to session ${sessionId}: positions kept colliding.`);
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const row = await first<MessageRow>(this.ctx.db, "SELECT * FROM messages WHERE id = ?", id);
    return row ? messageFromRow(row) : undefined;
  }

  /** Replaces a message's content: a reply that was running, once it is written. */
  async updateContent(id: string, content: JsonValue): Promise<Message | undefined> {
    await run(this.ctx.db, "UPDATE messages SET content_json = ? WHERE id = ?", toJson(content), id);
    return this.getMessage(id);
  }

  /**
   * Writes `content` only while the value at `path` in the stored content
   * (a JSON path such as `$.pieces[2].state`) is still `equals`, in one
   * statement, so of two callers only one wins. The message when it was
   * written, undefined when another write got there first.
   */
  async updateContentIf(id: string, content: JsonValue, path: string, equals: string): Promise<Message | undefined> {
    const result = await this.ctx.db
      .prepare("UPDATE messages SET content_json = ? WHERE id = ? AND json_extract(content_json, ?) = ?")
      .bind(toJson(content), id, path, equals)
      .run();
    return changesOf(result) > 0 ? this.getMessage(id) : undefined;
  }

  /**
   * The thread on one made thing (chat/threads.ts): the chat's messages about
   * that item (`content.about.item`), the person's and the replies, in order.
   */
  async listAbout(sessionId: string, itemId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<Message[]> {
    const rows = await all<MessageRow>(
      this.ctx.db,
      "SELECT * FROM messages WHERE session_id = ? AND json_extract(content_json, '$.about.item') = ? AND seq > ? ORDER BY seq LIMIT ?",
      sessionId,
      itemId,
      options.afterSeq ?? -1,
      options.limit ?? 500,
    );
    return rows.map(messageFromRow);
  }

  /** Every thread of an owner's chats (one project's, when given): the item, its chat and how many messages it holds. */
  async countAbout(ownerId: string, projectId?: string): Promise<Array<{ itemId: string; sessionId: string; count: number; lastAt: string }>> {
    const rows = await all<{ item: string; session_id: string; n: number; last_at: string }>(
      this.ctx.db,
      "SELECT json_extract(m.content_json, '$.about.item') AS item, m.session_id, COUNT(*) AS n, MAX(m.created_at) AS last_at " +
        "FROM messages m JOIN sessions s ON s.id = m.session_id " +
        `WHERE s.owner_id = ?${projectId ? " AND s.project_id = ?" : ""} AND json_extract(m.content_json, '$.about.item') IS NOT NULL ` +
        "GROUP BY item, m.session_id",
      ownerId,
      ...(projectId ? [projectId] : []),
    );
    return rows.filter((row) => typeof row.item === "string").map((row) => ({ itemId: row.item, sessionId: row.session_id, count: row.n, lastAt: row.last_at }));
  }

  async listMessages(sessionId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<Message[]> {
    const rows = await all<MessageRow>(
      this.ctx.db,
      "SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      sessionId,
      options.afterSeq ?? -1,
      options.limit ?? 500,
    );
    return rows.map(messageFromRow);
  }
}

function sessionFromRow(row: SessionRow): Session {
  return compact({
    id: row.id,
    ownerId: row.owner_id,
    projectId: opt(row.project_id),
    title: opt(row.title),
    settings: fromJson<Settings>(row.settings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    busySince: opt(row.busy_since ?? null),
  });
}

function messageFromRow(row: MessageRow): Message {
  return compact({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: oneOf(row.role, MESSAGE_ROLES, "role"),
    content: fromJson<JsonValue>(row.content_json, null),
    mentions: row.mentions_json === null ? undefined : fromJson<Mention[]>(row.mentions_json, []),
    citations: row.citations_json === null ? undefined : fromJson<Citation[]>(row.citations_json, []),
    createdAt: row.created_at,
  });
}

/** Rows a write changed, as D1 (and its stand-ins) report them. */
function changesOf(result: unknown): number {
  const meta = result && typeof result === "object" && "meta" in result ? (result as { meta?: { changes?: unknown } }).meta : undefined;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}
