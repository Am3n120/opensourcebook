import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appEnv, entryOf } from "../lib/app.mjs";
import { installFlags, main, route } from "../lib/main.mjs";
import { archiveOf, homeOf } from "../lib/paths.mjs";
import { cmdShimText, shimText } from "../lib/shims.mjs";
import { desktopEntry, makeShortcut } from "../lib/shortcuts.mjs";
import { ensureTools, onPath } from "../lib/tools.mjs";
import { appFiles, makeArchive, quietDeps, scratch } from "./helpers.mjs";

const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PACKAGE, "bin", "opensourcebook.mjs");
const calls = (home) => readFileSync(join(home, "app", "calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("only install, update, where and no words at all are handled here; the rest goes to the app untouched", () => {
  assert.deepEqual(route([], false), { kind: "install", flags: {} });
  assert.deepEqual(route([], true), { kind: "launch" });
  assert.deepEqual(route(["install", "--no-open", "--ports-from", "9300"], true), { kind: "install", flags: { noOpen: true, portsFrom: 9300 } });
  assert.deepEqual(route(["update"], true), { kind: "update" });
  assert.deepEqual(route(["where"], false), { kind: "where" });
  for (const line of [["stop"], ["status", "--json"], ["check"], ["open"], ["help"], ["--help"], ["make", "video", "--project", "x"], ["start", "--background"]]) assert.deepEqual(route(line, true), { kind: "app", args: line });
  assert.deepEqual(installFlags(["--no-start", "--ports-from=9400"]), { noStart: true, portsFrom: 9400 });
  assert.throws(() => installFlags(["--ports-from", "80"]), /between 1024 and 65000/);
  assert.throws(() => installFlags(["--fast"]), /not something/);
});

test("the app's entry is the first bin its package.json names", () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { first: "cli/one.mjs", second: "cli/two.mjs" } }));
  assert.equal(entryOf(dir), join(dir, "cli/one.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: "start.mjs" }));
  assert.equal(entryOf(dir), join(dir, "start.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no bin" }));
  assert.throws(() => entryOf(dir), /not complete/);
});

test("the app runs with this Node's folder and the home's bin first on the PATH", () => {
  const env = appEnv("/h/.opensourcebook", { PATH: ["/usr/bin", "/h/.opensourcebook/bin"].join(delimiter) }, "/opt/node/bin/node");
  assert.equal(env.PATH, ["/opt/node/bin", join("/h/.opensourcebook", "bin"), "/usr/bin"].join(delimiter));
});

test("the shim uses the home's own Node when it is there, else the one on the PATH, and runs the launcher copy", () => {
  const text = shimText("/Users/it's me/.opensourcebook");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.match(text, /OPENSOURCEBOOK_HOME='\/Users\/it'\\''s me\/\.opensourcebook'/);
  assert.match(text, /if \[ -x "\$OPENSOURCEBOOK_HOME\/node\/bin\/node" \]; then\n  exec "\$OPENSOURCEBOOK_HOME\/node\/bin\/node" "\$OPENSOURCEBOOK_HOME\/launcher\/bin\/opensourcebook\.mjs" "\$@"/);
  assert.match(text, /\nexec node "\$OPENSOURCEBOOK_HOME\/launcher\/bin\/opensourcebook\.mjs" "\$@"\n$/);
  const cmd = cmdShimText("C:\\Users\\me\\.opensourcebook");
  assert.match(cmd, /set "OPENSOURCEBOOK_HOME=C:\\Users\\me\\\.opensourcebook"/);
  assert.match(cmd, /"%OPENSOURCEBOOK_HOME%\\node\\node\.exe" "%OPENSOURCEBOOK_HOME%\\launcher\\bin\\opensourcebook\.mjs" %\*/);
  assert.match(cmd, /\r\n  node "%OPENSOURCEBOOK_HOME%\\launcher\\bin\\opensourcebook\.mjs" %\*/);
});

test("an old Node gets one plain sentence and no stack", () => {
  const r = spawnSync(process.execPath, [BIN, "install"], { encoding: "utf8", env: { ...process.env, OPENSOURCEBOOK_PRETEND_NODE: "18.20.4", OPENSOURCEBOOK_HOME: join(scratch(), "home") } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "Open Sourcebook needs Node 24 and this computer has Node 18.20.4; the one-line installer at https://opensourcebook.app brings its own.");
  assert.equal(r.stdout, "");
});

test("the download address is the one in source.json unless OPENSOURCEBOOK_ARCHIVE says otherwise", () => {
  assert.equal(archiveOf({}), "https://github.com/Mikiyas-Meles-Assefa/opensourcebook/archive/refs/heads/main.tar.gz");
  assert.equal(archiveOf({ OPENSOURCEBOOK_ARCHIVE: "/tmp/app.tar.gz" }), "/tmp/app.tar.gz");
  assert.equal(archiveOf({ OPENSOURCEBOOK_ARCHIVE: "  " }), "https://github.com/Mikiyas-Meles-Assefa/opensourcebook/archive/refs/heads/main.tar.gz");
  assert.equal(homeOf({}, "/home/me"), join("/home/me", ".opensourcebook"));
  assert.equal(homeOf({ OPENSOURCEBOOK_HOME: "/elsewhere/folder" }, "/home/me"), "/elsewhere/folder");
});

test("where says the folder and the address through the real command", () => {
  const home = join(scratch(), "home");
  const r = spawnSync(process.execPath, [BIN, "where"], { encoding: "utf8", env: { ...process.env, OPENSOURCEBOOK_HOME: home, OPENSOURCEBOOK_ARCHIVE: "/tmp/some.tar.gz" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `Open Sourcebook lives in ${home}.\nIt is downloaded from /tmp/some.tar.gz.\n`);
  assert.ok(!existsSync(home), "asking where writes nothing");
});

test("install puts everything in the home, starts the app on the asked ports, and a second install stops it first and keeps the data", async () => {
  const dir = scratch();
  const home = join(dir, "home", ".opensourcebook");
  const archive = makeArchive(dir, "one", appFiles({ "old.txt": "old" }));
  const deps = quietDeps(home, archive);
  assert.equal(await main(["install", "--no-open", "--ports-from", "9300"], deps), 0, deps.warned.join("\n"));
  assert.match(deps.said[0], /will be downloaded from .*one\.tar\.gz into .*\.opensourcebook\.$/);
  assert.match(deps.said[1], /^Nothing outside that folder is changed/);
  for (const rel of ["app/package.json", "app.manifest", "launcher/bin/opensourcebook.mjs", "launcher/lib/main.mjs", "launcher/source.json", "bin/opensourcebook"]) assert.ok(existsSync(join(home, rel)), rel);
  assert.ok(statSync(join(home, "bin", "opensourcebook")).mode & 0o100);
  assert.ok(!existsSync(join(home, "bin", "opensourcebook.cmd")));
  assert.deepEqual(calls(home).map((c) => c.args), [["start", "--background", "--ports-from", "9300"]]);
  assert.ok(calls(home)[0].path.startsWith([dirname(process.execPath), join(home, "bin")].join(delimiter)));

  // The shim really runs the launcher copy, and what it does not know goes to the app with its exit code.
  const through = spawnSync(join(home, "bin", "opensourcebook"), ["fail", "--loud"], { encoding: "utf8", env: { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.equal(through.status, 7, through.stderr);
  assert.deepEqual(calls(home).at(-1).args, ["fail", "--loud"]);

  writeFileSync(join(home, "app", ".opensourcebook", "project"), "mine");
  const again = quietDeps(home, makeArchive(dir, "two", appFiles({ "new.txt": "new" })));
  assert.equal(await main(["install", "--no-open", "--ports-from", "9300"], again), 0, again.warned.join("\n"));
  assert.match(again.said[0], /will be updated in/);
  assert.ok(again.said.includes("Stopped the running Open Sourcebook to update it."));
  assert.deepEqual(calls(home).slice(-2).map((c) => c.args), [["stop", "--json"], ["start", "--background", "--ports-from", "9300"]]);
  assert.equal(readFileSync(join(home, "app", ".opensourcebook", "project"), "utf8"), "mine");
  assert.ok(!existsSync(join(home, "app", "old.txt")));
  assert.ok(existsSync(join(home, "app", "new.txt")));

  // No words: it is running, so it is only opened. After a stop, it is started on the remembered ports and opened.
  assert.equal(await main([], quietDeps(home, archive)), 0);
  assert.deepEqual(calls(home).slice(-2).map((c) => c.args), [["status", "--json"], ["open"]]);
  assert.equal(await main(["stop"], quietDeps(home, archive)), 0);
  assert.equal(await main([], quietDeps(home, archive)), 0);
  assert.deepEqual(calls(home).slice(-3).map((c) => c.args), [["status", "--json"], ["start", "--background", "--ports-from", "9300"], ["open"]]);
});

test("update starts the app again only when it was running, and install --no-start leaves it stopped", async () => {
  const dir = scratch();
  const home = join(dir, ".opensourcebook");
  const archive = makeArchive(dir, "one", appFiles());
  assert.equal(await main(["update"], quietDeps(home, archive)), 1, "nothing to update yet");
  const first = quietDeps(home, archive);
  assert.equal(await main(["install", "--no-start"], first), 0);
  assert.ok(!existsSync(join(home, "app", "calls.log")), "the app was not run");
  assert.match(first.said.at(-1), /installed and not started/);
  mkdirSync(join(home, "app", ".opensourcebook"), { recursive: true });

  assert.equal(await main(["update"], quietDeps(home, archive)), 0);
  assert.deepEqual(calls(home).map((c) => c.args), [["stop", "--json"]]);
  writeFileSync(join(home, "app", ".opensourcebook", "running"), "yes");
  assert.equal(await main(["update"], quietDeps(home, archive)), 0);
  assert.deepEqual(calls(home).slice(-2).map((c) => c.args), [["stop", "--json"], ["start", "--background"]]);
});

test("a failure is one sentence with one next step and exit code 1", async () => {
  const dir = scratch();
  const home = join(dir, ".opensourcebook");
  const none = quietDeps(home, join(dir, "missing.tar.gz"));
  assert.equal(await main(["install"], none), 1);
  assert.deepEqual(none.warned, [`There is no file at ${join(dir, "missing.tar.gz")}. Check the address in OPENSOURCEBOOK_ARCHIVE and run the same command again.`]);
  const early = quietDeps(home, join(dir, "missing.tar.gz"));
  assert.equal(await main(["status"], early), 1);
  assert.deepEqual(early.warned, ['Open Sourcebook is not installed yet. Run "opensourcebook install" first.']);
});

test("ffmpeg and ffprobe are fetched with this Node's npm only when the computer has neither, and a failure is only a warning", async () => {
  const dir = scratch();
  const home = join(dir, ".opensourcebook");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "ffmpeg"), "");
  writeFileSync(join(elsewhere, "ffprobe"), "");
  assert.equal(onPath("ffmpeg", { PATH: `/nowhere${delimiter}${elsewhere}` }, "linux"), join(elsewhere, "ffmpeg"));
  const never = async () => assert.fail("npm must not run");
  assert.deepEqual(await ensureTools({ home, run: never, env: { PATH: elsewhere } }), { fetched: [] });

  const ran = [];
  const npm = async (command, args) => {
    ran.push([command, ...args]);
    const tools = args[args.indexOf("--prefix") + 1];
    mkdirSync(join(tools, "node_modules", "ffmpeg-static"), { recursive: true });
    writeFileSync(join(tools, "node_modules", "ffmpeg-static", "ffmpeg"), "#!/bin/sh\n");
    mkdirSync(join(tools, "node_modules", "@ffprobe-installer", "linux-x64"), { recursive: true });
    writeFileSync(join(tools, "node_modules", "@ffprobe-installer", "linux-x64", "ffprobe"), "#!/bin/sh\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const got = await ensureTools({ home, run: npm, env: { PATH: "/nowhere" }, platform: "linux", arch: "x64" });
  assert.deepEqual(got, { fetched: ["ffmpeg", "ffprobe"] });
  assert.deepEqual(ran[0].slice(-2), ["ffmpeg-static", "@ffprobe-installer/ffprobe"]);
  assert.ok(ran[0].includes(join(home, "tools")));
  assert.ok(lstatSync(join(home, "bin", "ffmpeg")).isSymbolicLink());
  assert.ok(statSync(join(home, "bin", "ffprobe")).isFile());
  assert.deepEqual(await ensureTools({ home, run: never, env: { PATH: "/nowhere" }, platform: "linux", arch: "x64" }), { fetched: [] }, "what is in the home's bin is not fetched again");

  const failed = await ensureTools({ home: join(dir, "other"), run: async () => ({ code: 1, stdout: "", stderr: "no network" }), env: { PATH: "/nowhere" }, platform: "darwin" });
  assert.deepEqual(failed.fetched, []);
  assert.match(failed.warning, /^ffmpeg and ffprobe could not be fetched, so videos and audio cannot be made yet: .*then run "opensourcebook install" again\.$/);
});

test("the shortcut is a Mac app or a Linux menu entry in the person's home, and none when asked not to", () => {
  const userHome = scratch();
  const home = join(userHome, ".opensourcebook");
  const app = makeShortcut({ home, env: {}, platform: "darwin", userHome, execPath: "/opt/node/bin/node" });
  assert.equal(app, join(userHome, "Applications", "Open Sourcebook.app"));
  assert.match(readFileSync(join(app, "Contents", "Info.plist"), "utf8"), /<key>CFBundleExecutable<\/key><string>opensourcebook<\/string>/);
  const script = join(app, "Contents", "MacOS", "opensourcebook");
  assert.ok(statSync(script).mode & 0o100);
  assert.ok(readFileSync(script, "utf8").includes(`'${join(home, "bin", "opensourcebook")}' && exit 0`));
  const entry = makeShortcut({ home, env: {}, platform: "linux", userHome });
  assert.equal(entry, join(userHome, ".local", "share", "applications", "opensourcebook.desktop"));
  assert.match(desktopEntry(home), /\nName=Open Sourcebook\n/);
  assert.ok(desktopEntry(home).includes(`Exec="${join(home, "bin", "opensourcebook")}"`));
  assert.equal(makeShortcut({ home, env: {}, platform: "win32", userHome }), undefined);
  assert.equal(makeShortcut({ home, env: { OPENSOURCEBOOK_NO_SHORTCUT: "1" }, platform: "darwin", userHome: join(userHome, "none") }), undefined);
  assert.ok(!existsSync(join(userHome, "none")));
});
