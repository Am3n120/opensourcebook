/**
 * Settings from before the product was renamed. A person's shell or `.env` may still say `RE_SOMETHING`; each such
 * name that is set, while its new name `OPENSOURCEBOOK_SOMETHING` is not, is copied to the new name, and the code reads
 * only new names. `RE_HOME` becomes `OPENSOURCEBOOK_STATE`, since `OPENSOURCEBOOK_HOME` is the installer's own folder.
 * Run once where a program starts, after its `.env` is loaded.
 */
export function carryOldNames(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("RE_") || value === undefined) continue;
    const now = name === "RE_HOME" ? "OPENSOURCEBOOK_STATE" : `OPENSOURCEBOOK_${name.slice(3)}`;
    if (env[now] === undefined) env[now] = value;
  }
}
