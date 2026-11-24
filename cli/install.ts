/**
 * Installs each program's packages when they are missing, or when its lockfile is not the one the installed packages
 * were made from (after a pull that brings new packages). One `npm ci` per folder; its output goes to a log, not the
 * screen.
 *
 * Whether a folder needs one is read from the lockfile's content, never its file time: a fresh checkout gives every
 * lockfile a new time though nothing changed. The hash of the lockfile each install was made from is kept in the
 * launcher's own `.opensourcebook/installs.json`; with no record (a checkout installed by hand, or by an older launcher) the
 * installed packages are compared with the lockfile, package by package. A `node_modules` that is a symbolic link is
 * never installed into, since `npm ci` would empty the folder it points at.
 */
import { stateFolder } from "./state.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { PROGRAMS } from "./programs.ts";
import { writePrivate } from "./secrets.ts";

const RECORD = "installs.json";

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The sha256 of a folder's lockfile, or undefined without one. */
export function lockHash(dir: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(join(dir, "package-lock.json"))).digest("hex");
  } catch {
    return undefined;
  }
}

const recorded = (home: string): Record<string, string> => readJson<Record<string, string>>(join(home, RECORD)) ?? {};

/** Notes in `.opensourcebook/installs.json` that the packages in this folder were installed from its lockfile as it is now. */
export function recordInstall(home: string, dir: string): void {
  const hash = lockHash(dir);
  if (!hash) return;
  const all = recorded(home);
  if (all[resolvePath(dir)] === hash) return;
  writePrivate(join(home, RECORD), `${JSON.stringify({ ...all, [resolvePath(dir)]: hash }, null, 2)}\n`);
}

/** Where a folder's `node_modules` points when it is a symbolic link, else undefined. */
export function linkedModules(dir: string): string | undefined {
  try {
    const modules = join(dir, "node_modules");
    return lstatSync(modules).isSymbolicLink() ? resolvePath(dir, readlinkSync(modules)) : undefined;
  } catch {
    return undefined;
  }
}

/** True when every package the lockfile needs is installed at the version it names, and nothing else is. */
export function installedMatchesLock(dir: string): boolean {
  type Packages = Record<string, { version?: string; optional?: boolean; devOptional?: boolean; peer?: boolean }>;
  const lock = readJson<{ packages?: Packages }>(join(dir, "package-lock.json"))?.packages;
  const installed = readJson<{ packages?: Packages }>(join(dir, "node_modules", ".package-lock.json"))?.packages;
  if (!lock || !installed) return false;
  for (const [path, entry] of Object.entries(installed)) if (lock[path]?.version !== entry.version) return false;
  // Optional packages for other systems are not installed here, so only the ones every install has are required.
  return Object.entries(lock).every(([path, entry]) => !path || installed[path] || entry.optional || entry.devOptional || entry.peer);
}

/** True when the packages in a folder answer: installed, and every package its package.json names is there. */
export function packagesAnswer(dir: string): boolean {
  if (!existsSync(join(dir, "node_modules", ".package-lock.json"))) return false;
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(dir, "package.json")) ?? {};
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).every((name) => existsSync(join(dir, "node_modules", name, "package.json")));
}

/**
 * True when the folder needs an install: no packages yet, or packages made from another lockfile. A folder whose
 * `node_modules` is a link never does (`linkedPackages` says what to do about it). An install that matches its
 * lockfile but has no record yet is recorded, so the next start reads only the hash.
 */
export function needsInstall(dir: string, home: string): boolean {
  if (!existsSync(join(dir, "package.json"))) return false;
  if (linkedModules(dir)) return false;
  if (!existsSync(join(dir, "node_modules", ".package-lock.json"))) return true;
  const hash = lockHash(dir);
  if (!hash) return false;
  if (recorded(home)[resolvePath(dir)] === hash) return false;
  if (!installedMatchesLock(dir)) return true;
  try {
    recordInstall(home, dir);
  } catch {
    // A record that cannot be written only means the packages are compared again next time.
  }
  return false;
}

/** The program folders (from the repo root) that need an install. */
export function missingPackages(root: string, home = stateFolder(root)): string[] {
  return PROGRAMS.map((p) => p.dir).filter((dir) => needsInstall(join(root, dir), home));
}

/** A program folder whose `node_modules` is a symbolic link: where it points, and whether the packages there answer. */
export interface Linked {
  dir: string;
  target: string;
  answers: boolean;
}

export function linkedPackages(root: string): Linked[] {
  return PROGRAMS.flatMap((p) => {
    const dir = join(root, p.dir);
    const target = existsSync(join(dir, "package.json")) ? linkedModules(dir) : undefined;
    return target ? [{ dir: p.dir, target, answers: packagesAnswer(dir) }] : [];
  });
}

/** What the launcher says about a linked `node_modules`, in a person's words. */
export function linkedLine(name: string, linked: Linked): string {
  const where = `${linked.dir}/node_modules`;
  const why = `${where} is a symbolic link to ${linked.target}, and Open Sourcebook does not install into a link (it would empty the folder the link points at)`;
  return linked.answers
    ? `  ${name}: ${why}. The packages there answer, so Open Sourcebook goes on with them; if they are out of date, install them in the folder the link points at.`
    : `  ${name}: ${why}. The packages there do not answer. Delete the link itself (not the folder it points at) and start again so Open Sourcebook installs its own, or install the packages in the folder the link points at.`;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs `npm ci` (or `npm install` without a lockfile) in a folder and, when it worked, records which lockfile it was
 * made from in `home`. Resolves with whether it worked. A `node_modules` that is a symbolic link is refused, with the
 * reason in the log.
 */
export function install(dir: string, log: string, home?: string): Promise<boolean> {
  const out = createWriteStream(log, { flags: "w" });
  const link = linkedModules(dir);
  if (link) {
    return new Promise((resolve) => out.end(`${join(dir, "node_modules")} is a symbolic link to ${link}. Open Sourcebook does not install into a link, since npm would empty the folder it points at. Delete the link itself, or install in the folder it points at.\n`, () => resolve(false)));
  }
  const args = existsSync(join(dir, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", (error) => {
      out.end(`\n${error.message}\n`);
      resolve(false);
    });
    child.once("exit", (code) => {
      out.end();
      if (code === 0 && home) {
        try {
          recordInstall(home, dir);
        } catch {
          // Without the record the next start compares the packages with the lockfile instead.
        }
      }
      resolve(code === 0);
    });
  });
}

/** One part to install, in the words a person knows it by. */
export interface Part {
  dir: string;
  /** What the person calls it ("Engine", "Web app"). */
  name: string;
  /** What it is for, in a few words. */
  about: string;
}

export interface InstallOutcome {
  part: Part;
  ok: boolean;
  seconds: number;
}

/** "45s" under a minute, "2m 5s" after. */
export function took(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Installs every part at once and tells the person as each one finishes ("Engine: ready, 38s") and, while some are
 * still going, which ones, so a long install is never silent. `heartbeatMs` repeats the "still installing" line for
 * a screen that cannot redraw in place. npm's own output stays in its log (`run` writes it).
 */
export async function installParts(
  parts: Part[],
  run: (part: Part) => Promise<boolean>,
  ui: { line(text: string): void; waiting(text: string): void },
  options: { now?: () => number; heartbeatMs?: number } = {},
): Promise<InstallOutcome[]> {
  const now = options.now ?? Date.now;
  const began = now();
  const left = new Set(parts.map((p) => p.name));
  const waiting = () => `still installing: ${[...left].join(", ")}`;
  ui.waiting(waiting());
  const beat = options.heartbeatMs ? setInterval(() => left.size && ui.line(`  ${waiting()} (${took(Math.round((now() - began) / 1000))} so far)`), options.heartbeatMs) : undefined;
  beat?.unref();
  try {
    return await Promise.all(
      parts.map(async (part) => {
        const ok = await run(part);
        const seconds = Math.round((now() - began) / 1000);
        left.delete(part.name);
        ui.line(`  ${part.name} (${part.about}): ${ok ? "ready" : "did not finish"}, ${took(seconds)}`);
        if (left.size) ui.waiting(waiting());
        return { part, ok, seconds };
      }),
    );
  } finally {
    if (beat) clearInterval(beat);
  }
}
