/**
 * The state folder: where the launcher keeps what is this person's and not git's (the secrets, the paired devices,
 * the chosen voice, the builds, a log per program). It is `.opensourcebook/` at the repo root.
 *
 * This is the one place that says where it is. Everything else calls `stateFolder` or is handed the path.
 *
 * A copy made before the product was renamed keeps the same things in `.re/`. Nothing in it is lost: a start moves
 * that folder to the new name in one step, and every other command reads it where it is.
 */
import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { OLD_STATE_ENV, STATE_ENV } from "./old-names.ts";

export const STATE_DIR = ".opensourcebook";
/** The folder's name before the rename. */
export const OLD_STATE_DIR = ".re";

export interface StateOptions {
  /**
   * Only the launcher's start sets this: an old folder is moved to the new name and the folder is made when there is
   * none. Without it nothing on disk is touched, so a status, a check or a test never moves a running copy's folder.
   */
  settle?: boolean;
  /** One line for the log when something worth knowing happened (the move, or why it could not be done). */
  say?: (line: string) => void;
  /** For tests: the calls that change the disk. */
  rename?: (from: string, to: string) => void;
  link?: (target: string, path: string) => void;
}

/**
 * Where the state folder is, in this order: the folder named in OPENSOURCEBOOK_STATE; the one in the old RE_HOME;
 * `.opensourcebook` when it is there; `.re` when only that is there (moved to `.opensourcebook` on a start, read in
 * place otherwise); else `.opensourcebook`.
 */
export function stateFolder(root: string, env: NodeJS.ProcessEnv = process.env, options: StateOptions = {}): string {
  const say = options.say ?? (() => {});
  const named = env[STATE_ENV]?.trim() || env[OLD_STATE_ENV]?.trim();
  if (named) {
    if (options.settle) mkdirSync(named, { recursive: true, mode: 0o700 });
    return named;
  }
  const now = join(root, STATE_DIR);
  const old = join(root, OLD_STATE_DIR);
  if (existsSync(now)) return now;
  if (existsSync(old)) {
    if (!options.settle) return old;
    try {
      // One step: the folder is whole under the old name or whole under the new one, never half of each.
      (options.rename ?? renameSync)(old, now);
    } catch (error) {
      say(`  Your settings stay in ${OLD_STATE_DIR}/ for now: that folder could not be given its new name, ${STATE_DIR}/ (${reason(error)}). Everything in it is used where it is.`);
      return old;
    }
    try {
      // A launcher from before the rename looks for the old name; the link lets it find the same folder.
      (options.link ?? ((target, path) => symlinkSync(target, path, "dir")))(STATE_DIR, old);
    } catch {
      // No link (Windows without the right to make one): the new launcher needs none.
    }
    say(`  Your settings moved from ${OLD_STATE_DIR}/ to ${STATE_DIR}/, with everything in them as it was.`);
    return now;
  }
  if (options.settle) mkdirSync(now, { recursive: true, mode: 0o700 });
  return now;
}

const reason = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : String(error));
