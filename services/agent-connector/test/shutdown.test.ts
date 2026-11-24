/** What the connector says when it is told to end, so a connector that went away explains itself in its log. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function runUntilSignalled(signal: NodeJS.Signals): Promise<{ stderr: string; stdout: string; code: number | null }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")), OPENSOURCEBOOK_CONNECTOR_TOKEN: "t".repeat(24), OPENSOURCEBOOK_CONNECTOR_PORT: String(port), OPENSOURCEBOOK_AGENT_WORKSPACE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const listening = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (stdout.includes("Open Sourcebook agent connector on")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  await listening;
  const code = new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
  child.kill(signal);
  return { stdout, stderr: await code.then(() => stderr), code: await code };
}

test("a signal that ends the connector is written to its log with its name and its parent", { skip: process.platform === "win32" && "Windows ends a process outright instead of sending it a signal it can catch" }, async () => {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    const r = await runUntilSignalled(signal);
    assert.equal(r.code, 0);
    assert.match(r.stderr, new RegExp(`agent connector got ${signal} \\(parent process ${process.pid}\\); closing`));
    assert.match(r.stderr, /agent connector exits with code 0/);
  }
});
