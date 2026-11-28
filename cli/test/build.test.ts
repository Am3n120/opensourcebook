import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { build, buildDir, buildFailed, inputFiles, isStale, launchArgs, planBuild, runStep, type StepRunner } from "../build.ts";
import { resolve } from "../commands/index.ts";
import { restartFlags } from "../commands/update.ts";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../main.ts";
import { PROGRAMS, webSettings, type Program, type Wiring } from "../programs.ts";
import { SECRET_NAMES, type Secrets } from "../secrets.ts";
import { builtModules, parsePrepareArgs, parseServeArgs, runtimeOptions, settingsFiles, settingsFromEnv, withoutLocalBrowser, type Runtime } from "../serve-worker.ts";
import { parseEnv } from "../envfile.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-build-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, `${n.toLowerCase()}-0123456789`])) as Secrets;
const ports = { engine: 9003, web: 9004, connector: 9000, scenes: 9002, "engine-inspector": 9005, "phone-control": 9007 };
const keys = { browser: "browser-key-0123456789", door: "door-key-0123456789" } as Wiring["keys"] & object;
const wiring = (extra: Partial<Wiring> = {}): Wiring => ({ root: dir, home: join(dir, ".opensourcebook"), ports, secrets, env: {}, keys, ...extra });
const program = (id: string) => PROGRAMS.find((p) => p.id === id)!;

test("a person's start runs the engine and the web app from their builds, with nothing watched", () => {
  const w = wiring();
  const engine = launchArgs(w, program("engine")).args;
  assert.ok(engine.some((a) => a.endsWith(join("cli", "serve-worker.ts"))));
  assert.equal(engine[engine.indexOf(engine.find((a) => a.endsWith("serve-worker.ts"))!) + 1], "serve");
  assert.equal(engine[engine.indexOf("--runtime") + 1], join(buildDir(w.home, "engine"), "runtime.json"));
  assert.equal(engine[engine.indexOf("--port") + 1], "9003");
  assert.equal(engine[engine.indexOf("--ip") + 1], "127.0.0.1");
  assert.equal(engine[engine.indexOf("--env-file") + 1], join(w.home, "engine.env"));
  assert.ok(launchArgs(wiring({ env: { OPENSOURCEBOOK_ENGINE_INSPECTOR: "1" } }), program("engine")).args.includes("--inspector-port"), "the debugger only when asked for");
  assert.equal(engine[engine.indexOf("--persist-to") + 1], join(".wrangler", "state"), "the database the migrations went into");
  assert.ok(engine.includes("nodejs_compat"));
  for (const word of ["dev", "--inspector-port", "--remote", "wrangler.js"]) assert.ok(!engine.some((a) => a === word || a.endsWith(word)), `the built engine is started without ${word}`);

  const webStart = launchArgs(w, program("web"));
  const web = webStart.args;
  assert.equal(web[web.indexOf("--runtime") + 1], join(buildDir(w.home, "web"), "runtime.json"));
  assert.equal(web[web.indexOf("--port") + 1], "9004");
  assert.ok(!web.some((a) => a.includes("vite")));
  // The proxy's settings, with this run's keys, go in through the environment: no file holds them.
  assert.ok(!web.includes("--env-file"));
  const settings = settingsFromEnv(web[web.indexOf("--bindings-from-env") + 1]!.split(","), webStart.env);
  assert.deepEqual(settings, webSettings(w));
  assert.deepEqual(settings, Object.fromEntries(Object.entries(program("web").start(w).env).filter(([k]) => k in settings)), "the same settings as the dev server");
  assert.equal(settings.OPENSOURCEBOOK_BROWSER_KEY, keys.browser);
  assert.equal(settings.OPENSOURCEBOOK_DOOR_KEY, keys.door);
  assert.ok(!existsSync(join(w.home, "web.env")));
  assert.equal(settings.OPENSOURCEBOOK_CLIENT_TOKEN, secrets.OPENSOURCEBOOK_CLIENT_TOKEN);
  assert.equal(settings.ENGINE_URL, "http://127.0.0.1:9003");
  assert.equal(settings.PHONE_URL, "http://127.0.0.1:9007");
  assert.equal(settings.PHONE_TOKEN, secrets.PHONE_TOKEN);

  // The programs with no build start as before, and every program waits for the same things in both ways.
  for (const p of PROGRAMS.filter((q) => !q.built)) assert.deepEqual(launchArgs(w, p), p.start(w));
  assert.deepEqual(program("web").after, ["engine"]);
  assert.equal(program("engine").health(w).path, "/health");
  assert.equal(program("web").health(w).path, "/api/v1/projects");
});

test("--dev starts the watching dev servers instead", () => {
  const w = wiring({ dev: true });
  const engine = launchArgs(w, program("engine")).args;
  assert.equal(engine[0], join("scripts", "dev.ts"), "the engine's own start script: wrangler dev through its API, watching")
  const web = launchArgs(w, program("web"));
  assert.ok(web.args[0]!.endsWith("vite.js"));
  assert.equal(web.env.ENGINE_URL, "http://127.0.0.1:9003");
  assert.equal(web.env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "true");

  assert.equal(parseArgs(["--dev", "--no-open"], {}).dev, true);
  assert.equal(parseArgs([], {}).dev, undefined, "a person gets the builds");
  const line = resolve(["--dev"]);
  assert.ok("command" in line && line.command.action === "start", "npm start -- --dev starts Open Sourcebook");
  assert.ok("command" in line && line.command.flags?.some((f) => f.name === "dev"));
});

test("the builds never deploy anything and are made into .opensourcebook/build", () => {
  const w = wiring();
  for (const p of PROGRAMS.filter((q) => q.built)) {
    const plan = planBuild(w, p)!;
    assert.equal(plan.out, join(w.home, "build", p.id));
    const all = plan.steps.flat();
    assert.ok(!all.includes("--remote"));
    if (all.includes("deploy")) assert.ok(all.includes("--dry-run"), `${p.id}: a deploy step only bundles`);
    const prepare = plan.steps.at(-1)!;
    assert.ok(prepare.includes("prepare"), `${p.id}: the last step keeps the runtime's options`);
    // prepare takes settings files out of the folder it finds a config in, so that folder is always the build's own.
    if (prepare.includes("--find-config")) assert.ok(prepare[prepare.indexOf("--find-config") + 1]!.startsWith(plan.out));
  }
  assert.deepEqual(settingsFiles([".dev.vars", ".dev.vars.example", ".env", ".env.example", ".env.local", "index.js", "wrangler.json"]), [".dev.vars", ".env", ".env.local"]);
});

/** A small repo with one program that has a build, and a step that writes what the real steps would. */
function fakeRepo(name: string) {
  const root = join(dir, name);
  mkdirSync(join(root, "app", "src"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "app", "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, "app", ".wrangler", "state"), { recursive: true });
  writeFileSync(join(root, "app", "src", "index.ts"), "export default 1;\n");
  writeFileSync(join(root, "app", "package-lock.json"), "{}\n");
  writeFileSync(join(root, "shared", "SKILL.md"), "# a skill\n");
  writeFileSync(join(root, "app", "node_modules", "x", "index.js"), "1");
  writeFileSync(join(root, "app", ".wrangler", "state", "db.sqlite"), "1");
  writeFileSync(join(root, "app", ".dev.vars"), "KEY=1\n");
  const app: Program = {
    id: "app",
    label: "App",
    about: "a test program",
    dir: "app",
    port: 1,
    readyWithinMs: 1,
    start: () => ({ args: ["dev-server.js"], env: {} }),
    health: () => ({ path: "/" }),
    built: { inputs: ["app", "shared"], steps: (_w, out) => [["bundle.js", "--out", out], ["prepare", "--out", join(out, "runtime.json")]], serve: (_w, out) => ({ args: ["serve", out], env: {} }) },
  };
  const w: Wiring = { root, home: join(root, ".opensourcebook"), ports: {}, secrets, env: {} };
  const ran: string[][] = [];
  const step: StepRunner = async (args) => {
    ran.push(args);
    if (args[0] === "prepare") writeFileSync(args[2]!, "{}");
    return true;
  };
  return { root, app, w, ran, step };
}

test("a build is made once and reused, and made again when what it is made from changes", async () => {
  const { root, app, w, ran, step } = fakeRepo("reuse");
  assert.deepEqual(inputFiles(root, ["app", "shared"]), ["app/package-lock.json", "app/src/index.ts", "shared/SKILL.md"], "packages, local state and settings are not inputs");
  let plan = planBuild(w, app)!;
  assert.equal(isStale(w, plan), true, "never built");
  assert.equal(await build(w, plan, join(dir, "reuse.log"), step), true);
  assert.equal(ran.length, 2);
  assert.equal(isStale(w, planBuild(w, app)!), false, "the next start reuses it");

  // Packages, the database and the person's settings change all the time without the code changing.
  writeFileSync(join(root, "app", "node_modules", "x", "index.js"), "2");
  writeFileSync(join(root, "app", ".wrangler", "state", "db.sqlite"), "2");
  writeFileSync(join(root, "app", ".dev.vars"), "KEY=2\n");
  assert.equal(isStale(w, planBuild(w, app)!), false);

  for (const change of [() => writeFileSync(join(root, "app", "src", "index.ts"), "export default 2;\n"), () => writeFileSync(join(root, "shared", "SKILL.md"), "# changed\n"), () => writeFileSync(join(root, "app", "src", "new.ts"), "1"), () => writeFileSync(join(root, "app", "package-lock.json"), '{"v":2}\n')]) {
    change();
    plan = planBuild(w, app)!;
    assert.equal(isStale(w, plan), true, "a pull or an update builds again");
    assert.equal(await build(w, plan, join(dir, "reuse.log"), step), true);
    assert.equal(isStale(w, planBuild(w, app)!), false);
  }
  rmSync(join(plan.out, "runtime.json"));
  assert.equal(isStale(w, planBuild(w, app)!), true, "a build that is gone is made again");
});

test("a build that fails is not kept, says so in a person's words, and is tried again next start", async () => {
  const { root, app, w, step } = fakeRepo("fails");
  const plan = planBuild(w, app)!;
  const failing: StepRunner = async (args, cwd, log) => (args[0] === "bundle.js" ? false : step(args, cwd, log));
  assert.equal(await build(w, plan, join(dir, "fails.log"), failing), false);
  assert.equal(isStale(w, planBuild(w, app)!), true);
  assert.ok(!existsSync(join(root, ".opensourcebook", "builds.json")));

  const words = buildFailed("Engine", ".opensourcebook/logs/build-engine.log", "engine");
  assert.match(words, /^ {2}Engine could not be built, so Open Sourcebook did not start\./);
  assert.match(words, /\.opensourcebook\/logs\/build-engine\.log/);
  assert.match(words, /engine\//);
  assert.match(words, /npm start -- --dev/);
  assert.match(words, /git pull/);
  assert.doesNotMatch(words, /Error|stack|esbuild|wrangler|vite/i);

  // A real step that fails: its words go to the log, and the build says it did not work.
  const log = join(dir, "real.log");
  writeFileSync(log, "");
  assert.equal(await runStep(["-e", "console.error('the bundler said no'); process.exit(2)"], dir, log), false);
  assert.match(readFileSync(log, "utf8"), /the bundler said no/);
  assert.equal(await runStep(["-e", "process.exit(0)"], dir, log), true);
});

test("serve-worker: the built modules, the settings over the config's variables, the state folder wrangler dev uses", () => {
  const modules = builtModules("/b", ["index.js", "index.js.map", "abc-SKILL.md", "README.md", "wrangler.json", "lib/x.wasm"], [{ type: "Text", include: ["**/*.md"] }, { type: "CompiledWasm", include: ["**/*.wasm", "**/*.wasm?module"] }]);
  assert.deepEqual(modules.map((m) => [m.type, m.path]), [["ESModule", join("/b", "index.js")], ["Text", join("/b", "abc-SKILL.md")], ["Text", join("/b", "README.md")], ["CompiledWasm", join("/b", "lib", "x.wasm")]]);

  const args = parseServeArgs(["--runtime", "r.json", "--port", "8787", "--env-file", "e.env", "--persist-to", ".wrangler/state", "--compatibility-flags", "nodejs_compat", "--bindings-from-env", "A,B"]);
  assert.deepEqual(args.fromEnv, ["A", "B"]);
  assert.deepEqual(settingsFromEnv(args.fromEnv, { A: "1", C: "3" }), { A: "1" });
  assert.equal(args.ip, "127.0.0.1");
  assert.equal(args.inspectorPort, undefined, "no inspector unless asked");
  const runtime: Runtime = { worker: { name: "engine", compatibilityFlags: [], bindings: { MODEL: "a", OPENSOURCEBOOK_CLIENT_TOKEN: "from-config" } }, externalWorkers: [], modulesRoot: "/b", modules };
  const options = runtimeOptions(args, runtime, { OPENSOURCEBOOK_CLIENT_TOKEN: "from-settings", KEY: "k" }) as { host: string; port: number; resourcePersistencePath: string; workers: Array<Record<string, unknown>> };
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8787);
  assert.ok(options.resourcePersistencePath.endsWith(join(".wrangler", "state", "v3")));
  assert.deepEqual(options.workers[0]!.bindings, { MODEL: "a", OPENSOURCEBOOK_CLIENT_TOKEN: "from-settings", KEY: "k" });
  assert.deepEqual(options.workers[0]!.compatibilityFlags, ["nodejs_compat"]);
  assert.equal(options.workers[0]!.modulesRoot, "/b");
  // A deployer's config may name the headless-browser binding; on this computer it is never given to the engine.
  const withBrowser = runtimeOptions(args, { ...runtime, worker: { ...runtime.worker, browserRendering: { binding: "BROWSER" } } }, {}) as { workers: Array<Record<string, unknown>> };
  assert.equal("browserRendering" in withBrowser.workers[0]!, false);
  assert.deepEqual(withoutLocalBrowser({ name: "engine", browserRendering: { binding: "BROWSER" } }), { name: "engine" });
  assert.throws(() => parseServeArgs(["--port", "1"]), /--runtime/);
  assert.throws(() => parsePrepareArgs(["--out", "x"]), /--config/);
  assert.deepEqual(parsePrepareArgs(["--find-config", "out/app", "--out", "r.json"]), { out: "r.json", findConfig: "out/app" });
});

test("after opensourcebook update the next start builds again what the update changed, and the restart is the built start", async () => {
  // A clone of Open Sourcebook's shape that an update fast-forwards, as `opensourcebook update` does (cli/update.ts).
  const remote = join(dir, "remote");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(join(remote, "app", "src"), { recursive: true });
  mkdirSync(join(remote, "other"), { recursive: true });
  writeFileSync(join(remote, "app", "src", "index.ts"), "export default 1;\n");
  writeFileSync(join(remote, "other", "notes.md"), "a\n");
  git(remote, "init", "-q", "-b", "main");
  git(remote, "add", ".");
  git(remote, "commit", "-q", "-m", "one");
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", remote, clone);

  const { app, ran, step } = fakeRepo("update-shape");
  const w: Wiring = { root: clone, home: join(clone, ".opensourcebook"), ports: {}, secrets, env: {} };
  const built = { ...app, built: { ...app.built!, inputs: ["app"] } };
  assert.equal(await build(w, planBuild(w, built)!, join(dir, "update.log"), step), true);
  assert.equal(isStale(w, planBuild(w, built)!), false);

  // An update that changes only files the build does not read leaves the build as it is.
  writeFileSync(join(remote, "other", "notes.md"), "b\n");
  git(remote, "commit", "-q", "-am", "two");
  git(clone, "pull", "-q", "--ff-only");
  assert.equal(isStale(w, planBuild(w, built)!), false);

  // One that changes the program's code builds it again at the next start.
  writeFileSync(join(remote, "app", "src", "index.ts"), "export default 2;\n");
  git(remote, "commit", "-q", "-am", "three");
  git(clone, "pull", "-q", "--ff-only");
  assert.equal(isStale(w, planBuild(w, built)!), true);
  const before = ran.length;
  assert.equal(await build(w, planBuild(w, built)!, join(dir, "update.log"), step), true);
  assert.ok(ran.length > before);

  // The update's restart starts Open Sourcebook the way a person starts it: from the build, never the dev servers.
  for (const ports of [{ connector: 8650 }, { connector: 14400 }]) {
    const flags = restartFlags(ports);
    assert.ok(!flags.includes("--dev"));
    assert.equal(parseArgs(flags, {}).dev, undefined);
  }
});
