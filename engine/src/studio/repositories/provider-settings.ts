/** `provider_settings` & `agent_picks` (migrations/0013, 0014, 0018, 0019): provider settings and remembered agent picks per owner. */
import { all, first, fromJson, run, toJson, type RepositoryContext } from "./shared";

const PICK_SCOPE = /^[a-z0-9._-]{1,64}$/i;

export interface AgentPick {
  scope: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** A reviewer turned off (review scopes only). */
  off?: boolean;
  updatedAt: string;
}

export interface AgentPickPatch {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  /** Review scopes only ("<format>.review"); null clears. */
  off?: boolean | null;
}

interface AgentPickRow {
  scope: string;
  agent: string | null;
  model: string | null;
  effort: string | null;
  off?: number | null;
  updated_at: string;
}

function pickFromRow(row: AgentPickRow): AgentPick {
  return {
    scope: row.scope,
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.off ? { off: true } : {}),
    updatedAt: row.updated_at,
  };
}

function cleanPickValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

export interface ProviderSetting {
  providerId: string;
  /** Added to the list (true), removed from it (false), or never chosen (undefined: in the list when installed). */
  added?: boolean;
  enabled: boolean;
  /** Models left out of the chat's picker; every other model shows. */
  hiddenModels: string[];
  /** Models starred in the picker, in the order they were starred. */
  favoriteModels: string[];
  updatedAt: string;
}

export interface ProviderSettingPatch {
  added?: boolean;
  enabled?: boolean;
  hiddenModels?: string[];
  favoriteModels?: string[];
}

interface ProviderSettingRow {
  provider_id: string;
  added: number | null;
  enabled: number;
  hidden_models_json: string;
  favorite_models_json: string;
  updated_at: string;
}

function fromRow(row: ProviderSettingRow): ProviderSetting {
  return {
    providerId: row.provider_id,
    ...(row.added === null ? {} : { added: row.added === 1 }),
    enabled: row.enabled === 1,
    hiddenModels: fromJson<string[]>(row.hidden_models_json, []),
    favoriteModels: fromJson<string[]>(row.favorite_models_json, []),
    updatedAt: row.updated_at,
  };
}

export class ProviderSettingsRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /** What the person changed, by provider; a provider with no row is on, never chosen, with every model shown and none starred. */
  async list(ownerId: string): Promise<ProviderSetting[]> {
    const rows = await all<ProviderSettingRow>(this.ctx.db, "SELECT * FROM provider_settings WHERE owner_id = ? ORDER BY provider_id", ownerId);
    return rows.map(fromRow);
  }

  async get(ownerId: string, providerId: string): Promise<ProviderSetting | undefined> {
    const row = await first<ProviderSettingRow>(this.ctx.db, "SELECT * FROM provider_settings WHERE owner_id = ? AND provider_id = ?", ownerId, providerId);
    return row ? fromRow(row) : undefined;
  }

  /** Changes what is sent and keeps the rest. */
  async update(ownerId: string, providerId: string, patch: ProviderSettingPatch): Promise<ProviderSetting> {
    const was = await this.get(ownerId, providerId);
    const added = patch.added ?? was?.added;
    const next = {
      enabled: patch.enabled ?? was?.enabled ?? true,
      hiddenModels: [...new Set(patch.hiddenModels ?? was?.hiddenModels ?? [])],
      favoriteModels: [...new Set(patch.favoriteModels ?? was?.favoriteModels ?? [])],
    };
    const at = this.ctx.now();
    await run(
      this.ctx.db,
      `INSERT INTO provider_settings (owner_id, provider_id, added, enabled, hidden_models_json, favorite_models_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, provider_id) DO UPDATE SET added = excluded.added, enabled = excluded.enabled, hidden_models_json = excluded.hidden_models_json,
         favorite_models_json = excluded.favorite_models_json, updated_at = excluded.updated_at`,
      ownerId,
      providerId,
      added === undefined ? null : added ? 1 : 0,
      next.enabled ? 1 : 0,
      toJson(next.hiddenModels),
      toJson(next.favoriteModels),
      at,
    );
    return { providerId, ...(added === undefined ? {} : { added }), ...next, updatedAt: at };
  }

  async listPicks(ownerId: string): Promise<AgentPick[]> {
    const rows = await all<AgentPickRow>(this.ctx.db, "SELECT * FROM agent_picks WHERE owner_id = ? ORDER BY scope", ownerId);
    return rows.map(pickFromRow);
  }

  async getPick(ownerId: string, scope: string): Promise<AgentPick | undefined> {
    if (!PICK_SCOPE.test(scope)) return undefined;
    const row = await first<AgentPickRow>(this.ctx.db, "SELECT * FROM agent_picks WHERE owner_id = ? AND scope = ?", ownerId, scope);
    return row ? pickFromRow(row) : undefined;
  }

  /**
   * Saves or updates a remembered pick for `scope`; deletes the row when
   * every field is cleared. `off` (a reviewer turned off) is kept only for a
   * review scope ("<format>.review"); elsewhere it is refused.
   */
  async setPick(ownerId: string, scope: string, patch: AgentPickPatch): Promise<AgentPick | undefined> {
    if (!PICK_SCOPE.test(scope)) throw new Error(`Invalid agent pick scope: ${scope}`);
    if (patch.off === true && !scope.endsWith(".review")) throw new PickOffRefused(scope);
    const was = await this.getPick(ownerId, scope);
    const agent = patch.agent === undefined ? was?.agent : cleanPickValue(patch.agent);
    const model = patch.model === undefined ? was?.model : cleanPickValue(patch.model);
    const effort = patch.effort === undefined ? was?.effort : cleanPickValue(patch.effort);
    const off = patch.off === undefined ? was?.off === true : patch.off === true;
    if (!agent && !model && !effort && !off) {
      await run(this.ctx.db, "DELETE FROM agent_picks WHERE owner_id = ? AND scope = ?", ownerId, scope);
      return undefined;
    }
    const at = this.ctx.now();
    await run(
      this.ctx.db,
      `INSERT INTO agent_picks (owner_id, scope, agent, model, effort, off, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, scope) DO UPDATE SET agent = excluded.agent, model = excluded.model, effort = excluded.effort, off = excluded.off, updated_at = excluded.updated_at`,
      ownerId,
      scope,
      agent ?? null,
      model ?? null,
      effort ?? null,
      off ? 1 : 0,
      at,
    );
    return {
      scope,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(off ? { off: true } : {}),
      updatedAt: at,
    };
  }
}

/** `off` sent for a scope that is not a reviewer's. */
export class PickOffRefused extends Error {
  constructor(readonly scope: string) {
    super(`Only a reviewer can be off; ${scope} is not a review scope`);
  }
}
