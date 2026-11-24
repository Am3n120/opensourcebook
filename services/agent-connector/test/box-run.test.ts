/**
 * The box's walls for real: small commands run under the generated profile with `sandbox-exec`, on a Mac only, with a
 * stand-in home folder (never the person's own). Skipped where there is no sandbox-exec.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SANDBOX_EXEC, seatbeltProfile } from "../src/box.ts";

const listen = (server: Server, where: string | number) =>
  new Promise<void>((resolve) => (typeof where === "string" ? server.listen(where, resolve) : server.listen(where, "127.0.0.1", resolve)));
const answering = () => createServer((socket) => {
  socket.on("error", () => undefined);
  socket.end("hi\n");
});

/** Runs `command` with /bin/sh in the box; true when it exited 0. */
function inBox(profile: string, command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", command], { cwd, env, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

test("in the box: no socket or file of the shared temporary folders, its own temporary folder, the connector's port, and the home folder shut", { skip: process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) }, async () => {
  const id = `opensourcebook-box-run-${process.pid}`;
  const userTemp = realpathSync(tmpdir());
  const home = realpathSync(mkdtempSync(join(userTemp, "opensourcebook-home-")));
  const work = join(home, "opensourcebook", "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_fake"), "not a key");
  // The agent's own temporary folder for the turn, as the connector makes it (0700, in this user's temporary folder).
  const own = realpathSync(mkdtempSync(join(userTemp, "opensourcebook-box-tmp-")));
  // Another program's socket and files in the shared temporary folders.
  const sock = `/private/tmp/${id}.sock`;
  const sharedFile = `/private/tmp/${id}.txt`;
  const userFile = join(userTemp, `${id}.txt`);
  writeFileSync(sharedFile, "someone else's");
  writeFileSync(userFile, "someone else's");
  const socketServer = answering();
  const connector = answering();
  const other = answering();
  await listen(socketServer, sock);
  await listen(connector, 0);
  await listen(other, 0);
  const port = (s: Server) => (s.address() as { port: number }).port;
  try {
    const profile = seatbeltProfile({ workspace: work, home, read: [], write: [], connectorPort: port(connector), tmp: own });
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: `${own}/` };
    const run = (command: string) => inBox(profile, command, work, env);
    // The checks of the stand-ins themselves, outside the box, so a "shut" below means the box and not a broken check.
    assert.equal(await new Promise<boolean>((resolve) => spawn("/bin/sh", ["-c", `/usr/bin/nc -U ${sock} </dev/null | grep -q hi`]).on("close", (c) => resolve(c === 0))), true);

    assert.equal(await run("echo ok > note.txt && cat note.txt"), true, "the work folder");
    assert.equal(await run(`/usr/bin/nc -U ${sock} </dev/null | grep -q hi`), false, "a Unix socket in /private/tmp");
    assert.equal(await run(`cat ${sharedFile}`), false, "reading a file in /private/tmp");
    assert.equal(await run(`cat /tmp/${id}.txt`), false, "reading it as /tmp");
    assert.equal(await run(`ls /private/tmp`), false, "listing /private/tmp");
    assert.equal(await run(`touch /private/tmp/${id}-w`), false, "writing in /private/tmp");
    assert.equal(await run(`cat ${userFile}`), false, "reading a file in this user's /private/var/folders temporary folder");
    assert.equal(await run(`touch ${join(userTemp, `${id}-w`)}`), false, "writing there");
    assert.equal(await run(`touch /private/var/tmp/${id}-w`), false, "writing in /private/var/tmp");
    assert.equal(await run('echo x > "$TMPDIR/a" && cat "$TMPDIR/a" && mkdir "$TMPDIR/d" && mktemp "$TMPDIR/x.XXXXXX"'), true, "its own TMPDIR");
    assert.equal(await run(`/usr/bin/python3 -c 'import tempfile; tempfile.mkstemp()'`), true, "a program's own temporary file, through TMPDIR");
    writeFileSync(join(own, "opensourcebook-system-prompt.txt"), "prompt-in-box\n");
    assert.equal(await run('test "$(cat "$TMPDIR/opensourcebook-system-prompt.txt")" = "prompt-in-box"'), true, "reading a system prompt file placed in the turn's tmp");
    assert.equal(await run(`/usr/bin/nc -z 127.0.0.1 ${port(connector)}`), true, "the connector's port");
    assert.equal(await run(`/usr/bin/nc -z -w 3 127.0.0.1 ${port(other)}`), false, "another local port");
    assert.equal(await run(`cat ${join(home, ".ssh", "id_fake")}`), false, "a key in the home folder");
    assert.equal(await run(`ls ${home}`), false, "the home folder");
    assert.equal(await run(`touch ${join(home, "x")}`), false, "writing in the home folder");
  } finally {
    socketServer.close();
    connector.close();
    other.close();
    for (const path of [home, own, sock, sharedFile, userFile, `/private/tmp/${id}-w`, join(userTemp, `${id}-w`), `/private/var/tmp/${id}-w`]) rmSync(path, { recursive: true, force: true });
  }
});
