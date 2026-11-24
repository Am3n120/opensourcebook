/**
 * Frames from a video on the web. A direct video file is read by ffmpeg at the moments asked; a page with a video on it
 * (YouTube, Vimeo, a news site, any of yt-dlp's sites) is first resolved by yt-dlp to the video's own address, when
 * yt-dlp is installed on this computer. Only the moments asked are read, never the whole video.
 *
 * ffmpeg and yt-dlp fetch on their own, so each is run with the toolbox's relay as its proxy (`relay.ts`): every
 * address they open, redirects and playlist parts included, is checked there. ffmpeg is also held to the web
 * (http, https and what they run on), so a playlist can't point it at a file on this computer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Resolved {
  /** What ffmpeg reads. */
  media: string;
  title?: string;
  seconds?: number;
}

const DIRECT = /\.(mp4|m4v|mov|webm|mkv|m3u8)($|\?)/i;

/** What ffmpeg may open: the web, through the relay. */
const WEB_ONLY = ["-protocol_whitelist", "http,https,tls,tcp,httpproxy,crypto"];

/** The environment for a program run with the relay as its proxy, nothing exempt from it. */
export function throughRelay(relay: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, http_proxy: relay, https_proxy: relay, HTTP_PROXY: relay, HTTPS_PROXY: relay, all_proxy: relay, ALL_PROXY: relay };
  delete out.no_proxy;
  delete out.NO_PROXY;
  return out;
}

const webAddress = (media: string) => {
  if (!/^https?:\/\//i.test(media)) throw new Error("That video is not at a web address.");
  return media;
};

export async function hasYtDlp(bin: string): Promise<boolean> {
  try {
    await run(bin, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The address ffmpeg can read for a video page or file, with its title and length when yt-dlp knows them. */
export async function resolveVideo(url: string, ytdlp: string | undefined, relay: string, signal?: AbortSignal): Promise<Resolved> {
  if (DIRECT.test(new URL(url).pathname)) return { media: webAddress(url), ...(await probeSeconds(url, relay, signal)) };
  if (!ytdlp) throw new Error("This is a page with a video on it, and yt-dlp is not installed on this computer (brew install yt-dlp), so only direct video files can be read.");
  const { stdout } = await run(ytdlp, ["--proxy", relay, "--no-warnings", "--no-playlist", "-f", "bv*[height<=1080][protocol^=http]/b[height<=1080]/bv*/b", "--print", "%(duration)s\t%(title)s", "--print", "urls", "--", url], { timeout: 60_000, maxBuffer: 8 << 20, signal, env: throughRelay(relay) });
  const [info, media] = stdout.trim().split("\n");
  if (!media) throw new Error("yt-dlp found no video on that page.");
  const [seconds, ...title] = (info ?? "").split("\t");
  return { media: webAddress(media.trim()), ...(Number(seconds) > 0 ? { seconds: Number(seconds) } : {}), ...(title.join("\t").trim() ? { title: title.join("\t").trim() } : {}) };
}

async function probeSeconds(media: string, relay: string, signal?: AbortSignal): Promise<{ seconds?: number }> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", ...WEB_ONLY, "-show_entries", "format=duration", "-of", "csv=p=0", webAddress(media)], { timeout: 30_000, signal, env: throughRelay(relay) });
    const s = Number(stdout.trim());
    return s > 0 ? { seconds: s } : {};
  } catch {
    return {};
  }
}

/** One frame at `at` seconds of the video at a web address, as a JPEG, read through the relay. */
export async function frameAt(media: string, at: number, out: string, relay: string, signal?: AbortSignal): Promise<void> {
  await run("ffmpeg", ["-y", "-v", "error", ...WEB_ONLY, "-ss", at.toFixed(2), "-i", webAddress(media), "-frames:v", "1", "-q:v", "2", "-update", "1", out], { timeout: 60_000, signal, env: throughRelay(relay) });
}
