/**
 * Runs a Worker the launcher built (build.ts) in the local Workers runtime, with no bundler, no file watcher and no
 * live reload: what a person runs. Two steps, each run by the launcher in the program's own folder, so the runtime
 * and the config reader are the ones that folder installed (its wrangler, and the Miniflare that wrangler uses):
 *
 *   node serve-worker.ts prepare --config <wrangler config> --script <built entry> --out <runtime.json>
 *       once, after the build: wrangler reads the program's own config (the local database, the queue and its
 *       consumers, object storage, the text-module rules, static assets) into the runtime's options, kept in a file
 *       with the list of built modules, so starting never loads wrangler or reads the code for its imports.
 *   node serve-worker.ts serve --runtime <runtime.json> --ip 127.0.0.1 --port N [--env-file F] [--persist-to D]
 *                              [--bindings-from-env A,B] [--compatibility-flags a,b] [--inspector-port N]
 *       at each start: runs the build with those options. `--persist-to` is the folder `wrangler dev` keeps its local
 *       state in (`.wrangler/state`), so the database the launcher migrated is the one the program reads. Settings
 *       from `--env-file` become the Worker's variables, as `wrangler dev --env-file` does, and so do the variables
 *       `--bindings-from-env` names, read from this process's environment (for what must never be written to disk).
 *       No debugger port unless `--inspector-port` is given (then on 127.0.0.1 only).
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "./envfile.ts";

export interface ServeArgs {
  runtime: string;
  ip: string;
  port: number;
  envFile?: string;
  /** Names of variables to take from this process's environment. */
  fromEnv: string[];
  persistTo?: string;
  compatibilityFlags: string[];
  inspectorPort?: number;
}

export interface PrepareArgs {
  /** The program's own wrangler config, or */
  config?: string;
  /** a folder of build output holding the one config the build wrote. */
  findConfig?: string;
  /** The built entry, when the config's `main` is the source (the engine's). */
  script?: string;
  out: string;
}

function flags(argv: string[], known: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const key = known[arg];
    if (!key) throw new Error(`serve-worker does not take "${arg}".`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value.`);
    (out[key] ??= []).push(value);
  }
  return out;
}

export function parseServeArgs(argv: string[]): ServeArgs {
  const f = flags(argv, { "--runtime": "runtime", "--ip": "ip", "--port": "port", "--env-file": "envFile", "--persist-to": "persistTo", "--compatibility-flags": "flags", "--inspector-port": "inspector", "--bindings-from-env": "fromEnv" });
  const port = Number(f.port?.[0]);
  if (!f.runtime) throw new Error("serve needs --runtime.");
  if (!Number.isInteger(port)) throw new Error("serve needs --port.");
  const inspector = f.inspector ? Number(f.inspector[0]) : undefined;
  return {
    runtime: f.runtime[0]!,
    ip: f.ip?.[0] ?? "127.0.0.1",
    port,
    ...(f.envFile ? { envFile: f.envFile[0]! } : {}),
    fromEnv: (f.fromEnv ?? []).flatMap((v) => v.split(",")).filter(Boolean),
    ...(f.persistTo ? { persistTo: f.persistTo[0]! } : {}),
    compatibilityFlags: (f.flags ?? []).flatMap((v) => v.split(",")).filter(Boolean),
    ...(inspector ? { inspectorPort: inspector } : {}),
  };
}

export function parsePrepareArgs(argv: string[]): PrepareArgs {
  const f = flags(argv, { "--config": "config", "--find-config": "findConfig", "--script": "script", "--out": "out" });
  if (!(f.config || f.findConfig) || !f.out) throw new Error("prepare needs --config (or --find-config) and --out.");
  return { out: f.out[0]!, ...(f.config ? { config: f.config[0]! } : {}), ...(f.findConfig ? { findConfig: f.findConfig[0]! } : {}), ...(f.script ? { script: f.script[0]! } : {}) };
}

interface ModuleRule {
  type: string;
  include: string[];
}

/** What `prepare` keeps: the Worker's options as wrangler read them, and its built modules. */
export interface Runtime {
  worker: Record<string, unknown>;
  externalWorkers: unknown[];
  modulesRoot: string;
  modules: Array<{ type: string; path: string }>;
}

/** A glob of a module rule (`**\/*.md`, `**\/*.wasm?module`) as a test on a file's path. */
function matches(glob: string, path: string): boolean {
  const ext = /\*\.([A-Za-z0-9?]+)$/.exec(glob)?.[1]?.replace(/\?.*$/, "");
  return ext !== undefined && path.endsWith(`.${ext}`);
}

/** Every file of the build with the module type the rules give it; source maps and files no rule names are left out. */
export function builtModules(root: string, files: string[], rules: ModuleRule[]): Array<{ type: string; path: string }> {
  const all: ModuleRule[] = [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, ...rules];
  const out: Array<{ type: string; path: string }> = [];
  for (const file of files) {
    if (file.endsWith(".map")) continue;
    const rule = all.find((r) => r.include.some((g) => matches(g, file)));
    if (rule) out.push({ type: rule.type, path: join(root, file) });
  }
  return out;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split(sep).join("/")]));
}

/** The named variables that are set in an environment. */
export function settingsFromEnv(names: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) if (env[name] !== undefined) out[name] = env[name]!;
  return out;
}

/**
 * A Worker's options without what must not run on a person's computer: the headless-browser binding a deployer's
 * config may name (`[browser]`). Locally the runtime answers it by downloading a whole Chrome the first time a page is
 * rendered, and again after every failed try, which stalls the engine while it waits. Pages are read without it.
 */
export function withoutLocalBrowser(worker: Record<string, unknown>): Record<string, unknown> {
  const { browserRendering: _browser, ...rest } = worker;
  return rest;
}

/** The runtime's options at a start: what prepare kept, with the address, the state folder and the settings on top. */
export function runtimeOptions(args: ServeArgs, runtime: Runtime, settings: Record<string, string>): Record<string, unknown> {
  // Also for a build prepared before the browser binding was left out.
  const worker = withoutLocalBrowser(runtime.worker);
  const compatibilityFlags = [...new Set([...((worker.compatibilityFlags as string[] | undefined) ?? []), ...args.compatibilityFlags])];
  return {
    host: args.ip,
    port: args.port,
    ...(args.inspectorPort ? { inspectorPort: args.inspectorPort, inspectorHost: "127.0.0.1" } : {}),
    ...(args.persistTo ? { resourcePersistencePath: join(resolve(args.persistTo), "v3") } : {}),
    logRequests: false,
    workers: [
      {
        ...worker,
        name: (worker.name as string | undefined) ?? "worker",
        compatibilityFlags,
        modulesRoot: runtime.modulesRoot,
        modules: runtime.modules,
        bindings: { ...((worker.bindings as Record<string, unknown> | undefined) ?? {}), ...settings },
      },
      ...runtime.externalWorkers,
    ],
  };
}

/** The settings files (`.dev.vars`, `.env`) among a folder's names; examples (`*.example`) are not settings. */
export function settingsFiles(names: string[]): string[] {
  return names.filter((n) => (n === ".dev.vars" || n.startsWith(".dev.vars.") || n === ".env" || n.startsWith(".env.")) && !n.endsWith(".example"));
}

/** The one `wrangler.json` a build wrote for its Worker, in a folder of the build's output. */
export function findConfig(dir: string): string {
  const found = walk(dir).filter((f) => f.endsWith("/wrangler.json"));
  if (found.length !== 1) throw new Error(`Expected one wrangler.json in a folder of ${dir}, found ${found.length}.`);
  return join(dir, found[0]!);
}

function prepare(args: PrepareArgs): void {
  const here = createRequire(join(process.cwd(), "package.json"));
  const wrangler = here("wrangler") as {
    unstable_getMiniflareWorkerOptions(config: string, env?: string, options?: { envFiles?: string[] }): { workerOptions: Record<string, unknown>; main?: string; externalWorkers?: unknown[] };
  };
  const config = args.findConfig ? findConfig(resolve(args.findConfig)) : resolve(args.config ?? "");
  // Only the config's own variables are kept: the person's settings (.dev.vars, .env, the shell) come at each start
  // from --env-file, so no key is written into the build and a changed key needs no new build.
  delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  const read = wrangler.unstable_getMiniflareWorkerOptions(config, undefined, { envFiles: [join(dirname(resolve(args.out)), "no-settings.env")] });
  // A build of the web app copies its folder's .dev.vars beside its Worker for a preview; the launcher's run does not
  // read it, so it goes from the build's output. Only there: never from a program's own folder.
  if (args.findConfig) for (const name of settingsFiles(readdirSync(dirname(config)))) rmSync(join(dirname(config), name));
  const script = resolve(args.script ?? read.main ?? "");
  const root = dirname(script);
  const { modulesRules, ...worker } = read.workerOptions as { modulesRules?: ModuleRule[] } & Record<string, unknown>;
  const files = walk(root).sort((a, b) => (join(root, a) === script ? -1 : join(root, b) === script ? 1 : 0));
  const runtime: Runtime = { worker: withoutLocalBrowser(worker), externalWorkers: read.externalWorkers ?? [], modulesRoot: root, modules: builtModules(root, files, modulesRules ?? []) };
  writeFileSync(resolve(args.out), `${JSON.stringify(runtime, null, 1)}\n`);
}

async function serve(args: ServeArgs): Promise<void> {
  const here = createRequire(join(process.cwd(), "package.json"));
  const fromWrangler = createRequire(here.resolve("wrangler/package.json"));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = fromWrangler("miniflare") as {
    Miniflare: new (options: Record<string, unknown>) => { ready: Promise<URL>; dispose(): Promise<void> };
    Log: new (level: number) => unknown;
    LogLevel: Record<string, number>;
    /** Newer runtimes take their options in a new shape; wrangler still reads configs into the older one. */
    convertV4MiniflareOptions?: (options: Record<string, unknown>) => Record<string, unknown>;
  };
  const runtime = JSON.parse(readFileSync(args.runtime, "utf8")) as Runtime;
  const settings = { ...(args.envFile ? parseEnv(readFileSync(args.envFile, "utf8")) : {}), ...settingsFromEnv(args.fromEnv, process.env) };
  const options = { ...runtimeOptions(args, runtime, settings), log: new Log(LogLevel.INFO ?? 3) };
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  const at = await mf.ready;
  console.log(`Ready on ${at.href} (from the build, nothing watched)`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await mf.dispose();
    } finally {
      process.exit(0);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
}

if (import.meta.main) {
  const [step, ...rest] = process.argv.slice(2);
  const go = async () => {
    if (step === "prepare") prepare(parsePrepareArgs(rest));
    else if (step === "serve") await serve(parseServeArgs(rest));
    else throw new Error('serve-worker takes "prepare" or "serve" first.');
  };
  go().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
