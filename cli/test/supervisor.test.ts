import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startProcess, stopAll, tail, waitUntilUp } from "../supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-supervisor-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A program that starts a helper which ignores a polite stop, like a runtime a dev server leaves behind.
const STUBBORN = `
const { spawn } = require("node:child_process");
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("helper " + helper.pid);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

test("stopping stops the program and everything it started, even what ignores a polite stop", { skip: process.platform === "win32" && "process groups are POSIX" }, async () => {
  const log = join(dir, "stubborn.log");
  const s = startProcess("stubborn", process.execPath, ["-e", STUBBORN], { cwd: dir, env: process.env, log });
  let helper = 0;
  for (let i = 0; i < 50 && !helper; i++) {
    await new Promise((r) => setTimeout(r, 100));
    helper = Number(/helper (\d+)/.exec(readFileSync(log, "utf8"))?.[1] ?? 0);
  }
  assert.ok(helper > 0, "the helper started");
  assert.ok(alive(s.child.pid!) && alive(helper));
  const t = Date.now();
  await stopAll([s], 300);
  assert.ok(Date.now() - t < 5_000);
  assert.equal(s.gone, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(helper), false, "nothing is left running");
});

test("a program that stops on a polite stop is not forced", { skip: process.platform === "win32" && "Windows has no polite stop to send: a stop there ends the program outright" }, async () => {
  const s = startProcess("polite", process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, env: process.env, log: join(dir, "polite.log") });
  await new Promise((r) => setTimeout(r, 200));
  await stopAll([s], 5_000);
  assert.equal((await s.exited).signal, "SIGTERM");
});

test("waits until the route answers, and keeps its JSON", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    if (calls < 3) return void res.writeHead(503).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const answer = await waitUntilUp({ exited: new Promise(() => undefined), gone: false }, `http://127.0.0.1:${port}/health`, undefined, 5_000, undefined, 20);
    assert.deepEqual(answer, { up: true, body: { ok: true } });
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test("a program that exits before it answers is reported as exited, not waited on", async () => {
  const s = startProcess("dies", process.execPath, ["-e", "console.log('bad setting'); process.exit(3)"], { cwd: dir, env: process.env, log: join(dir, "dies.log") });
  const answer = await waitUntilUp(s, "http://127.0.0.1:1/health", undefined, 10_000, async () => ({ ok: false }), 20);
  assert.deepEqual(answer, { up: false, why: "exited" });
  assert.equal((await s.exited).code, 3);
  assert.deepEqual(tail(s.log), ["bad setting"]);
});

test("a program that never answers times out", async () => {
  const answer = await waitUntilUp({ exited: new Promise(() => undefined), gone: false }, "http://x", undefined, 100, async () => ({ ok: false }), 20);
  assert.deepEqual(answer, { up: false, why: "timeout" });
});
