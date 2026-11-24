/**
 * ffmpeg and ffprobe, which the app needs to make videos and audio. When the computer does not have one, it is
 * fetched with npm into the home's `tools/` and linked into the home's `bin/`. Nothing here stops an install: a
 * failure is a warning with one thing to do.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { layout } from "./paths.mjs";

/** The programs, the npm package that brings each, and where that package keeps the program. */
export const TOOLS = [
  { name: "ffmpeg", pack: "ffmpeg-static", file: (tools, exe) => join(tools, "node_modules", "ffmpeg-static", `ffmpeg${exe}`) },
  { name: "ffprobe", pack: "@ffprobe-installer/ffprobe", file: (tools, exe, platform, arch) => join(tools, "node_modules", "@ffprobe-installer", `${platform}-${arch}`, `ffprobe${exe}`) },
];

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Where a program is on the PATH, if anywhere. */
export function onPath(name, env = process.env, platform = process.platform) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const endings = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (env[key] ?? "").split(delimiter).filter(Boolean)) {
    for (const ending of endings) {
      const path = join(dir, name + ending);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

/** How to run npm with the Node that is running this: its own npm, never another one that happens to be on the PATH. */
export function npmCommand(execPath = process.execPath, platform = process.platform) {
  const dir = dirname(execPath);
  const scripts = platform === "win32" ? [join(dir, "node_modules", "npm", "bin", "npm-cli.js")] : [join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const script = scripts.find(existsSync);
  if (script) return { command: execPath, args: [script], shell: false };
  const beside = join(dir, platform === "win32" ? "npm.cmd" : "npm");
  if (existsSync(beside)) return { command: platform === "win32" ? `"${beside}"` : beside, args: [], shell: platform === "win32" };
  return { command: platform === "win32" ? "npm.cmd" : "npm", args: [], shell: platform === "win32" };
}

const advice = (platform) =>
  platform === "darwin" ? "install ffmpeg from ffmpeg.org/download.html (or with \"brew install ffmpeg\")" : platform === "win32" ? "run \"winget install ffmpeg\" in PowerShell" : "install ffmpeg with your system's software installer";

/**
 * Makes sure ffmpeg and ffprobe can be found. Returns { fetched: [names], warning?: sentence }.
 */
export async function ensureTools({ home, run, env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath, say = () => {} }) {
  const at = layout(home);
  const exe = platform === "win32" ? ".exe" : "";
  const missing = TOOLS.filter((tool) => !onPath(tool.name, env, platform) && !isFile(join(at.bin, tool.name + exe)));
  if (!missing.length) return { fetched: [] };
  const names = missing.map((tool) => tool.name).join(" and ");
  const warning = `${names} could not be fetched, so videos and audio cannot be made yet: ${advice(platform)}, then run "opensourcebook install" again.`;
  say(`Fetching ${names}, which Open Sourcebook uses to make videos and audio.`);
  try {
    mkdirSync(at.tools, { recursive: true });
    mkdirSync(at.bin, { recursive: true });
    const npm = npmCommand(execPath, platform);
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const result = await run(npm.command, [...npm.args, "install", "--prefix", at.tools, "--no-audit", "--no-fund", "--loglevel=error", ...missing.map((tool) => tool.pack)], {
      capture: true,
      shell: npm.shell,
      cwd: at.tools,
      env: { ...env, [key]: [dirname(execPath), env[key] ?? ""].filter(Boolean).join(delimiter) },
    });
    if (result.code !== 0) return { fetched: [], warning, detail: result.stderr };
    const fetched = [];
    for (const tool of missing) {
      const from = tool.file(at.tools, exe, platform, arch);
      if (!isFile(from)) continue;
      const to = join(at.bin, tool.name + exe);
      rmSync(to, { force: true });
      if (platform === "win32") copyFileSync(from, to);
      else {
        chmodSync(from, 0o755);
        symlinkSync(from, to);
      }
      fetched.push(tool.name);
    }
    return fetched.length === missing.length ? { fetched } : { fetched, warning: `${missing.filter((tool) => !fetched.includes(tool.name)).map((tool) => tool.name).join(" and ")} could not be fetched, so videos and audio cannot be made yet: ${advice(platform)}, then run "opensourcebook install" again.` };
  } catch (error) {
    return { fetched: [], warning, detail: String(error?.message ?? error) };
  }
}
