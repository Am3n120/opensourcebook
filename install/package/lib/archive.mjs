/**
 * Getting the app's files: download the archive, unpack it beside the app, and only then change `app/`. The list of
 * files the last archive put there (`app.manifest`) is what makes an update safe: a file is removed only when that
 * list names it and the new archive no longer has it, so a person's projects and settings are never touched.
 */
import { chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { layout } from "./paths.mjs";
import { Problem } from "./problem.mjs";

const AGAIN = "Check the internet connection and run the same command again.";

export const isWebAddress = (location) => /^https?:\/\//i.test(location);

/** The archive as a file on this computer: downloaded to `dest` from a web address, or the local file itself. */
export async function fetchArchive(location, dest, fetchImpl = fetch) {
  if (!isWebAddress(location)) {
    const file = /^file:/i.test(location) ? fileURLToPath(location) : location;
    if (!existsSync(file)) throw new Problem(`There is no file at ${file}.`, "Check the address in OPENSOURCEBOOK_ARCHIVE and run the same command again.");
    return file;
  }
  let answer;
  try {
    answer = await fetchImpl(location, { redirect: "follow" });
  } catch (error) {
    throw new Problem(`Open Sourcebook could not be downloaded from ${location}.`, AGAIN, error);
  }
  if (!answer.ok || !answer.body) throw new Problem(`Open Sourcebook could not be downloaded from ${location} (the answer was ${answer.status}).`, "Wait a minute and run the same command again.");
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(answer.body), createWriteStream(dest));
  } catch (error) {
    throw new Problem("The download stopped before it was finished.", AGAIN, error);
  }
  return dest;
}

/** The system's own tar: on Windows the one that ships with it, whatever else is on the PATH. */
export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "tar";
  const own = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
  return existsSync(own) ? own : "tar";
}

/** Unpacks the archive's one top folder into `staging`. */
export async function unpack(file, staging, run, tar = tarCommand()) {
  mkdirSync(staging, { recursive: true });
  const result = await run(tar, ["-xzf", file, "-C", staging, "--strip-components=1"], { capture: true });
  if (result.code !== 0) throw new Problem("The downloaded file could not be unpacked.", "Run the same command again to download it afresh.", new Error(result.stderr));
}

/** Every file (and link) under a folder, as sorted paths with forward slashes. */
export function listFiles(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else found.push(rel);
    }
  };
  walk(root, "");
  return found.sort();
}

/** A manifest line is used only when it names a place inside the app folder. */
export const insideApp = (rel) => rel !== "" && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) && !rel.includes("\\") && !rel.split("/").some((part) => part === ".." || part === "." || part === "");

export function readManifest(file) {
  try {
    return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(insideApp);
  } catch {
    return [];
  }
}

const writeManifest = (file, paths) => writeFileSync(file, `${[...new Set(paths)].sort().join("\n")}\n`);

const kindOf = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Makes `app/` hold the files in `staging`: removes what the old manifest named and the new archive dropped (and
 * folders left empty by that), copies every new file over, and writes the new manifest. Nothing else in `app/` is
 * read, moved or removed.
 */
export function applyFiles(staging, appDir, manifestFile) {
  const fresh = listFiles(staging);
  const old = readManifest(manifestFile);
  const keep = new Set(fresh);
  const dropped = old.filter((rel) => !keep.has(rel));
  mkdirSync(appDir, { recursive: true });
  // Both lists are remembered until the copy is done, so a copy that is cut short is still cleaned up by the next one.
  writeManifest(manifestFile, [...old, ...fresh]);

  for (const rel of dropped) {
    const path = join(appDir, rel);
    const kind = kindOf(path);
    if (!kind || kind.isDirectory()) continue;
    unlinkSync(path);
    for (let dir = dirname(path); dir.length > appDir.length && dir.startsWith(appDir); dir = dirname(dir)) {
      try {
        rmdirSync(dir);
      } catch {
        break; // Not empty: something of the person's, or of the app's, is still in it.
      }
    }
  }

  for (const rel of fresh) {
    const from = join(staging, rel);
    const to = join(appDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    const source = lstatSync(from);
    const there = kindOf(to);
    if (there?.isSymbolicLink() || (there && source.isSymbolicLink())) unlinkSync(to);
    if (source.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else {
      copyFileSync(from, to);
      chmodSync(to, source.mode & 0o777);
    }
  }
  writeManifest(manifestFile, fresh);
  return { files: fresh.length, removed: dropped.length };
}

/**
 * Download, unpack, check, and only then change `app/`. `beforeChange` runs once the new files are known to be good
 * and before the first one is copied (the place to stop a running copy). A failure before that leaves the app, and
 * whether it is running, exactly as it was.
 */
export async function updateApp({ home, archive, run, fetchImpl, say = () => {}, beforeChange = async () => {}, tar }) {
  const at = layout(home);
  const work = join(at.tmp, `update-${process.pid}`);
  const staging = join(work, "files");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    say(isWebAddress(archive) ? "Downloading Open Sourcebook." : "Reading the Open Sourcebook archive on this computer.");
    const file = await fetchArchive(archive, join(work, "app.tar.gz"), fetchImpl);
    say("Unpacking it.");
    await unpack(file, staging, run, tar);
    if (!existsSync(join(staging, "package.json"))) throw new Problem("The downloaded file does not hold Open Sourcebook.", "Check the address it was downloaded from and run the same command again.");
    await beforeChange();
    say("Putting the files in place.");
    try {
      return applyFiles(staging, at.app, at.manifest);
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(`A file could not be written in ${at.app}.`, "Close anything that has that folder open and run the same command again.", error);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    try {
      rmdirSync(at.tmp);
    } catch {
      // Something else is using it.
    }
  }
}
