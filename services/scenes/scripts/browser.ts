// Downloads the headless Chrome Remotion renders with, and on macOS keeps a copy in the cache folder (src/chrome.ts), which
// the service uses when OPENSOURCEBOOK_CHROME is not set (src/chrome.ts says why).
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import { CACHED_CHROME, findBinary } from "../src/chrome.ts";

// One plain line per 5%, which the launcher at the repo root (cli/chrome.ts) reads to show how far it is.
let shown = -1;
await ensureBrowser({
  onBrowserDownload: () => ({
    version: null,
    onProgress: ({ percent, alreadyAvailable }) => {
      const step = alreadyAvailable ? 100 : Math.floor(percent * 20) * 5;
      if (step > shown) console.log(`Downloading Chrome: ${(shown = step)}%`);
    },
  }),
});
const downloaded = join(import.meta.dirname, "..", "node_modules", ".remotion", "chrome-headless-shell");
if (!findBinary(downloaded)) throw new Error(`No Chrome under ${downloaded} after the download.`);
if (process.platform === "darwin") {
  rmSync(CACHED_CHROME, { recursive: true, force: true });
  cpSync(downloaded, CACHED_CHROME, { recursive: true, verbatimSymlinks: true });
  console.log(`Chrome: ${findBinary(CACHED_CHROME)} (a copy outside the repo, used unless OPENSOURCEBOOK_CHROME is set).`);
} else {
  console.log(`Chrome: ${findBinary(downloaded)}`);
}
