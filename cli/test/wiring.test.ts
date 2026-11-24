import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cachedChrome, findChrome, percentIn } from "../chrome.ts";
import { databaseFile, databaseFiles, databaseName, engineConfig, migrateArgs, migrationFiles, needsMigrations } from "../database.ts";
import { formatEnv, namesIn, parseEnv } from "../envfile.ts";
import { parseArgs } from "../main.ts";
import { engineSettings, PROGRAMS, startOrder, type Wiring } from "../programs.ts";
import { SECRET_NAMES, type Secrets } from "../secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-wiring-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, `${n.toLowerCase()}-0123456789`])) as Secrets;
const ports = { engine: 9003, web: 9004, connector: 9000, scenes: 9002, "engine-inspector": 9005 };

test("every program gets the secrets it shares, under the names it already reads", () => {
  const w: Wiring = { root: dir, home: join(dir, ".opensourcebook"), ports, secrets, env: {} };
  const env = (id: string) => PROGRAMS.find((p) => p.id === id)!.start(w).env;
  assert.equal(env("connector").OPENSOURCEBOOK_CONNECTOR_TOKEN, secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN);
  assert.equal(env("connector").OPENSOURCEBOOK_USAGE_LOG, join(dir, ".opensourcebook", "logs", "usage.jsonl"));
  assert.equal(env("scenes").SCENES_TOKEN, secrets.SCENES_TOKEN);
  // The scenes service holds its own narrower token, never the connector's full one.
  assert.equal(env("scenes").SCENES_CONNECTOR_TOKEN, secrets.SCENES_CONNECTOR_TOKEN);
  assert.notEqual(env("scenes").SCENES_CONNECTOR_TOKEN, secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN);
  assert.equal(env("connector").OPENSOURCEBOOK_CONNECTOR_SCENES_TOKEN, secrets.SCENES_CONNECTOR_TOKEN);
  assert.equal(env("connector").OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS, join(dir, "services", "scenes", ".data"));
  assert.ok(!Object.values(env("scenes")).includes(secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN));
  assert.equal(env("scenes").SCENES_CONNECTOR_URL, "http://127.0.0.1:9000");
  assert.equal(env("web").OPENSOURCEBOOK_CLIENT_TOKEN, secrets.OPENSOURCEBOOK_CLIENT_TOKEN);
  assert.equal(env("web").ENGINE_URL, "http://127.0.0.1:9003");
  for (const p of PROGRAMS) {
    const given = Object.values(p.start(w).env).join("\n");
    const theirs = new Set(Object.values(env(p.id)));
    for (const name of SECRET_NAMES) if (!theirs.has(secrets[name])) assert.ok(!given.includes(secrets[name]), `${p.id} gets no secret it does not use`);
  }
});

test("the engine's settings: the person's own keys kept, the wiring always the launcher's, no stand-in mode added", () => {
  const root = join(dir, "repo");
  mkdirSync(join(root, "engine"), { recursive: true });
  // The person's own file and shell still use names from before the rename; the example file may list either.
  writeFileSync(join(root, "engine", ".dev.vars"), "GEMINI_API_KEY=mine\nCHAT_AGENT_URL=http://127.0.0.1:1\nRE_CLIENT_TOKEN=old\nRE_OWN_SETTING=kept\n");
  writeFileSync(join(root, "engine", ".dev.vars.example"), "OPENSOURCEBOOK_CLIENT_TOKEN=\nDEEPSEEK_API_KEY=\n# GENERATION_PROVIDER=offline\n# OPENSOURCEBOOK_NEW_LISTED=\n# RE_OLD_LISTED=\n");
  const w: Wiring = { root, home: join(root, ".opensourcebook"), ports, secrets, env: { DEEPSEEK_API_KEY: "from-shell", HOME: "/home/x", PATH: "/bin", RE_NEW_LISTED: "one", RE_OLD_LISTED: "two" } };
  const s = engineSettings(w);
  assert.deepEqual(Object.keys(s).filter((name) => name.startsWith("RE_")), [], "what the launcher writes has new names only");
  assert.equal(s.OPENSOURCEBOOK_OWN_SETTING, "kept", "an old name in the person's own file is passed on under its new name");
  assert.equal(s.OPENSOURCEBOOK_NEW_LISTED, "one", "a setting the engine lists under its new name is read from the shell under its old one");
  assert.equal(s.OPENSOURCEBOOK_OLD_LISTED, "two", "and one an older example file lists under its old name too");
  assert.equal(s.GEMINI_API_KEY, "mine");
  assert.equal(s.DEEPSEEK_API_KEY, "from-shell");
  assert.equal(s.HOME, undefined, "only settings the engine knows come from the shell");
  assert.equal(s.OPENSOURCEBOOK_CLIENT_TOKEN, secrets.OPENSOURCEBOOK_CLIENT_TOKEN);
  assert.equal(s.CHAT_AGENT_URL, "http://127.0.0.1:9000");
  assert.equal(s.CHAT_AGENT_TOKEN, secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN);
  assert.equal(s.SCENES_SERVICE_URL, "http://127.0.0.1:9002");
  assert.equal(s.SCENES_SERVICE_TOKEN, secrets.SCENES_TOKEN);
  for (const name of ["RENDER_SERVICE_URL", "RENDER_SERVICE_TOKEN"]) assert.equal(s[name], undefined, `${name} is never set by the launcher`);
  for (const name of ["RE_ENGINE_MODE", "OPENSOURCEBOOK_ENGINE_MODE", "GENERATION_PROVIDER", "VIDEO_PROVIDERS"]) assert.equal(s[name], undefined, `${name} is never set by the launcher`);
});

test("the engine starts on the local database with the wiring file, never remote", () => {
  const w: Wiring = { root: dir, home: join(dir, ".opensourcebook"), ports, secrets, env: {} };
  const args = PROGRAMS.find((p) => p.id === "engine")!.start(w).args;
  // Not `wrangler dev`, which always opens a debugger port: engine/scripts/dev.ts keeps it shut unless the person
  // developing Open Sourcebook sets OPENSOURCEBOOK_ENGINE_INSPECTOR=1, which the launcher never sets for them.
  assert.equal(args[0], join("scripts", "dev.ts"));
  assert.ok(!args.includes("dev"));
  assert.ok(!Object.keys(PROGRAMS.find((p) => p.id === "engine")!.start(w).env).includes("OPENSOURCEBOOK_ENGINE_INSPECTOR"));
  assert.equal(args[args.indexOf("--config") + 1], "wrangler.toml");
  assert.equal(args[args.indexOf("--port") + 1], "9003");
  assert.equal(args[args.indexOf("--env-file") + 1], join(dir, ".opensourcebook", "engine.env"));
  assert.ok(!args.some((a) => a.includes("remote")));
  assert.ok(readdirSync(join(dir, ".opensourcebook")).includes("engine.env"));
});

test("start order puts each program after the ones it waits for", () => {
  const order = startOrder().map((p) => p.id);
  assert.ok(order.indexOf("connector") < order.indexOf("scenes"));
  assert.ok(order.indexOf("engine") < order.indexOf("web"));
  assert.equal(order.length, PROGRAMS.length);
});

test("env files: read, written and read back the same", () => {
  const values = { A: "plain", B: "has space", C: "it's", D: "two\nlines", E: "" };
  assert.deepEqual(parseEnv(formatEnv(values, "made here")), values);
  assert.deepEqual(parseEnv("# c\nexport X=1 # note\nY='q # not a note'\n\nbad line\n"), { X: "1", Y: "q # not a note" });
  assert.deepEqual(namesIn("A=\n# B=x\n#   C=\nnot=this\n# words here\n"), ["A", "B", "C"]);
});

test("database: migrations apply locally on first start and when a new file appears", () => {
  const engine = join(dir, "engine-db");
  mkdirSync(join(engine, "migrations"), { recursive: true });
  writeFileSync(join(engine, "wrangler.toml"), 'name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-db"\ndatabase_id = "id-1"\n');
  writeFileSync(join(engine, "migrations", "0002_b.sql"), "");
  writeFileSync(join(engine, "migrations", "0001_a.sql"), "");
  assert.deepEqual(migrationFiles(engine), ["0001_a.sql", "0002_b.sql"]);
  assert.equal(databaseName(engine), "my-db");
  const applied = { "id-1": ["0001_a.sql", "0002_b.sql"] };
  assert.equal(needsMigrations(engine, applied), true, "no local database yet");
  mkdirSync(databaseFiles(engine), { recursive: true });
  writeFileSync(databaseFile(engine, "id-1"), "");
  assert.equal(needsMigrations(engine, applied), false);
  writeFileSync(join(engine, "migrations", "0003_c.sql"), "");
  assert.equal(needsMigrations(engine, applied), true);
  rmSync(join(engine, "migrations", "0003_c.sql"));
  const args = migrateArgs(engine);
  assert.deepEqual(args.slice(1), ["d1", "migrations", "apply", "my-db", "--local", "--config", "wrangler.toml"]);
  assert.ok(!args.includes("--remote"));
  // A git-ignored wrangler.local.toml (a person's own Cloudflare names and ids) is used when it is there.
  writeFileSync(join(engine, "wrangler.local.toml"), 'name = "mine"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-own-db"\n');
  assert.equal(engineConfig(engine), "wrangler.local.toml");
  assert.deepEqual(migrateArgs(engine).slice(1), ["d1", "migrations", "apply", "my-own-db", "--local", "--config", "wrangler.local.toml"]);
});

test("Chrome: found where the scenes service looks, and the download's progress is read", () => {
  const home = join(dir, "home");
  const root = join(dir, "root");
  assert.equal(findChrome(root, {}, "darwin", home), null);
  assert.equal(cachedChrome(home), join(home, "Library", "Caches", "opensourcebook-scenes", "chrome-headless-shell"), "with no copy yet, the new folder is where one goes");
  // A copy downloaded before the rename is used where it is: never moved, never downloaded again.
  const old = join(home, "Library", "Caches", "re-scenes", "chrome-headless-shell", "mac-arm64");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "chrome-headless-shell"), "");
  assert.equal(findChrome(root, {}, "darwin", home), join(old, "chrome-headless-shell"));
  assert.ok(!existsSync(join(home, "Library", "Caches", "opensourcebook-scenes")), "looking makes no new folder");
  // Once there is a copy under the new name, that one is used.
  const cached = join(home, "Library", "Caches", "opensourcebook-scenes", "chrome-headless-shell", "mac-arm64");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "chrome-headless-shell"), "");
  assert.equal(findChrome(root, {}, "darwin", home), join(cached, "chrome-headless-shell"));
  assert.equal(findChrome(root, {}, "linux", home), null, "the cached copy is a macOS thing");
  const local = join(root, "services", "scenes", "node_modules", ".remotion", "chrome-headless-shell", "linux64");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "chrome-headless-shell"), "");
  assert.equal(findChrome(root, {}, "linux", home), join(local, "chrome-headless-shell"));
  assert.equal(findChrome(root, { OPENSOURCEBOOK_CHROME: join(dir, "nope") }, "linux", home), null);
  assert.equal(percentIn("Downloading Chrome: 45%"), 45);
  assert.equal(percentIn("something else"), undefined);
});

test("arguments: start by default, check and status, plain errors", () => {
  assert.equal(parseArgs([], {}).command, "start");
  assert.equal(parseArgs([], {}).open, true);
  assert.equal(parseArgs([], { CI: "true" }).open, false);
  assert.equal(parseArgs(["check"], {}).command, "check");
  assert.equal(parseArgs(["--no-open", "--ports-from", "9100"], {}).portsFrom, 9100);
  assert.throws(() => parseArgs(["--ports-from", "80"], {}), /between 1024 and 65000/);
  assert.throws(() => parseArgs(["--what"], {}), /is not something opensourcebook knows/);
});
