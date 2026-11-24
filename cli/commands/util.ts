/** Small pieces the command groups share: opening the app, waiting, and laying out rows. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAddress } from "../opener.ts";
import { findRunning, START_HINT } from "./connect.ts";
import { Problem, type Ctx } from "./table.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens an address in the person's browser, unless OPENSOURCEBOOK_NO_OPEN=1 or CI says not to. Returns whether it tried. */
export function openUrl(ctx: Pick<Ctx, "env">, target: string): boolean {
  if (ctx.env.OPENSOURCEBOOK_NO_OPEN === "1" || ctx.env.CI) return false;
  const [command, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The address that lets this computer's browser into the running Open Sourcebook and then shows `path` (cli/opener.ts): the
 * launcher makes a one-time code for it. Only a program that can read this clone's `.opensourcebook/` can ask for one.
 */
export async function browserAddress(ctx: Pick<Ctx, "home">, path = "/"): Promise<string> {
  const running = findRunning(ctx.home);
  if (!running) throw new Problem("not_running", `Open Sourcebook is not running. ${START_HINT}`);
  let token: string | undefined;
  try {
    token = (JSON.parse(readFileSync(join(ctx.home, "secrets.json"), "utf8")) as { PHONE_TOKEN?: string }).PHONE_TOKEN;
  } catch {
    token = undefined;
  }
  const port = running.ports["phone-control"];
  if (!token || !port) throw new Problem("not_running", 'Open Sourcebook is running but cannot let a browser in; stop it with "opensourcebook stop" and start it again.');
  let code: string | undefined;
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/browser/code`, { method: "POST", headers: { "x-phone-token": token }, signal: AbortSignal.timeout(10_000) });
    code = answer.ok ? ((await answer.json()) as { code?: string }).code : undefined;
  } catch {
    code = undefined;
  }
  if (!code) throw new Problem("not_running", 'Open Sourcebook did not answer; "opensourcebook status" says what is up.');
  return openAddress(running.url, code, path);
}

/** Rows as aligned columns. */
export function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join("").trimEnd()).join("\n");
}

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Minutes from the `--timeout` flag, or the default. */
export function timeoutMs(ctx: Ctx, defaultMinutes: number): number {
  const raw = ctx.flags.timeout;
  const minutes = typeof raw === "string" ? Number(raw) : defaultMinutes;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultMinutes) * 60_000;
}
