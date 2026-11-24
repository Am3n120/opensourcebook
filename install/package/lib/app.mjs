/** Talking to the app itself: finding its entry, and asking it to start, stop and open. */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { layout } from "./paths.mjs";
import { Problem } from "./problem.mjs";

export const isInstalled = (home) => existsSync(join(layout(home).app, "package.json"));

/** The app's entry: the first `bin` its own package.json names. */
export function entryOf(appDir) {
  let bin;
  try {
    bin = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).bin;
  } catch {
    bin = undefined;
  }
  const first = typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin)[0] : undefined;
  if (typeof first !== "string" || !first) throw new Problem(`The Open Sourcebook files in ${appDir} are not complete.`, 'Run "opensourcebook install" to put them back.');
  return join(appDir, first);
}

/** The environment the app runs in: this Node's folder and the home's `bin` come first on the PATH, so it finds npm and ffmpeg. */
export function appEnv(home, env = process.env, execPath = process.execPath) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const front = [dirname(execPath), layout(home).bin];
  const rest = (env[key] ?? "").split(delimiter).filter((dir) => dir && !front.includes(dir));
  return { ...env, [key]: [...front, ...rest].join(delimiter) };
}

/** Runs the app's entry with these words. Resolves with { code, stdout, stderr }. */
export function runApp({ home, args, run, env = process.env, execPath = process.execPath, cwd, capture = false }) {
  const appDir = layout(home).app;
  return run(execPath, [entryOf(appDir), ...args], { cwd: cwd ?? appDir, env: appEnv(home, env, execPath), capture });
}

/**
 * Asks the app to stop, and says whether a copy was running: the app is the one that knows. A copy that will not
 * stop is a problem; an app too broken to answer is not running.
 */
export async function stopApp(deps) {
  if (!isInstalled(deps.home)) return false;
  let result;
  try {
    result = await runApp({ ...deps, args: ["stop", "--json"], capture: true, cwd: undefined });
  } catch {
    return false;
  }
  let answer;
  try {
    answer = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    return false;
  }
  if (answer.ok === false) throw new Problem("The running Open Sourcebook did not stop.", "Restart the computer and run the same command again.", new Error(answer.error?.message));
  return answer.stopped === true;
}

/** Whether the app says it is running (its own `status`). */
export async function isRunning(deps) {
  if (!isInstalled(deps.home)) return false;
  try {
    const result = await runApp({ ...deps, args: ["status", "--json"], capture: true, cwd: undefined });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)).running === true;
  } catch {
    return false;
  }
}

/** Starts the app in the background and returns once it answers; the app says what it is doing meanwhile. */
export async function startApp(deps, portsFrom) {
  const result = await runApp({ ...deps, args: ["start", "--background", ...(portsFrom ? ["--ports-from", String(portsFrom)] : [])], cwd: undefined });
  if (result.code !== 0) throw new Problem("Open Sourcebook was installed but did not start.", 'Run "opensourcebook" to try starting it again.');
}

export async function openApp(deps) {
  const result = await runApp({ ...deps, args: ["open"], cwd: undefined });
  if (result.code !== 0) throw new Problem("Open Sourcebook is running but the browser could not be opened.", 'Run "opensourcebook open" to try again.');
}
