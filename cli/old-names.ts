/**
 * The names from before the product was renamed, in one place.
 *
 * Settings were called RE_SOMETHING and are now OPENSOURCEBOOK_SOMETHING. A person may still have the old names in
 * their shell, in `engine/.dev.vars` or in a `.env` file, so the launcher copies each old name to its new one once,
 * at its start, and reads only new names after that. What it writes for the other programs has only new names.
 */

/** The state folder's setting. Not OPENSOURCEBOOK_HOME: that one is the installer's own folder, a different thing. */
export const STATE_ENV = "OPENSOURCEBOOK_STATE";
export const OLD_STATE_ENV = "RE_HOME";

const OLD = "RE_";
const NEW = "OPENSOURCEBOOK_";

/** Names the installer owns (install/package/lib/paths.mjs). An old name is never carried onto one of them. */
const INSTALLER_NAMES = new Set(["OPENSOURCEBOOK_HOME", "OPENSOURCEBOOK_ARCHIVE"]);

/** The new name of an old setting, or undefined when `name` is not an old setting. */
export function newNameOf(name: string): string | undefined {
  if (name === OLD_STATE_ENV) return STATE_ENV;
  if (!name.startsWith(OLD) || name.length === OLD.length) return undefined;
  const renamed = `${NEW}${name.slice(OLD.length)}`;
  return INSTALLER_NAMES.has(renamed) ? undefined : renamed;
}

/** The old name of a new setting, or undefined when `name` is not one of ours. */
export function oldNameOf(name: string): string | undefined {
  if (name === STATE_ENV) return OLD_STATE_ENV;
  if (!name.startsWith(NEW) || name.length === NEW.length || INSTALLER_NAMES.has(name)) return undefined;
  return `${OLD}${name.slice(NEW.length)}`;
}

/**
 * The shim, for an environment: every old name that is set while its new name is not gives the new name its value.
 * Changes `env` itself and returns it. A new name that is already set always wins.
 */
export function carryOldNames<T extends Record<string, string | undefined>>(env: T): T {
  for (const [name, value] of Object.entries(env)) {
    const renamed = newNameOf(name);
    if (renamed && value !== undefined && value !== "" && (env[renamed] === undefined || env[renamed] === "")) (env as Record<string, string | undefined>)[renamed] = value;
  }
  return env;
}

/**
 * The same settings under new names only, for a file the launcher writes: an old name becomes its new one (unless the
 * new one is there too, which wins) and is left out.
 */
export function underNewNames(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) if (!newNameOf(name)) out[name] = value;
  for (const [name, value] of Object.entries(values)) {
    const renamed = newNameOf(name);
    if (renamed && out[renamed] === undefined) out[renamed] = value;
  }
  return out;
}

/** A setting's value by its new name, or by its old one when only that is set. */
export function settingOf(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  const old = oldNameOf(name);
  const before = old ? env[old] : undefined;
  return before !== undefined && before !== "" ? before : undefined;
}
