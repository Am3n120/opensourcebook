/**
 * The toolbox: what the agent can reach beyond the scene language while it makes a video. It searches the web and open
 * picture archives, opens pages and screenshots them, reads PDFs, takes frames from videos, generates pictures and
 * cuts things out of them, and keeps the pictures it chooses as the video's assets, which scenes then show with
 * `image id asset=NAME`. Every tool says what it is for; none decides for the agent when to use it.
 *
 * Which tools are offered depends on what this computer has: generating and cutting out need META_API_KEY, screenshots
 * need the headless Chrome the scenes already use, frames from video pages need yt-dlp. A tool whose provider is
 * missing is simply not listed.
 */
import { execFileSync } from "node:child_process";
import { realWeb, type Web } from "./net.ts";
import { pageChrome } from "./page.ts";

export interface Toolbox {
  /** For the services the toolbox is set up with (Meta's API), at the address in its settings. */
  fetch: typeof fetch;
  /** For every address the agent, a page or an archive names: checked, and connected to only at the checked address. */
  web: Web;
  env: NodeJS.ProcessEnv;
  /** The headless Chrome for screenshots and pages built by scripts. */
  chrome?: string;
  /** yt-dlp, for frames from pages with a video on them. */
  ytdlp?: string;
}

function which(bin: string): string | undefined {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" }).split("\n")[0]!.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function toolboxFromEnv(env: NodeJS.ProcessEnv = process.env): Toolbox {
  const chrome = pageChrome(env);
  const ytdlp = env.SCENES_YTDLP?.trim() || which("yt-dlp");
  return { fetch, web: realWeb(), env, ...(chrome ? { chrome } : {}), ...(ytdlp ? { ytdlp } : {}) };
}
