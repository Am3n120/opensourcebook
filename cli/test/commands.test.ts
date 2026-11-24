import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GROUPS, resolve } from "../commands/index.ts";
import { describeAll, helpAll, helpCommand, helpGroup, parse, usageHint } from "../commands/table.ts";
import { runIn } from "./fake-engine.ts";

const all = GROUPS.flatMap((g) => g.commands);
const empty = mkdtempSync(join(tmpdir(), "opensourcebook-nothing-"));
after(() => rmSync(empty, { recursive: true, force: true }));

test("every command is one entry with a summary, a JSON shape and a handler, and no two share a name", () => {
  const names = all.map(usageHint);
  assert.equal(new Set(names).size, names.length);
  for (const c of all) {
    assert.ok(c.summary.length > 10, `${usageHint(c)} has a summary`);
    assert.ok(c.shape.trim().length > 2, `${usageHint(c)} documents its --json answer`);
    assert.equal(typeof c.run, "function");
  }
});

test("help is made from the table: every command is in opensourcebook help, its group's help and its own help", () => {
  const top = helpAll(GROUPS);
  for (const g of GROUPS) {
    const own = g.thing ? helpGroup(g) : "";
    for (const c of g.commands) {
      assert.ok(top.includes(usageHint(c)), `${usageHint(c)} is in opensourcebook help`);
      if (g.thing) assert.ok(own.includes(usageHint(c)), `${usageHint(c)} is in opensourcebook ${g.thing} help`);
      const mine = helpCommand(c);
      assert.ok(mine.includes(c.summary));
      assert.ok(mine.includes("--json answer:"));
      const answer = mine.split("\n").find((l) => l.startsWith("--json answer:"))!;
      assert.equal(answer.split("{").length, answer.split("}").length, `${usageHint(c)} help closes every brace it opens, and no more`);
      for (const f of c.flags ?? []) assert.ok(mine.includes(`--${f.name}`), `${usageHint(c)} help names --${f.name}`);
    }
  }
  const described = describeAll(GROUPS).commands as Array<{ command: string; json: string }>;
  assert.equal(described.length, all.length);
  assert.ok(described.every((d) => d.json));
});

test("opensourcebook help, opensourcebook <thing> help and opensourcebook <thing> <action> help all answer, in words and in JSON", async () => {
  const home = join(empty, ".opensourcebook");
  for (const argv of [["help"], ["--help"], ["project"], ["project", "help"], ["plan", "start", "help"], ["help", "plan", "start"], ["status", "help"], ["chats", "ask", "--help"]]) {
    const r = await runIn(argv, { home, cwd: empty });
    assert.equal(r.code, 0, argv.join(" "));
    assert.ok(r.out.length > 20);
    const j = await runIn([...argv, "--json"], { home, cwd: empty });
    assert.equal(j.json().ok, true, `${argv.join(" ")} --json`);
  }
});

test("plurals find the same thing", () => {
  const a = resolve(["projects", "list"]);
  const b = resolve(["project", "list"]);
  assert.ok("command" in a && "command" in b && a.command === b.command);
});

test("argument problems are one plain sentence, with a stable code in JSON, never a stack trace", async () => {
  const home = join(empty, ".opensourcebook");
  const cases: Array<[string[], string, RegExp]> = [
    [["nonsense"], "unknown_command", /opensourcebook does not know "nonsense"\. Run "opensourcebook help"/],
    [["project", "fly"], "unknown_command", /has no "fly"; it has list, make/],
    [["project", "make"], "bad_arguments", /needs <title>/],
    [["project", "list", "--colour", "red"], "bad_arguments", /"--colour" is not a flag of opensourcebook project list/],
    [["source", "read"], "bad_arguments", /needs <source>/],
    [["plan", "show", "a", "b"], "bad_arguments", /does not take "b"/],
    [["start", "--ports-from", "80", "--background"], "bad_arguments", /between 1024 and 65000/],
    [["chat", "ask", "--timeout"], "bad_arguments", /"--timeout" needs a value/],
  ];
  for (const [argv, code, words] of cases) {
    const r = await runIn(argv, { home, cwd: empty });
    assert.equal(r.code, 1, argv.join(" "));
    assert.match(r.err, words);
    assert.doesNotMatch(r.err, /\n\s+at /, "no stack trace");
    assert.equal(r.err.trim().split("\n").length, 1, "one sentence");
    const j = await runIn([...argv, "--json"], { home, cwd: empty });
    const e = j.json();
    assert.equal(e.ok, false);
    assert.equal((e.error as { code: string }).code, code);
    assert.equal(j.err, "", "with --json nothing but the answer, on stdout");
  }
});

test("parse: rest words join, many words stay a list, flags take values, switches do not", () => {
  const ask = all.find((c) => usageHint(c) === "opensourcebook chat ask")!;
  const p = parse(ask, ["why", "is", "it", "--chat", "c1", "so?", "--source=s1", "--source", "s2"]);
  assert.equal(p.args.question, "why is it so?");
  assert.equal(p.flags.chat, "c1");
  assert.deepEqual(p.flags.source, ["s1", "s2"]);
  const add = all.find((c) => usageHint(c) === "opensourcebook source add")!;
  assert.deepEqual(parse(add, ["a file.md", "b.pdf"]).lists.what, ["a file.md", "b.pdf"]);
  const start = all.find((c) => usageHint(c) === "opensourcebook start")!;
  assert.throws(() => parse(start, ["--background=yes"]), /is a switch/);
});

test("a command that needs a running Open Sourcebook says so plainly, with how to start it", async () => {
  const r = await runIn(["project", "list"], { home: join(empty, ".opensourcebook"), cwd: empty });
  assert.equal(r.code, 1);
  assert.match(r.err, /^Open Sourcebook is not running\. Start it first: open Open Sourcebook with its shortcut, or run "opensourcebook start --background"/);
  const j = await runIn(["project", "list", "--json"], { home: join(empty, ".opensourcebook"), cwd: empty });
  assert.deepEqual(Object.keys(j.json()), ["ok", "error"]);
  assert.equal((j.json().error as { code: string }).code, "not_running");
});

test("opensourcebook status when nothing runs: not running, exit 1, and JSON that says so", async () => {
  const r = await runIn(["status", "--json"], { home: join(empty, ".opensourcebook"), cwd: empty });
  assert.equal(r.code, 1);
  assert.deepEqual(r.json(), { ok: true, running: false, programs: [] });
});

test("a running.json left by an Open Sourcebook that is gone does not count as running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-stale-"));
  try {
    writeFileSync(join(dir, "running.json"), JSON.stringify({ pid: 2 ** 22 + 12345, url: "http://127.0.0.1:1", ports: { engine: 1 } }));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ OPENSOURCEBOOK_CLIENT_TOKEN: "x".repeat(20) }));
    const r = await runIn(["project", "list", "--json"], { home: dir, cwd: dir });
    assert.equal((r.json().error as { code: string }).code, "not_running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the paired devices are a group of the table: opensourcebook devices lists them (as npm run devices does), remove says plainly when there is none", async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-devices-"));
  try {
    const listed = await runIn(["devices", "--json"], { home, cwd: home });
    assert.deepEqual(listed.json(), { ok: true, devices: [] });
    const words = await runIn(["device", "list"], { home, cwd: home });
    assert.match(words.out, /No devices are paired/);
    const gone = await runIn(["devices", "remove", "nope", "--json"], { home, cwd: home });
    assert.equal((gone.json().error as { code: string }).code, "not_found");
    const help = await runIn(["device", "help"], { home, cwd: home });
    assert.match(help.out, /opensourcebook device remove <device>/);
    assert.ok(helpAll(GROUPS).includes("opensourcebook device pair"));
    const both = await runIn(["start", "--background", "--phone", "--no-phone", "--json"], { home, cwd: home });
    assert.equal((both.json().error as { code: string }).code, "bad_arguments");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
