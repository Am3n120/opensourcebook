/**
 * `opensourcebook update` and the line at start, against git repositories built here: a bare "remote" and a clone of it, never
 * the real remote. Every refusal changes nothing; the happy path moves forward, installs only what changed and leaves
 * the person's own files alone.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runCommand, type Io } from "../commands/index.ts";
import type { Ctx } from "../commands/table.ts";
import { PROGRAMS } from "../programs.ts";
import { restartFlags, runUpdate, type UpdateHooks } from "../commands/update.ts";
import { processStart, writeRunning } from "../record.ts";
import { NEWER_LINE, checkForNewer, ifKnown, logSize, newerFrom, newerSaidSince, parseChanges, safeUrl } from "../update.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-update-")));
after(() => rmSync(base, { recursive: true, force: true }));

// The person's own git settings stay out of it: no hooks, no signing, a fixed name.
const emptyConfig = join(base, "gitconfig");
writeFileSync(emptyConfig, "");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

let n = 0;
/** A seed repository (where "the project" commits), its bare remote, and a person's clone with files of their own. */
function setUp(options: { shallow?: boolean } = {}): { seed: string; remote: string; copy: string } {
  const dir = join(base, `case-${++n}`);
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  write(seed, ".gitignore", ".opensourcebook/\n.env\nengine/.wrangler/\n");
  write(seed, "package.json", '{"name":"opensourcebook"}\n');
  write(seed, "engine/package.json", '{"name":"engine"}\n');
  write(seed, "engine/package-lock.json", '{"lockfileVersion":3,"v":1}\n');
  write(seed, "web/package.json", '{"name":"web"}\n');
  write(seed, "web/package-lock.json", '{"lockfileVersion":3}\n');
  write(seed, "engine/migrations/0001_first.sql", "create table a (x);\n");
  write(seed, "CHANGES.md", "# What is new in Open Sourcebook\n\n## 2026-11-01\n\n- The first thing.\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  // Older history, with a tag on it that is not a version: a shallow clone must neither fetch it nor stop at it.
  git(seed, "tag", "-a", "origin-old", "-m", "an old marker");
  write(seed, "docs.md", "more\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "more");
  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", seed, remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "fetch", "-q", "origin");
  const copy = join(dir, "copy");
  // The clone in docs/DEVELOPING.md is a shallow clone; file:// so git really makes it shallow for a folder on this computer.
  if (options.shallow) git(dir, "clone", "-q", "--depth", "1", `file://${remote}`, copy);
  else git(dir, "clone", "-q", remote, copy);
  // What a person has that git does not keep.
  write(copy, ".opensourcebook/secrets.json", '{"ENGINE_TOKEN":"keep me"}\n');
  write(copy, ".env", "MINE=1\n");
  write(copy, "engine/.wrangler/state/v3/d1/db.sqlite", "my projects\n");
  write(copy, "notes.txt", "my notes\n");
  return { seed, remote, copy };
}

/** A new version on the remote: the engine's packages change, a migration and a line in CHANGES.md are added. */
function publish(seed: string, change = "Videos can be made faster.", push = ["push", "-q", "origin", "main"]): string {
  write(seed, "engine/package-lock.json", `{"lockfileVersion":3,"v":${++n}}\n`);
  write(seed, `engine/migrations/000${n}_more.sql`, "create table b (y);\n");
  // As CONTRIBUTING.md says: the newest at the top.
  write(seed, "CHANGES.md", read(seed, "CHANGES.md").replace("# What is new in Open Sourcebook\n", `# What is new in Open Sourcebook\n\n## 2026-11-19\n\n- ${change}\n`));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "second");
  git(seed, ...push);
  return git(seed, "rev-parse", "HEAD");
}

function ctxFor(root: string, flags: Ctx["flags"] = {}): Ctx & { said: string[] } {
  const said: string[] = [];
  return { args: {}, lists: {}, flags, json: false, progress: (l) => said.push(l), env: process.env, cwd: root, root, home: join(root, ".opensourcebook"), pollMs: 10, said };
}

function hooks(): UpdateHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    install: async (_ctx, dirs) => (calls.push(`install ${dirs.join(",")}`), []),
    stop: async (ctx) => void calls.push(`stop at ${git(ctx.root, "rev-parse", "HEAD")}`),
    start: async (_ctx, flags) => (calls.push(`start ${flags.join(" ")}`), { ok: true, url: "http://127.0.0.1:9503" }),
  };
}

function personFilesUntouched(copy: string): void {
  assert.equal(read(copy, ".opensourcebook/secrets.json"), '{"ENGINE_TOKEN":"keep me"}\n');
  assert.equal(read(copy, ".env"), "MINE=1\n");
  assert.equal(read(copy, "engine/.wrangler/state/v3/d1/db.sqlite"), "my projects\n");
  assert.equal(read(copy, "notes.txt"), "my notes\n");
}

async function refused(copy: string, code: string, flags: Ctx["flags"] = {}): Promise<string> {
  const head = git(copy, "rev-parse", "HEAD");
  const h = hooks();
  let message = "";
  await assert.rejects(runUpdate(ctxFor(copy, flags), h), (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    message = error.message;
    return true;
  });
  assert.equal(git(copy, "rev-parse", "HEAD"), head, "nothing moved");
  assert.deepEqual(h.calls, [], "nothing installed, stopped or started");
  personFilesUntouched(copy);
  return message;
}

test("update moves forward, installs again only the package whose lockfile changed, says what is new and leaves the person's files alone", async () => {
  const { seed, copy } = setUp();
  const before = git(copy, "rev-parse", "HEAD");
  const tip = publish(seed);
  const h = hooks();
  const answer = await runUpdate(ctxFor(copy), h);
  assert.equal(git(copy, "rev-parse", "HEAD"), tip);
  assert.deepEqual(h.calls, ["install engine"], "the web app's lockfile did not change, so it is not installed again");
  assert.equal(answer.exit, 0);
  assert.equal(answer.data.updated, true);
  assert.deepEqual(answer.data.installs, ["engine"]);
  assert.equal((answer.data.migrations as string[]).length, 1);
  assert.match(answer.text, new RegExp(`${before.slice(0, 7)} of \\d{4}-\\d\\d-\\d\\d -> ${tip.slice(0, 7)}`));
  assert.match(answer.text, /What is new:\n {2}- Videos can be made faster\./);
  assert.doesNotMatch(answer.text, /The first thing/, "only what is new since this copy");
  assert.match(answer.text, /1 new step by itself the next time Open Sourcebook starts/);
  assert.match(answer.text, /stay as they are/);
  assert.match(answer.text, /npm start/);
  personFilesUntouched(copy);
  assert.equal(git(copy, "status", "--porcelain", "--untracked-files=no"), "");

  const again = await runUpdate(ctxFor(copy), hooks());
  assert.equal(again.data.updated, false);
  assert.match(again.text, /^Open Sourcebook is up to date \(version [0-9a-f]{7} of /);
});

test("a running Open Sourcebook is stopped before the files change and started again on the ports it had", async () => {
  const { seed, copy } = setUp();
  const before = git(copy, "rev-parse", "HEAD");
  const tip = publish(seed);
  // This test's own process stands for the launcher: it is alive and its start time matches.
  writeRunning(join(copy, ".opensourcebook"), { pid: process.pid, startedAt: processStart(process.pid), url: "http://127.0.0.1:9503", ports: { [PROGRAMS[0]!.id]: 9500, web: 9503 }, ready: true, children: [] });
  const h = hooks();
  const answer = await runUpdate(ctxFor(copy), h);
  assert.deepEqual(h.calls, [`stop at ${before}`, "install engine", "start --no-open --ports-from 9500"]);
  assert.equal(git(copy, "rev-parse", "HEAD"), tip);
  assert.equal(answer.data.restarted, true);
  assert.match(answer.text, /stopped and started again with the new version.*http:\/\/127\.0\.0\.1:9503/);
});

test("restartFlags keeps the usual ports when Open Sourcebook was on them", () => {
  assert.deepEqual(restartFlags({ [PROGRAMS[0]!.id]: PROGRAMS[0]!.port }), ["--no-open"]);
  assert.deepEqual(restartFlags({ [PROGRAMS[0]!.id]: 9500 }), ["--no-open", "--ports-from", "9500"]);
});

test("--check says what a newer version brings and changes nothing", async () => {
  const { seed, copy } = setUp();
  const head = git(copy, "rev-parse", "HEAD");
  publish(seed);
  const h = hooks();
  const answer = await runUpdate(ctxFor(copy, { check: true }), h);
  assert.equal(answer.data.available, true);
  assert.match(answer.text, /A newer version is out/);
  assert.match(answer.text, /Engine/);
  assert.equal(git(copy, "rev-parse", "HEAD"), head);
  assert.deepEqual(h.calls, []);
});

test("not a git checkout: nothing changes, and it says how to get updates", async () => {
  const plain = join(base, "downloaded");
  mkdirSync(join(plain, "engine"), { recursive: true });
  await assert.rejects(runUpdate(ctxFor(plain), hooks()), (e: Error & { code?: string }) => e.code === "not_a_checkout" && /clone Open Sourcebook with git/.test(e.message));
  // Through the command table too, as JSON.
  const out: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: () => undefined, env: process.env, cwd: plain, root: plain, home: join(plain, ".opensourcebook"), pollMs: 10 };
  assert.equal(await runCommand(["update", "--json"], io), 1);
  assert.equal(JSON.parse(out[0]!).error.code, "not_a_checkout");
});

test("changes of the person's own to tracked files: nothing changes, and they are named", async () => {
  const { seed, copy } = setUp();
  publish(seed);
  write(copy, "web/package.json", '{"name":"web","mine":true}\n');
  const message = await refused(copy, "local_changes");
  assert.match(message, /web\/package\.json/);
  assert.match(message, /git switch -c my-changes/);
  assert.equal(read(copy, "web/package.json"), '{"name":"web","mine":true}\n');
});

test("on another branch, or on no branch: nothing changes, and it says how to go back", async () => {
  const { seed, copy } = setUp();
  publish(seed);
  git(copy, "switch", "-q", "-c", "mine");
  assert.match(await refused(copy, "not_default_branch"), /on the branch "mine", not on "main".*git switch main/);
  git(copy, "switch", "-q", "--detach", "main");
  assert.match(await refused(copy, "not_default_branch"), /not on any branch/);
});

test("commits of the person's own on main: no fast-forward, so nothing changes", async () => {
  const { seed, copy } = setUp();
  publish(seed);
  write(copy, "web/package.json", '{"name":"web","mine":true}\n');
  git(copy, "commit", "-q", "-am", "mine");
  assert.match(await refused(copy, "own_commits"), /git branch my-work/);
});

test("a new version that brings a file where the person has an ignored one of their own is refused, so it is not overwritten", async () => {
  const { seed, copy } = setUp();
  write(seed, ".env", "FROM_THE_PROJECT=1\n");
  git(seed, "add", "-f", ".env");
  git(seed, "commit", "-q", "-m", "brings .env");
  git(seed, "push", "-q", "origin", "main");
  assert.match(await refused(copy, "file_in_the_way"), /\.env/);
});

test("the remote cannot be reached: nothing changes, and no address with a password is printed", async () => {
  const { copy } = setUp();
  git(copy, "remote", "set-url", "origin", join(base, "gone.git"));
  assert.match(await refused(copy, "fetch_failed"), /check the network/);
  assert.equal(safeUrl("https://someone:ghp_secret@github.com/a/b.git"), "https://github.com/a/b.git");
  assert.equal(safeUrl("git@github.com:a/b.git"), "git@github.com:a/b.git");
});

test("a shallow clone, as docs/DEVELOPING.md makes it, is updated and stays shallow; an old tag neither stops it nor is fetched", async () => {
  const { seed, copy } = setUp({ shallow: true });
  assert.equal(git(copy, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(copy, "rev-list", "--count", "HEAD"), "1");
  publish(seed, "One.");
  const tip = publish(seed, "Two.");
  git(seed, "push", "-q", "origin", "--tags");
  assert.equal(await checkForNewer(copy), NEWER_LINE);
  const answer = await runUpdate(ctxFor(copy), hooks());
  assert.equal(git(copy, "rev-parse", "HEAD"), tip);
  assert.match(answer.text, /2 changes/);
  assert.match(answer.text, /- Two\.\n {2}- One\./, "newest first");
  assert.equal(git(copy, "rev-parse", "--is-shallow-repository"), "true", "still shallow");
  assert.equal(git(copy, "rev-list", "--count", "HEAD"), "3", "only the new commits came down");
  assert.equal(git(copy, "tag"), "", "no tags fetched");
  personFilesUntouched(copy);
  assert.equal(await checkForNewer(copy), undefined, "up to date now");
  assert.equal((await runUpdate(ctxFor(copy), hooks())).data.updated, false);
});

test("a tag on an old commit does not make the newest version look older (the version is the newest commit)", async () => {
  const { seed, copy } = setUp();
  git(seed, "push", "-q", "origin", "--tags");
  const tip = publish(seed);
  assert.equal(await checkForNewer(copy), NEWER_LINE);
  await runUpdate(ctxFor(copy), hooks());
  assert.equal(git(copy, "rev-parse", "HEAD"), tip);
});

test("a file of the person's own that git does not know, where the new version brings one: refused, theirs kept", async () => {
  const { seed, copy } = setUp();
  write(seed, "web/new-file.ts", "from the project\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "brings a file");
  git(seed, "push", "-q", "origin", "main");
  write(copy, "web/new-file.ts", "mine\n");
  assert.match(await refused(copy, "file_in_the_way"), /web\/new-file\.ts/);
  assert.equal(read(copy, "web/new-file.ts"), "mine\n");
});

test("the published branch was rewritten so the two have gone separate ways: nothing changes", async () => {
  const { seed, copy } = setUp();
  git(seed, "reset", "-q", "--hard", "HEAD~1");
  publish(seed, "Rewritten.", ["push", "-q", "--force", "origin", "main"]);
  assert.match(await refused(copy, "own_commits"), /gone separate ways/);
});

test("the line at start: said when a newer version is out, silent when up to date, offline, slow or turned off", async () => {
  const { seed, copy } = setUp();
  assert.equal(await checkForNewer(copy), undefined, "up to date");
  publish(seed);
  assert.match((await checkForNewer(copy)) ?? "", /A newer version of Open Sourcebook is out: "npm run update"/);
  write(copy, "web/package.json", '{"name":"web","mine":true}\n');
  assert.equal(await checkForNewer(copy), NEWER_LINE, "changes of the person's own do not hide it");
  git(copy, "checkout", "-q", "--", "web/package.json");
  git(copy, "switch", "-q", "-c", "mine");
  assert.equal(await checkForNewer(copy), undefined, "on a branch of their own: nothing said");
  git(copy, "switch", "-q", "main");
  assert.equal(await checkForNewer(copy, { env: { OPENSOURCEBOOK_UPDATE_CHECK: "0" } }), undefined);
  assert.equal(await checkForNewer(join(base, "downloaded")), undefined, "not a git checkout");

  git(copy, "remote", "set-url", "origin", join(base, "gone.git"));
  assert.equal(await checkForNewer(copy), undefined, "offline");

  // A remote that accepts and never answers: the short timeout ends it, with nothing said.
  const server: Server = createServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  git(copy, "remote", "set-url", "origin", `git://127.0.0.1:${port}/opensourcebook.git`);
  const began = Date.now();
  assert.equal(await checkForNewer(copy, { timeoutMs: 300 }), undefined);
  assert.ok(Date.now() - began < 3_000, "it does not hold the start");
  server.close();
});

test("the small pieces: CHANGES.md, what ls-remote says, and an answer that is not in yet", async () => {
  assert.deepEqual(parseChanges("# t\n\nintro\n\n## 2026-11-19\n\n- One\n  continued.\n- Two\n\n## 2026-11-01\n\n* Three\n"), [
    { date: "2026-11-19", text: "One continued." },
    { date: "2026-11-19", text: "Two" },
    { date: "2026-11-01", text: "Three" },
  ]);
  const listed = "aaa\trefs/heads/main\nttt\trefs/heads/other\n";
  assert.equal(newerFrom(listed, "main", () => false), "aaa");
  assert.equal(newerFrom(listed, "main", (c) => c === "aaa"), undefined);
  assert.equal(newerFrom("", "main", () => false), undefined);
  assert.equal(await ifKnown(Promise.resolve("known")), "known");
  assert.equal(await ifKnown(new Promise<string>(() => undefined)), undefined, "the start does not wait for it");

  // A start in the background hands on the line only when this start wrote it, not an earlier one.
  const log = join(base, "launcher.log");
  assert.equal(logSize(log), 0);
  writeFileSync(log, `--- earlier\n${NEWER_LINE}\n`);
  const from = logSize(log);
  assert.equal(newerSaidSince(log, from), undefined);
  writeFileSync(log, `--- now\nChecking this computer\n${NEWER_LINE}\n`, { flag: "a" });
  assert.equal(newerSaidSince(log, from), NEWER_LINE.trim());
});
