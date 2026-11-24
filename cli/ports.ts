/**
 * Picks a free port for each program: its usual one when free, else the next free one above it. A port counts as
 * taken when something answers on it or this launcher cannot listen on it, so a server bound to every address is
 * seen too.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStart, stillTheSame } from "./record.ts";

export type PortCheck = (port: number) => Promise<boolean>;

/** True when nothing answers on 127.0.0.1:port and the launcher can listen there. */
export const isFree: PortCheck = async (port) => !(await answers(port)) && (await canListen(port));

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Two copies of Open Sourcebook that start at the same moment can both see a port as free and both pick it; the one that loses
 * then fails, or worse, answers for the other's program. So a launcher claims each port it picks in a small file
 * here (the port's number, the launcher's process and its start time), made so that only one claimant wins. A claim
 * whose launcher is gone, or whose process id belongs to something else now, counts for nothing. A claim is only
 * ever read to choose another port; nothing is ever signalled because of it.
 */
export const claimsDir = () => join(tmpdir(), "opensourcebook-port-claims");

export const claimPort = (port: number): boolean => {
  const file = join(claimsDir(), `${port}.json`);
  const mine = JSON.stringify({ pid: process.pid, startedAt: processStart(process.pid) });
  mkdirSync(claimsDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      return true;
    } catch {
      let owner: { pid?: number; startedAt?: string } = {};
      try {
        owner = JSON.parse(readFileSync(file, "utf8")) as typeof owner;
      } catch {
        // Being written by someone else right now, or unreadable: treat it as theirs.
        return false;
      }
      if (owner.pid === process.pid) return true;
      if (typeof owner.pid === "number" && stillTheSame(owner.pid, owner.startedAt)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
};

/** Gives back the claims this launcher made. */
export function releasePorts(ports: Record<string, number>): void {
  for (const port of Object.values(ports)) {
    const file = join(claimsDir(), `${port}.json`);
    try {
      if ((JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Not there, or not ours.
    }
  }
}

/**
 * One port per name, in order. Each starts from its wish and moves up past ports that are taken or already handed
 * out in this call. Throws a plain error when none is free within 100 ports.
 */
export async function pickPorts(wishes: Array<{ name: string; port: number }>, free: PortCheck = isFree, claim?: (port: number) => boolean): Promise<Record<string, number>> {
  const picked: Record<string, number> = {};
  const used = new Set<number>();
  for (const { name, port } of wishes) {
    let candidate = port;
    while (used.has(candidate) || !(await free(candidate)) || (claim && !claim(candidate))) {
      candidate += 1;
      if (candidate > port + 100 || candidate > 65535) throw new Error(`No free port for ${name} between ${port} and ${port + 100}. Stop something that uses those ports, or start with --ports-from <a free port>.`);
    }
    picked[name] = candidate;
    used.add(candidate);
  }
  return picked;
}
