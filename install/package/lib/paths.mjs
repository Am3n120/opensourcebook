/** Where everything lives: the one folder on the person's computer, and the one setting for the download. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's own folder (the one holding package.json and source.json). */
export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Open Sourcebook folder: OPENSOURCEBOOK_HOME when set, else `.opensourcebook` in the person's home folder. */
export function homeOf(env = process.env, userHome = homedir()) {
  const set = (env.OPENSOURCEBOOK_HOME ?? "").trim();
  return set ? resolve(set) : join(userHome, ".opensourcebook");
}

/** Every path inside the Open Sourcebook folder, by name. */
export function layout(home) {
  return {
    home,
    app: join(home, "app"),
    manifest: join(home, "app.manifest"),
    launcher: join(home, "launcher"),
    bin: join(home, "bin"),
    node: join(home, "node"),
    tools: join(home, "tools"),
    tmp: join(home, "tmp"),
    settings: join(home, "settings.json"),
  };
}

/** Where the app is downloaded from: OPENSOURCEBOOK_ARCHIVE when set, else the address in source.json. */
export function archiveOf(env = process.env, packageDir = PACKAGE_DIR) {
  const set = (env.OPENSOURCEBOOK_ARCHIVE ?? "").trim();
  if (set) return set;
  return JSON.parse(readFileSync(join(packageDir, "source.json"), "utf8")).archive;
}
