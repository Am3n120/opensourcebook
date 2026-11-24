/**
 * The product's names in one place, and what keeps a copy from before the rename working: under its earlier name
 * its settings began with `RE_`, its state folder was `.re` and its file in the home folder was in
 * `~/.re-agent-connector`. Old settings are read under their new names; old folders are read where they are and
 * never moved from here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The name of the MCP server every agent is given for a turn; an agent's own names for the tools start with it. */
export const MCP_SERVER = "opensourcebook";
/** The product's name as a person reads it. */
export const PRODUCT = "Open Sourcebook";

/** What every setting of the product's begins with, and what it began with before the rename. */
export const ENV_PREFIX = "OPENSOURCEBOOK_";
export const OLD_ENV_PREFIX = "RE_";
/** Old names whose new name is not the same word after the prefix. */
const RENAMED: Record<string, string> = { RE_HOME: "OPENSOURCEBOOK_STATE" };

/**
 * Gives every old setting (`RE_X`) its new name (`OPENSOURCEBOOK_X`) when the new one is not set, so a person's own
 * `.env` from before the rename keeps working. Run once at the entry, after the env file is loaded; after it, code
 * reads only the new names.
 */
export function carryOldSettings(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(OLD_ENV_PREFIX)) continue;
    const now = RENAMED[key] ?? ENV_PREFIX + key.slice(OLD_ENV_PREFIX.length);
    if (env[now] === undefined) env[now] = value;
  }
  return env;
}

/** Whether a variable is one of the product's own settings, under either name: an agent is never given these. */
export const isOwnSetting = (key: string): boolean => key.startsWith(ENV_PREFIX) || key.startsWith(OLD_ENV_PREFIX);

/** The new place if it is there, else the old place if it is there, else the new place. Nothing is moved. */
export function inPlace(now: string, old: string, exists: (path: string) => boolean = existsSync): string {
  return exists(now) || !exists(old) ? now : old;
}

/**
 * The usage log when the launcher did not hand its path over (`OPENSOURCEBOOK_USAGE_LOG`), as when the connector is
 * started by hand: in the state folder the person named, else in this copy's own, under its old name if only that
 * one is there.
 */
export function defaultUsageLog(root: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  const state = env.OPENSOURCEBOOK_STATE?.trim() || inPlace(join(root, ".opensourcebook"), join(root, ".re"), exists);
  return join(state, "logs", "usage.jsonl");
}

/** The connector's own folder in the person's home folder, read where it already is. */
export function connectorHome(home: string, exists: (path: string) => boolean = existsSync): string {
  return inPlace(join(home, ".opensourcebook-agent-connector"), join(home, ".re-agent-connector"), exists);
}
