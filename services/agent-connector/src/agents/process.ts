/** Running a CLI as a child process: its output line by line, a clean stop, and a plain answer for "is it installed". */
import { spawn, type ChildProcess } from "node:child_process";
import { isOwnSetting } from "../names.ts";
import { commandFor } from "./command.ts";

export interface Spawned {
  child: ChildProcess;
  /** Resolves with the exit code (null when killed) and what it wrote to stderr; `missing` when the binary is not there. */
  exited: Promise<{ code: number | null; stderr: string; missing: boolean }>;
}

export function run(bin: string, args: string[], options: { cwd?: string; stdin?: string; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv }): Spawned {
  const env = options.env ?? agentEnv();
  // On Windows an agent npm installed is a .cmd file, started here through the script it runs (command.ts).
  const command = commandFor(bin, args, env);
  const child = spawn(command.bin, command.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(command.verbatim ? { windowsVerbatimArguments: true } : {}) });
  let stderr = "";
  let buffer = "";
  let missing = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) options.onLine?.(line);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // Kept short: only for telling a failure apart, never forwarded.
    if (stderr.length < 8_000) stderr += chunk;
  });
  child.stdin?.on("error", () => undefined);
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  else child.stdin?.end();
  const exited = new Promise<{ code: number | null; stderr: string; missing: boolean }>((resolve) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") missing = true;
      resolve({ code: null, stderr: stderr || error.message, missing });
    });
    child.on("close", (code) => {
      if (buffer.trim()) options.onLine?.(buffer.trim());
      resolve({ code, stderr, missing });
    });
  });
  return { child, exited };
}

/** Stops a child: asks first, then insists. */
export function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3_000).unref();
}

/** The first line a CLI prints for `args` (its version), or undefined when it is not installed or fails. */
export async function firstLine(bin: string, args: string[], timeoutMs = 10_000): Promise<{ text?: string; missing: boolean }> {
  const lines: string[] = [];
  const spawned = run(bin, args, { onLine: (line) => lines.push(line) });
  const timer = setTimeout(() => stop(spawned.child), timeoutMs);
  const result = await spawned.exited;
  clearTimeout(timer);
  if (result.missing) return { missing: true };
  return result.code === 0 && lines[0] ? { text: lines[0], missing: false } : { missing: false };
}

/** Every line a CLI prints for `args` and its exit code; `missing` when it is not installed. Stopped after `timeoutMs`. */
export async function allLines(bin: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<{ lines: string[]; code: number | null; missing: boolean }> {
  const out: string[] = [];
  const spawned = run(bin, args, { onLine: (line) => out.push(line), ...(options.env ? { env: options.env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) });
  const timer = setTimeout(() => stop(spawned.child), options.timeoutMs ?? 10_000);
  const result = await spawned.exited;
  clearTimeout(timer);
  return { lines: out, code: result.code, missing: result.missing };
}

/**
 * The environment an agent runs with outside the box: the connector's own, less Open Sourcebook's settings (`OPENSOURCEBOOK_*`, and `RE_*` as they were named before: the
 * connector's token, the API keys the person gave it), plus `extra`. The agent finds its own login as it always does.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !isOwnSetting(key))), ...extra };
}

/** A value that is asked for again only once it is older than `ms`. */
export class Remembered<T> {
  private value?: { at: number; value: T };
  private readonly ms: number;

  constructor(ms: number) {
    this.ms = ms;
  }

  async get(load: () => Promise<T>): Promise<T> {
    if (this.value && Date.now() - this.value.at < this.ms) return this.value.value;
    const value = await load();
    this.value = { at: Date.now(), value };
    return value;
  }
}

/** An agent's own words on why its turn failed, as `TurnEnd.said`: one line, at most 300 characters; none when empty. */
export function saidOf(words: string | undefined): { said?: string } {
  const line = words?.replace(/\s+/g, " ").trim();
  return line ? { said: line.length > 300 ? `${line.slice(0, 299)}…` : line } : {};
}
