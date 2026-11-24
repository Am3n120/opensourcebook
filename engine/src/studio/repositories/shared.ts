/** Helpers every Studio repository shares: clock, ids, JSON columns, enum checks. */
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../types/bindings";
import type { JsonValue } from "../types";

export interface RepositoryOptions {
  now?: () => string;
  newId?: () => string;
}

export interface RepositoryContext {
  db: D1DatabaseLike;
  now: () => string;
  newId: () => string;
}

export function repositoryContext(db: D1DatabaseLike, options: RepositoryOptions = {}): RepositoryContext {
  return {
    db,
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? (() => crypto.randomUUID()),
  };
}

/** Reads go to the primary when the binding supports it, so a write is visible at once. */
export function reader(db: D1DatabaseLike): D1DatabaseLike {
  return typeof db.withConstraint === "function" ? db.withConstraint("primary") : db;
}

export async function first<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]): Promise<T | undefined> {
  return (await reader(db).prepare(sql).bind(...values).first<T>()) ?? undefined;
}

export async function all<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]): Promise<T[]> {
  return (await reader(db).prepare(sql).bind(...values).all<T>()).results;
}

export async function run(db: D1DatabaseLike, sql: string, ...values: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...values).run();
}

/** Runs statements as one transaction when the binding can (D1 `batch`), else one by one. */
export async function runAll(db: D1DatabaseLike, statements: D1PreparedStatementLike[]): Promise<void> {
  if (statements.length === 0) return;
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T extends JsonValue | object>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  return JSON.parse(json) as T;
}

/** `undefined` for SQL NULL, so optional fields stay absent instead of null. */
export function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/** Drops undefined fields, so a row's NULL columns are absent keys on the record. */
export function compact<T extends object>(record: T): T {
  for (const key of Object.keys(record) as (keyof T)[]) if (record[key] === undefined) delete record[key];
  return record;
}

/** A NULL-able bind value from an optional field. */
export function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function bool(value: number): boolean {
  return value === 1;
}

export class InvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecordError";
  }
}

/** Value sets that grow are checked in code, not CHECK constraints (migrations/0003). */
export function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidRecordError(`${field} must be one of ${allowed.join(", ")}; got "${value}".`);
  }
  return value as T;
}

/**
 * Builds `SET a = ?, b = ?` from a patch, mapping field names to columns and
 * encoding values. Undefined fields are skipped; `null` clears a column.
 */
export function assignments<P extends object>(
  patch: P,
  columns: { [K in keyof P]-?: [column: string, encode?: (value: Exclude<P[K], undefined>) => unknown] },
): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(patch) as (keyof P)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    const [column, encode] = columns[key];
    sql.push(`${column} = ?`);
    values.push(value === null ? null : encode ? encode(value as Exclude<P[typeof key], undefined>) : value);
  }
  return { sql, values };
}

/**
 * Keyset paging: rows after a `[sortValue, id]` key, `limit` at a time. A
 * page asks for one row more than it returns to know whether another follows.
 */
export interface PageQuery {
  limit: number;
  after?: PageKey;
}

export type PageKey = [sortValue: string, id: string];

export interface Page<T> {
  rows: T[];
  next?: PageKey;
}

/** `AND (sort, id) after key` for an ORDER BY `sort dir, id dir`. */
export function afterKey(sortColumn: string, idColumn: string, direction: "ASC" | "DESC", after?: PageKey): { sql: string; values: unknown[] } {
  if (!after) return { sql: "", values: [] };
  const op = direction === "ASC" ? ">" : "<";
  return { sql: ` AND (${sortColumn} ${op} ? OR (${sortColumn} = ? AND ${idColumn} ${op} ?))`, values: [after[0], after[0], after[1]] };
}

/** Cuts the extra row and names the key of the last row kept. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => PageKey): Page<T> {
  if (rows.length <= limit) return { rows };
  const kept = rows.slice(0, limit);
  return { rows: kept, next: keyOf(kept[kept.length - 1]) };
}
