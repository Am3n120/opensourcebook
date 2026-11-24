/**
 * Which headless Chrome measures, compiles and renders. The engine reads `OPENSOURCEBOOK_CHROME` and falls back to the
 * one Remotion downloads into node_modules. On macOS a Chrome kept inside Desktop, Documents or Downloads cannot load
 * its own page (those folders are guarded per app), so `npm run browser` also keeps a copy in the person's cache
 * folder, and this picks it up when nothing else is set.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where that copy is kept: ~/Library/Caches/opensourcebook-scenes. A copy made before the product was renamed is in
 * ~/Library/Caches/re-scenes, and it is used where it is, never moved: the new folder when it is there, else the old
 * one when it is there, else the new one. The launcher asks the same way (cli/chrome.ts).
 */
export function cachedChrome(home: string = homedir()): string {
  const at = (name: string) => join(home, "Library", "Caches", name, "chrome-headless-shell");
  const [now, old] = [at("opensourcebook-scenes"), at("re-scenes")];
  return existsSync(now) || !existsSync(old) ? now : old;
}

export const CACHED_CHROME = cachedChrome();

export function findBinary(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if ((e.name === "chrome-headless-shell" || e.name === "chrome-headless-shell.exe") && e.isFile()) return path;
    if (e.isDirectory()) {
      const hit = findBinary(path);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Sets OPENSOURCEBOOK_CHROME to the cached copy when it is not set and the copy is there. Returns the Chrome in use, if known. */
export function useChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | undefined {
  if (env.OPENSOURCEBOOK_CHROME) return env.OPENSOURCEBOOK_CHROME;
  const cached = platform === "darwin" ? findBinary(cachedChrome(home)) : undefined;
  if (cached) env.OPENSOURCEBOOK_CHROME = cached;
  return cached;
}
