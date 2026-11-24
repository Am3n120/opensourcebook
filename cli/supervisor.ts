/**
 * Starts programs as child processes, waits until each answers, and stops all of them together. Each child runs in a
 * process group of its own (on macOS and Linux), so stopping it also stops whatever it started (wrangler's workerd,
 * vite's Worker runtime). Output goes to a log file per program, not to the screen.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";

export interface Started {
  id: string;
  child: ChildProcess;
  log: string;
  /** Resolves when the process has exited, with its code or signal. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** True once exited resolved. */
  gone: boolean;
  /** When it exited, in ms. */
  goneAt?: number;
}

export function startProcess(id: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string; /** Keep what the log holds (a restart) instead of starting it empty. */ append?: boolean }): Started {
  const out = createWriteStream(options.log, { flags: options.append ? "a" : "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  const started: Started = {
    id,
    child,
    log: options.log,
    gone: false,
    exited: new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (started.gone) return;
        started.gone = true;
        started.goneAt = Date.now();
        out.end();
        resolve({ code, signal });
      };
      child.once("exit", finish);
      child.once("error", (error) => {
        out.write(`\n${error.message}\n`);
        finish(1, null);
      });
    }),
  };
  return started;
}

/** Sends a signal to the child's whole process group; nothing happens when the group is already gone. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) signalTree(child.pid, signal);
}

/**
 * Sends a signal to a process and whatever it started: its process group on macOS and Linux (`pid` leads one). Windows
 * has neither groups nor signals a program can catch, so there a stop of either kind ends the process and every
 * process under it (taskkill /T /F). Nothing happens when it is already gone.
 */
export function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (signal === "SIGKILL" || signal === "SIGTERM") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

/**
 * Stops every program: a polite stop first, then, after `graceMs`, a hard one for anything still there. Always ends
 * with a hard stop of each process group, so helpers a program started do not outlive it.
 */
export async function stopAll(started: Started[], graceMs = 5_000): Promise<void> {
  for (const s of started) if (!s.gone) signalGroup(s.child, "SIGTERM");
  await Promise.race([Promise.all(started.map((s) => s.exited)), new Promise((r) => setTimeout(r, graceMs).unref())]);
  // A program that left long ago may have a process id that something else has now: only groups of programs that
  // left just now (their helpers may still be there) or are still there get the hard stop.
  const now = Date.now();
  for (const s of started) if (!s.gone || now - (s.goneAt ?? now) < 15_000) signalGroup(s.child, "SIGKILL");
  await Promise.race([Promise.all(started.map((s) => s.exited)), new Promise((r) => setTimeout(r, 2_000).unref())]);
}

export type Probe = (url: string, token?: string) => Promise<{ ok: boolean; body?: unknown }>;

/** Asks a route once, with a short timeout. Any 2xx counts as up; its JSON body is kept when there is one. */
export const httpProbe: Probe = async (url, token) => {
  try {
    const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false };
    const text = await response.text();
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false };
  }
};

/**
 * Waits until the route answers, the process exits, or time runs out. Returns how it ended.
 */
export async function waitUntilUp(
  s: Pick<Started, "exited" | "gone">,
  url: string,
  token: string | undefined,
  withinMs: number,
  probe: Probe = httpProbe,
  everyMs = 400,
): Promise<{ up: true; body?: unknown } | { up: false; why: "exited" | "timeout" }> {
  const until = Date.now() + withinMs;
  let exited = false;
  void s.exited.then(() => (exited = true));
  while (Date.now() < until) {
    if (exited || s.gone) return { up: false, why: "exited" };
    const answer = await probe(url, token);
    if (answer.ok) return { up: true, ...(answer.body !== undefined ? { body: answer.body } : {}) };
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { up: false, why: exited ? "exited" : "timeout" };
}

/** The last lines of a log, for saying why a program stopped. */
export function tail(file: string, lines = 8): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
}
