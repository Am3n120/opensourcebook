/**
 * What stops Open Sourcebook, and what must never: two copies side by side, a stale record, a reused process id, a program that
 * exits, a hang-up, and the words each stop leaves behind. A real launcher runs with a stand-in program (stub-launcher.ts).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findRunning } from "../commands/connect.ts";
import { processStart, readRunning, stillTheSame } from "../record.ts";
import { signalTree } from "../supervisor.ts";
import { runIn } from "./fake-engine.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-stops-")));
const everyone: ChildProcess[] = [];
const extra: number[] = [];
after(() => {
  for (const c of everyone) if (c.exitCode === null) c.kill("SIGKILL");
  // Whatever a test's launcher left behind: its recorded programs, found in the copies made here.
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    for (const child of readRunning(join(base, name, ".opensourcebook"))?.children ?? []) signalTree(child.pid, "SIGKILL");
  }
  for (const pid of extra) signalTree(pid, "SIGKILL");
  // Windows keeps a file in use until the process that holds it has fully gone.
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * What a process on Windows needs from its environment to run the system's own programs: SystemRoot to open a socket,
 * and the profile and temporary folders without which PowerShell (which tells a process's start time) stalls for many
 * seconds. Nothing elsewhere.
 */
const windowsBasics: Record<string, string> =
  process.platform === "win32"
    ? Object.fromEntries(
        ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "PSModulePath", "ComSpec", "PATHEXT", "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
          .map((n) => [n, process.env[n]] as const)
          .filter((e): e is readonly [string, string] => e[1] !== undefined),
      )
    : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(what: string, test: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** Asks a program until it answers, as the launcher does before it calls a program up; the answer's status. */
async function answers(url: string, ms = 15_000): Promise<number> {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try {
      return (await fetch(url)).status;
    } catch (e) {
      last = String((e as { cause?: unknown }).cause ?? e);
    }
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${url} to answer (${last})`);
}
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** A made-up Open Sourcebook folder: just enough (cli/opensourcebook.mjs and engine/package.json) for the command to know it as one. */
function copy(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "cli"), { recursive: true });
  mkdirSync(join(root, "engine"), { recursive: true });
  writeFileSync(join(root, "cli", "opensourcebook.mjs"), "");
  writeFileSync(join(root, "engine", "package.json"), "{}");
  return root;
}

interface Launched {
  root: string;
  home: string;
  child: ChildProcess;
  port: number;
  out: () => string;
  stops: () => string;
  program: () => number;
}

async function launch(name: string, env: Record<string, string> = {}): Promise<Launched> {
  const root = copy(name);
  const port = await freePort();
  // The launcher's own words go to a file beside the copy, so a launcher that never got ready can say why.
  const said = join(base, `${name}.out`);
  const fd = openSync(said, "w");
  const child = spawn(process.execPath, [join(import.meta.dirname, "stub-launcher.ts"), root, String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, ...windowsBasics, ...env },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  everyone.push(child);
  const home = join(root, ".opensourcebook");
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  try {
    await until(`${name} to be ready`, () => readRunning(home)?.ready === true);
  } catch (e) {
    // What the launcher and its program wrote says why, where the bare timeout would not.
    const logs = [join(home, "logs", "stops.log"), join(home, "logs", "stub.log"), said].map((f) => `--- ${f}\n${read(f)}`).join("\n");
    throw new Error(`${(e as Error).message}\n${JSON.stringify(readRunning(home))}\n${logs}`);
  }
  return {
    root,
    home,
    child,
    port,
    out: () => read(join(home, "logs", "stub.log")),
    stops: () => read(join(home, "logs", "stops.log")),
    program: () => readRunning(home)?.children?.[0]?.pid ?? 0,
  };
}

test("two copies side by side: stopping one leaves the other, its program and its record alone", async () => {
  const a = await launch("copy-a");
  const b = await launch("copy-b");
  const bProgram = b.program();
  assert.ok(alive(bProgram));
  const r = await runIn(["stop"], { home: a.home, root: a.root, cwd: a.root });
  assert.equal(r.code, 0, r.err);
  await until("a to be gone", () => !alive(a.child.pid!));
  assert.ok(alive(b.child.pid!), "b's launcher still runs");
  assert.ok(alive(bProgram), "b's program still runs");
  assert.equal(readRunning(b.home)?.ready, true);
  const stopped = await runIn(["stop"], { home: b.home, root: b.root, cwd: b.root });
  assert.equal(stopped.code, 0);
  await until("b to be gone", () => !alive(b.child.pid!));
  assert.equal(alive(bProgram), false, "its own program went with it");
});

test("an opensourcebook command that belongs to one copy refuses to stop or start from inside another copy, and does nothing", async () => {
  const a = await launch("copy-c");
  const other = copy("copy-d");
  for (const word of ["stop", "start"]) {
    const r = await runIn([word], { home: a.home, root: a.root, cwd: join(other, "engine") });
    assert.equal(r.code, 1);
    assert.match(r.err, /belongs to the Open Sourcebook in .*copy-c, but you are in the Open Sourcebook in .*copy-d/);
    assert.match(r.err, new RegExp(`copy-d[\\\\/]cli[\\\\/]opensourcebook.mjs" ${word}`));
  }
  assert.ok(alive(a.child.pid!), "nothing was stopped");
  // From a project folder that is not an Open Sourcebook copy it works as it always did.
  const fine = await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
  assert.equal(fine.code, 0);
});

test("a record left by an Open Sourcebook that is gone never makes opensourcebook stop signal a process that is not Open Sourcebook's", async () => {
  const root = copy("copy-e");
  const home = join(root, ".opensourcebook");
  mkdirSync(home, { recursive: true });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  everyone.push(bystander);
  // The old record: its process id is now this bystander's (the id was reused), but the start time is another one.
  writeFileSync(join(home, "running.json"), JSON.stringify({ pid: bystander.pid, startedAt: "Mon Jan  1 00:00:00 2024", url: "http://127.0.0.1:1", ports: { stub: 1 }, ready: true }));
  assert.equal(findRunning(home), undefined, "it does not count as running");
  const r = await runIn(["stop"], { home, root, cwd: base });
  assert.equal(r.code, 0);
  assert.match(r.out, /not running/);
  assert.match(r.out, /left alone/);
  assert.ok(alive(bystander.pid!), "the other process was not signalled");
  assert.equal(existsSync(join(home, "running.json")), false, "the stale record is cleaned away");
  // An older record with no start time at all: still never signals a process that is not an Open Sourcebook launcher.
  writeFileSync(join(home, "running.json"), JSON.stringify({ pid: bystander.pid, url: "http://127.0.0.1:1", ports: { stub: 1 } }));
  const old = await runIn(["stop"], { home, root, cwd: base });
  assert.equal(old.code, 0);
  assert.ok(alive(bystander.pid!), "still not signalled");
});

test("the same process id with the same start time is the one recorded; a different start time is not", () => {
  const mine = processStart(process.pid);
  assert.ok(mine);
  assert.equal(stillTheSame(process.pid, mine), true);
  assert.equal(stillTheSame(process.pid, "Mon Jan  1 00:00:00 2024"), false);
  assert.equal(stillTheSame(2 ** 22 + 99, mine), false);
});

test("a program that exits is started again and the rest of Open Sourcebook keeps running", async () => {
  const a = await launch("copy-f", { STUB_EXIT_FIRST: "2" });
  await until("two restarts", () => /is back/.test(a.stops()) && readFileSync(join(a.root, "starts.txt"), "utf8").length >= 3);
  assert.ok(alive(a.child.pid!), "the launcher is still there");
  const log = a.stops();
  assert.match(log, /Stub program exited on its own \(exit code 3\)/);
  assert.match(log, /Restarting Stub program in .* \(restart 1 of 3\)/);
  assert.match(log, /Stub program\s+is back/);
  await until("it to stay up", () => readFileSync(join(a.root, "starts.txt"), "utf8").length === 3);
  // The third start counts itself before it listens, so wait for its answer and not for a fixed moment.
  assert.equal(await answers(`http://127.0.0.1:${a.port}/up`), 200);
  assert.equal(readRunning(a.home)?.ready, true);
  await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
});

test("a program that keeps exiting stops Open Sourcebook with the program named and why", async () => {
  const a = await launch("copy-g", { STUB_EXIT_FIRST: "99", STUB_RESTART_MAX: "2" });
  await until("the launcher to give up", () => !alive(a.child.pid!));
  const log = a.stops();
  assert.match(log, /Stopping Open Sourcebook: Stub program exited with exit code 3 and could not be restarted \(2 restarts within 1 minutes\)/);
  assert.match(log, /Stopped\. Nothing of Open Sourcebook is left running\./);
  assert.equal(existsSync(join(a.home, "running.json")), false);
  assert.match(log, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/m, "every line has the time");
});

/** Windows ends a process outright when it is sent a signal, so a launcher there never hears one. */
const signals = { skip: process.platform === "win32" && "Windows ends a process outright instead of sending it a signal it can catch" };

test("opensourcebook stop says who asked", async () => {
  const a = await launch("copy-h");
  await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
  await until("a to be gone", () => !alive(a.child.pid!));
  assert.match(a.stops(), new RegExp(`Stopping Open Sourcebook: asked to stop by "opensourcebook stop" run from ${base.replace(/[\\/.]/g, "\\$&")} \\(process \\d+\\)`));
  assert.match(a.stops(), /Stopped\. Nothing of Open Sourcebook is left running\./);
});

test("a signal from elsewhere says that it was not this copy's opensourcebook stop", signals, async () => {
  const b = await launch("copy-i");
  b.child.kill("SIGTERM");
  await until("b to be gone", () => !alive(b.child.pid!));
  assert.match(b.stops(), /Stopping Open Sourcebook: signal SIGTERM from outside this copy's own "opensourcebook stop" \(with no terminal, its parent \(process \d+\) is still there\)/);

  const c = await launch("copy-j");
  c.child.kill("SIGINT");
  await until("c to be gone", () => !alive(c.child.pid!));
  assert.match(c.stops(), /Stopping Open Sourcebook: signal SIGINT, not from a Ctrl-C in a terminal of this copy/);
});

test("a hang-up stops a launcher that belongs to a terminal and says so; one started in the background ignores it", signals, async () => {
  const a = await launch("copy-k");
  a.child.kill("SIGHUP");
  await until("a to be gone", () => !alive(a.child.pid!));
  assert.match(a.stops(), /Stopping Open Sourcebook: signal SIGHUP: the terminal or program that started this one closed/);

  const b = await launch("copy-l", { OPENSOURCEBOOK_BACKGROUND: "1" });
  b.child.kill("SIGHUP");
  await until("the note", () => /Ignored signal SIGHUP/.test(b.stops()));
  await sleep(300);
  assert.ok(alive(b.child.pid!), "the background launcher stays up");
  assert.equal(readRunning(b.home)?.ready, true);
  await runIn(["stop"], { home: b.home, root: b.root, cwd: base });
  await until("b to be gone", () => !alive(b.child.pid!));
});

test("a launcher that was killed outright leaves its programs; opensourcebook stop ends those, its own recorded ones only", async () => {
  const a = await launch("copy-m");
  const program = a.program();
  extra.push(program);
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  everyone.push(bystander);
  a.child.kill("SIGKILL");
  await until("the launcher to be gone", () => !alive(a.child.pid!));
  if (process.platform === "win32") {
    // Nothing is left behind on Windows: Node puts each program it starts in a job that the system ends with the
    // launcher. So the program goes too, and a stop then only clears the record.
    await until("its program to go with it", () => !alive(program));
    const r = await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /not running/);
    assert.ok(alive(bystander.pid!), "nothing else was touched");
    return;
  }
  assert.ok(alive(program), "its program is left running");
  const recorded = readRunning(a.home);
  const r = await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Stopped/, `${r.out}recorded: ${JSON.stringify(recorded?.children)}; its start time now: ${processStart(program)}`);
  await until("the program to be gone", () => !alive(program));
  assert.ok(alive(bystander.pid!), "nothing else was touched");
});

test("a second start in the same copy sees the first even while it is still starting, and changes nothing", async () => {
  const a = await launch("copy-n");
  const r = await runIn(["start", "--background"], { home: a.home, root: a.root, cwd: base });
  assert.equal(r.code, 0);
  assert.match(r.out, /already running/);
  assert.ok(alive(a.child.pid!));
  assert.equal(readRunning(a.home)?.pid, a.child.pid);
  await runIn(["stop"], { home: a.home, root: a.root, cwd: base });
});

test("two launchers picking ports at the same moment never pick the same one, and a claim of a launcher that is gone counts for nothing", async () => {
  const tmp = join(base, "tmp-claims");
  mkdirSync(tmp);
  const first = 14000 + Math.floor(Math.random() * 1000);
  const script = `import { claimPort, pickPorts } from ${JSON.stringify(new URL("../ports.ts", import.meta.url).href)};
const ports = await pickPorts([{ name: "a", port: ${first} }, { name: "b", port: ${first + 1} }], async () => true, claimPort);
console.log(JSON.stringify(ports));
setInterval(() => undefined, 1000);`;
  // Each stays, holding its claims, until both have picked (a slow computer may need seconds between the two).
  const pickers: ChildProcess[] = [];
  // A temporary folder is TMPDIR on macOS and Linux, TEMP and TMP on Windows.
  const claimsEnv: Record<string, string> = process.platform === "win32" ? { TEMP: tmp, TMP: tmp } : { TMPDIR: tmp };
  const run = () =>
    new Promise<Record<string, number>>((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, ...windowsBasics, ...claimsEnv }, stdio: ["ignore", "pipe", "ignore"] });
      everyone.push(c);
      pickers.push(c);
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stdout.once("data", () => setTimeout(() => resolve(JSON.parse(out.trim().split("\n")[0]!)), 20));
    });
  const [x, y] = await Promise.all([run(), run()]);
  const all = [...Object.values(x), ...Object.values(y)];
  // The claims as they are, each with its process's start time as seen from here, say how two picked one port.
  const claimsNow = () =>
    readdirSync(join(tmp, "opensourcebook-port-claims"))
      .map((f) => {
        const text = readFileSync(join(tmp, "opensourcebook-port-claims", f), "utf8");
        const pid = (JSON.parse(text || "{}") as { pid?: number }).pid ?? 0;
        return `${f} ${text} (now ${processStart(pid)})`;
      })
      .join("; ");
  assert.equal(new Set(all).size, 4, `four different ports, got ${all.join(", ")}; claims: ${new Set(all).size === 4 ? "" : claimsNow()}`);
  for (const c of pickers) c.kill("SIGKILL");
  // A claim whose process is gone is taken over.
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => dead.once("exit", r));
  const port = first + 50;
  mkdirSync(join(tmp, "opensourcebook-port-claims"), { recursive: true });
  writeFileSync(join(tmp, "opensourcebook-port-claims", `${port}.json`), JSON.stringify({ pid: dead.pid, startedAt: "Mon Jan  1 00:00:00 2024" }));
  const names = Object.keys(claimsEnv);
  const old = names.map((n) => process.env[n]);
  for (const n of names) process.env[n] = tmp;
  try {
    const { claimPort } = await import("../ports.ts");
    assert.equal(claimPort(port), true);
  } finally {
    names.forEach((n, i) => (old[i] === undefined ? delete process.env[n] : (process.env[n] = old[i])));
  }
});
