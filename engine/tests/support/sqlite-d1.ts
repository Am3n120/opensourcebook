/**
 * A D1 binding backed by a real SQLite database (node:sqlite) with the
 * engine's actual migration files applied in order. Repository and store
 * tests run their real SQL against it, foreign keys on as in D1.
 */
/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../src/types";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

export interface SqliteD1 extends D1DatabaseLike {
  /** Every statement prepared, in order; for tests that assert on SQL. */
  readonly statements: string[];
  raw: DatabaseSync;
}

export function createSqliteD1(options: { upTo?: string } = {}): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationFiles()) {
    if (options.upTo && name > options.upTo) break;
    raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  const statements: string[] = [];

  const prepare = (query: string): D1PreparedStatementLike => {
    statements.push(query);
    let params: SQLInputValue[] = [];
    const statement: D1PreparedStatementLike = {
      bind(...values: unknown[]) {
        params = values.map(toSqlValue);
        return statement;
      },
      async first<T>(column?: string): Promise<T | null> {
        const row = raw.prepare(query).get(...params) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : { ...row }) as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const rows = raw.prepare(query).all(...params) as Record<string, unknown>[];
        return { results: rows.map((row) => ({ ...row }) as T) };
      },
      async run() {
        const result = raw.prepare(query).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  };

  const db: SqliteD1 = {
    statements,
    raw,
    prepare,
    withConstraint: () => db,
    async batch(prepared: D1PreparedStatementLike[]) {
      // D1 runs a batch as one transaction.
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const statement of prepared) results.push(await statement.all());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as SqliteD1;
  return db;
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined) throw new Error("D1 rejects undefined bind values; pass null.");
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}
