/**
 * Names from before the rename. A person's own settings (`.dev.vars`, a shell
 * profile), a deployed Worker's secrets and the bindings in `wrangler.toml`
 * (kept, since a deployer's own `wrangler.local.toml` repeats them) may still
 * say `RE_X`. This is read once where settings come in (the worker's handlers,
 * `scripts/dev.ts`): every `RE_X` that is set while `OPENSOURCEBOOK_X` is not
 * becomes `OPENSOURCEBOOK_X`. Everything after reads only the new names.
 */
const OLD = "RE_";
const NEW = "OPENSOURCEBOOK_";

/** Old names that do not map by their prefix alone. */
const SPECIAL: Record<string, string> = { RE_HOME: "OPENSOURCEBOOK_STATE" };

/** The new name of an old one; undefined for a name that is not an old one. */
export function newNameOf(name: string): string | undefined {
  if (!name.startsWith(OLD) || name.length === OLD.length) return undefined;
  return SPECIAL[name] ?? `${NEW}${name.slice(OLD.length)}`;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** The settings with every old name also under its new one. A new name that is set always wins; nothing is removed. */
export function withNewNames<T extends object>(settings: T): T {
  const given = settings as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    const renamed = newNameOf(name);
    if (renamed && isSet(value) && !isSet(given[renamed])) added[renamed] = value;
  }
  return Object.keys(added).length > 0 ? { ...settings, ...added } : settings;
}
