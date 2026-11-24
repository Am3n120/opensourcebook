/** `owner_settings` (migrations/0021): small settings kept per owner, one JSON value per key. */
import type { JsonValue } from "../types";
import { all, first, run, toJson, type RepositoryContext } from "./shared";

const KEY = /^[a-z][a-z0-9._-]{0,63}$/;

interface OwnerSettingRow {
  key: string;
  value_json: string;
  updated_at: string;
}

export class OwnerSettingsRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /** The value kept under `key`, or undefined when none is. */
  async get(ownerId: string, key: string): Promise<JsonValue | undefined> {
    if (!KEY.test(key)) return undefined;
    const row = await first<OwnerSettingRow>(this.ctx.db, "SELECT key, value_json, updated_at FROM owner_settings WHERE owner_id = ? AND key = ?", ownerId, key);
    return row ? parse(row.value_json) : undefined;
  }

  /** Every value kept for the owner, by key. */
  async list(ownerId: string): Promise<Record<string, JsonValue>> {
    const rows = await all<OwnerSettingRow>(this.ctx.db, "SELECT key, value_json, updated_at FROM owner_settings WHERE owner_id = ? ORDER BY key", ownerId);
    const values: Record<string, JsonValue> = {};
    for (const row of rows) {
      const value = parse(row.value_json);
      if (value !== undefined) values[row.key] = value;
    }
    return values;
  }

  /** Keeps `value` under `key`; `null` removes it. */
  async set(ownerId: string, key: string, value: JsonValue): Promise<void> {
    if (!KEY.test(key)) throw new Error(`Invalid owner setting key: ${key}`);
    if (value === null) {
      await run(this.ctx.db, "DELETE FROM owner_settings WHERE owner_id = ? AND key = ?", ownerId, key);
      return;
    }
    await run(
      this.ctx.db,
      `INSERT INTO owner_settings (owner_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ownerId,
      key,
      toJson(value),
      this.ctx.now(),
    );
  }
}

/** A kept value, or undefined when it can't be read. */
function parse(json: string): JsonValue | undefined {
  try {
    return JSON.parse(json) as JsonValue;
  } catch {
    return undefined;
  }
}
