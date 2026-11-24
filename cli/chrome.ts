/**
 * The headless Chrome videos are measured, built and rendered with. Where the scenes service looks for it is its own
 * code (services/scenes/src/chrome.ts); this asks the same places, and downloads it with the scenes service's own
 * script (`npm run browser` there) when none is found.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The cache folder's name, and its name before the rename. */
const CACHE_NAME = "opensourcebook-scenes";
const OLD_CACHE_NAME = "re-scenes";

/**
 * The same copy outside the repo that the scenes service uses on macOS (services/scenes/src/chrome.ts says why, and
 * must name the same folders). A copy downloaded before the rename is used where it is and never moved or downloaded
 * again: the new folder when it is there, else the old one when that is there, else the new one.
 */
export function cachedChrome(home = homedir()): string {
  const caches = join(home, "Library", "Caches");
  const now = join(caches, CACHE_NAME, "chrome-headless-shell");
  const old = join(caches, OLD_CACHE_NAME, "chrome-headless-shell");
  return existsSync(now) || !existsSync(old) ? now : old;
}

function findBinary(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if ((e.name === "chrome-headless-shell" || e.name === "chrome-headless-shell.exe") && e.isFile()) return path;
    if (e.isDirectory()) {
      const hit = findBinary(path);
      if (hit) return hit;
    }
  }
  return null;
}

/** The Chrome the scenes service will use, or null when there is none yet. */
export function findChrome(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | null {
  const set = env.OPENSOURCEBOOK_CHROME?.trim();
  if (set) return existsSync(set) && statSync(set).isFile() ? set : null;
  if (platform === "darwin") {
    const cached = findBinary(cachedChrome(home));
    if (cached) return cached;
  }
  return findBinary(join(root, "services", "scenes", "node_modules", ".remotion", "chrome-headless-shell"));
}

/** What the first start says about the browser videos are drawn with: how much it downloads, and how much room it takes. */
export const CHROME_SIZE = "about 180 MB to download, about half a gigabyte once unpacked";

/** Where the download leaves its own copy, inside the scenes service's folder. */
const downloadedCopy = (root: string) => join(root, "services", "scenes", "node_modules", ".remotion", "chrome-headless-shell");

/**
 * The download script keeps a copy outside the repo on macOS (the one in use, see cachedChrome) next to the copy the
 * download itself leaves in node_modules: the same half gigabyte twice. Once the outside copy is there the other is
 * never read (every program that draws videos is pointed at the outside one), so it is removed. Returns whether it was.
 */
export function dropSecondCopy(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): boolean {
  if (platform !== "darwin" || env.OPENSOURCEBOOK_CHROME?.trim()) return false;
  const second = downloadedCopy(root);
  if (!existsSync(second) || !findBinary(cachedChrome(home))) return false;
  rmSync(second, { recursive: true, force: true });
  return true;
}

/** A "Downloading Chrome: 40%" line from the scenes service's browser script, as a number. */
export function percentIn(line: string): number | undefined {
  const match = /Downloading Chrome: (\d+)%/.exec(line);
  return match ? Number(match[1]) : undefined;
}

/** Downloads Chrome with the scenes service's script, telling `onPercent` how far it is. Resolves with whether it worked. */
export function downloadChrome(root: string, log: string, onPercent: (percent: number) => void): Promise<boolean> {
  const out = createWriteStream(log, { flags: "w" });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/browser.ts"], {
      cwd: join(root, "services", "scenes"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out.write(chunk);
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const percent = percentIn(line);
        if (percent !== undefined) onPercent(percent);
      }
    });
    child.stderr.pipe(out, { end: false });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => {
      out.end();
      resolve(code === 0);
    });
  });
}
