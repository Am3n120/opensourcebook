/**
 * What a running launcher records about itself in its own `.opensourcebook/running.json`, and how anything that reads it makes
 * sure a process id still belongs to that launcher before it signals it. A process id alone proves nothing: after a
 * crash or a reboot the file stays, and the number may now be any other program on this computer. So each process is
 * recorded with the time it started (what `ps` says, or PowerShell on Windows), and a signal goes only to a process whose start time still
 * matches. Nothing here looks at a name pattern, a port or a process group it did not record.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./secrets.ts";

export interface ChildRecord {
  id: string;
  pid: number;
  /** `processStart(pid)` taken just after it started. */
  startedAt?: string | undefined;
}

export interface Running {
  pid: number;
  /** The web app's address. */
  url: string;
  ports: Record<string, number>;
  /** `processStart(pid)` of the launcher; absent in a file an older launcher wrote. */
  startedAt?: string | undefined;
  /** The repo the launcher belongs to, so a message can say whose it is. */
  root?: string;
  /** False while the programs are still starting (the file is written first, so a second start sees it). */
  ready?: boolean;
  /** The programs it started, each with its own start time. */
  children?: ChildRecord[];
}

export const RUNNING_FILE = "running.json";
export const STOP_REQUEST_FILE = "stop-request.json";
export const STOPS_LOG = join("logs", "stops.log");

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** What PowerShell prints for `command`, trimmed; "" when it fails. Windows has no `ps`; this is its way to ask. */
function powershell(command: string): string {
  const env = { ...process.env, SystemRoot: process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows" };
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", env, timeout: 15_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : "";
}

/**
 * When a process started, or undefined when it is not there: as `ps` prints it ("Wed Nov 18 14:03:22 2026"), and on
 * Windows as the system's file time of its start (a number that names the same moment, whatever the language).
 */
export function processStart(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") return powershell(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`) || undefined;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5_000 });
  const text = r.status === 0 ? r.stdout.trim() : "";
  return text || undefined;
}

function commandOf(pid: number): string {
  if (process.platform === "win32") return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process is there but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is `pid` still the process recorded with `startedAt`? Without a recorded start time (a file an older launcher
 * wrote) the process must at least be there; `strict` then also asks that it is an Open Sourcebook launcher by its command line.
 */
export function stillTheSame(pid: number, startedAt: string | undefined, strict = false): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  if (startedAt) return processStart(pid) === startedAt;
  return strict ? /[\\/](opensourcebook|re)\.mjs|cli[\\/]main\.ts/.test(commandOf(pid)) : true;
}

export function readRunning(home: string): Running | undefined {
  const r = readJson<Running>(join(home, RUNNING_FILE));
  return r && typeof r.pid === "number" ? r : undefined;
}

export function writeRunning(home: string, record: Running): void {
  writePrivate(join(home, RUNNING_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export function removeRunning(home: string, onlyIfPid?: number): void {
  if (onlyIfPid !== undefined && readRunning(home)?.pid !== onlyIfPid) return;
  rmSync(join(home, RUNNING_FILE), { force: true });
}

/** The launcher recorded in this `.opensourcebook/` that is still the same process, ready or not. */
export function findLauncher(home: string, strict = false): Running | undefined {
  const r = readRunning(home);
  return r && stillTheSame(r.pid, r.startedAt, strict) ? r : undefined;
}

/** Programs a launcher recorded that are still the very processes it started (their leader, so their group is theirs). */
export function ownChildren(record: Running): ChildRecord[] {
  return (record.children ?? []).filter((c) => c.startedAt && stillTheSame(c.pid, c.startedAt));
}

export interface StopRequest {
  /** The folder `opensourcebook stop` was run from. */
  from: string;
  /** The process of `opensourcebook stop`. */
  by: number;
  /** Which launcher it meant. */
  target: number;
  at: string;
}

/** `opensourcebook stop` leaves a note for the launcher it is about to signal, so the launcher can say who asked. */
export function askToStop(home: string, request: StopRequest): void {
  writePrivate(join(home, STOP_REQUEST_FILE), `${JSON.stringify(request)}\n`);
}

/** The note of a `opensourcebook stop` that named this launcher in the last minute; undefined when there is none. */
export function stopAskedOf(home: string, pid: number, now = Date.now()): StopRequest | undefined {
  const r = readJson<StopRequest>(join(home, STOP_REQUEST_FILE));
  if (!r || r.target !== pid || !(now - Date.parse(r.at) < 60_000)) return undefined;
  return r;
}

export function clearStopRequest(home: string): void {
  rmSync(join(home, STOP_REQUEST_FILE), { force: true });
}


/** Local time as `2026-11-18 14:03:22`, for every line that says why Open Sourcebook stopped. */
export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
