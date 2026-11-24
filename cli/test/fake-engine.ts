/**
 * A stand-in for Open Sourcebook's engine, for the command's tests only: an HTTP server on a free port that answers the routes a
 * test gives it, records every call, and checks the client token. With a `.opensourcebook/` folder that says an Open Sourcebook is running
 * here, the command finds it exactly as it finds the real one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Io } from "../commands/index.ts";

export const TOKEN = "client-token-for-tests-0123456789";
export const PHONE_TOKEN = "phone-token-for-tests-0123456789";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  raw: Buffer;
  headers: IncomingMessage["headers"];
}

export type Handler = (call: Call) => unknown | [number, unknown];

export interface Fake {
  url: string;
  calls: Call[];
  routes: Record<string, Handler>;
  home: string;
  dir: string;
  close(): Promise<void>;
  /** Runs `opensourcebook <argv>` against this engine; stdout and stderr as text. */
  command(argv: string[], cwd?: string): Promise<{ code: number; out: string; err: string; json: () => Record<string, unknown> }>;
}

/** Routes are `"METHOD /v1/path"`, with `:x` matching one segment. */
function match(routes: Record<string, Handler>, method: string, path: string): Handler | undefined {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ") as [string, string];
    if (m !== method) continue;
    const shape = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
    if (shape.test(path)) return handler;
  }
  return undefined;
}

export async function fakeEngine(routes: Record<string, Handler> = {}): Promise<Fake> {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const raw = Buffer.concat(chunks);
      let body: unknown;
      try {
        body = raw.length && String(req.headers["content-type"]).includes("json") ? JSON.parse(raw.toString("utf8")) : undefined;
      } catch {
        body = undefined;
      }
      const call: Call = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body, raw, headers: req.headers };
      calls.push(call);
      const send = (status: number, value: unknown) => {
        if (value instanceof Uint8Array) {
          res.writeHead(status, { "content-type": "video/mp4" });
          res.end(value);
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      // The launcher's control answers on the same server here: a one-time code to let the browser in.
      if (call.method === "POST" && url.pathname === "/browser/code") {
        return req.headers["x-phone-token"] === PHONE_TOKEN ? send(200, { code: "open-code-1", expiresAt: new Date(0).toISOString() }) : send(401, { error: "unauthorized" });
      }
      if (req.headers["x-client-token"] !== TOKEN && !url.pathname.startsWith("/v1/assets/")) return send(403, { error: "forbidden", message: "Wrong client token" });
      const handler = match(fake.routes, call.method, call.path);
      if (!handler) return send(404, { error: "not_found", message: `No route ${call.method} ${call.path} in the test` });
      const answer = handler(call);
      if (Array.isArray(answer) && typeof answer[0] === "number") send(answer[0], answer[1]);
      else send(200, answer);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-command-"));
  const home = join(dir, ".opensourcebook");
  mkdirSync(home);
  writeFileSync(join(home, "running.json"), JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:1", ports: { engine: port, web: 1, "phone-control": port } }));
  writeFileSync(join(home, "secrets.json"), JSON.stringify({ OPENSOURCEBOOK_CLIENT_TOKEN: TOKEN, PHONE_TOKEN }));
  const fake: Fake = {
    url: `http://127.0.0.1:${port}`,
    calls,
    routes,
    home,
    dir,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
    command: (argv, cwd = dir) => runIn(argv, { home, cwd }),
  };
  return fake;
}

/** Runs the command with its output caught, in a given `.opensourcebook/` home and folder. */
export async function runIn(argv: string[], where: { home: string; cwd: string; root?: string; env?: NodeJS.ProcessEnv }) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (t) => (out += `${t}\n`),
    stderr: (t) => (err += `${t}\n`),
    env: { OPENSOURCEBOOK_NO_OPEN: "1", PATH: process.env.PATH, ...where.env },
    cwd: where.cwd,
    root: where.root ?? join(import.meta.dirname, "..", ".."),
    home: where.home,
    pollMs: 5,
  };
  const code = await runCommand(argv, io);
  return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> };
}
