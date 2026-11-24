/**
 * The builds a person runs: each program with a `built` way (programs.ts) is built once into `.opensourcebook/build/<id>/` and
 * started from there, with no bundler or file watcher left running. A build is current while its key is the one kept
 * in `.opensourcebook/builds.json`: a hash of every file in the program's inputs (its folder and the repo folders it bundles, with
 * the lockfile, so a pull or an update changes it) and of how it is built. So the first start and the first start
 * after a change build, and every other start skips it.
 */
import { OLD_STATE_DIR, STATE_DIR } from "./state.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writePrivate } from "./secrets.ts";
import type { Program, Wiring } from "./programs.ts";

/** Folders and files no build reads: installed packages, outputs, local state and the person's own settings. */
const SKIP = new Set(["node_modules", ".wrangler", "dist", ".git", ".DS_Store", ".dev.vars", ".env", STATE_DIR, OLD_STATE_DIR, "coverage"]);
const skipped = (name: string) => SKIP.has(name) || name.startsWith(".env.") || name.startsWith(".dev.vars.");

/** Every file under the inputs (paths from the repo root), sorted, skipping what no build reads. */
export function inputFiles(root: string, inputs: string[]): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isFile()) {
      out.push(relative(root, path).split(sep).join("/"));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) if (!skipped(entry)) walk(join(path, entry));
  };
  for (const input of inputs) walk(join(root, input));
  return [...new Set(out)].sort();
}

/** The key of a build: what it is made from (each file's path and contents) and how (the steps, the builder's own files). */
export function buildKey(root: string, inputs: string[], how: unknown): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(how));
  for (const file of inputFiles(root, inputs)) {
    hash.update(`\0${file}\0`);
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest("hex");
}

/** Where a program's build goes. */
export const buildDir = (home: string, id: string) => join(home, "build", id);

const RECORD = "builds.json";

export function readBuilds(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(home, RECORD), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeBuild(home: string, id: string, key: string): void {
  writePrivate(join(home, RECORD), `${JSON.stringify({ ...readBuilds(home), [id]: key }, null, 2)}\n`);
}

/** What is needed to build a program and to know whether its build is current. */
export interface Plan {
  program: Program;
  out: string;
  steps: string[][];
  key: string;
}

/** The launcher's own files that shape every build and how it runs, so a launcher update builds again. */
const BUILDER_FILES = ["cli/serve-worker.ts", "cli/build.ts"];

export function planBuild(w: Wiring, program: Program): Plan | undefined {
  if (!program.built) return undefined;
  const out = buildDir(w.home, program.id);
  const steps = program.built.steps(w, out);
  // Paths that differ per computer stay out of the key: two clones of the same code have the same key.
  const how = { steps: steps.map((s) => s.map((a) => a.replace(w.root, "<root>"))), node: process.versions.node.split(".")[0] };
  return { program, out, steps, key: buildKey(w.root, [...program.built.inputs, ...BUILDER_FILES], how) };
}

/** True when the program's build is missing or was made from other files. */
export function isStale(w: Wiring, plan: Plan): boolean {
  return readBuilds(w.home)[plan.program.id] !== plan.key || !existsSync(join(plan.out, "runtime.json"));
}

/** Runs one step (node with these arguments, in the program's folder), its output added to the log. */
export type StepRunner = (args: string[], cwd: string, log: string) => Promise<boolean>;

export const runStep: StepRunner = (args, cwd, log) =>
  new Promise((resolve) => {
    const out = createWriteStream(log, { flags: "a" });
    out.write(`\n$ node ${args.join(" ")}\n`);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", (error) => {
      out.end(`\n${error.message}\n`);
      resolve(false);
    });
    child.once("exit", (code) => {
      out.end();
      resolve(code === 0);
    });
  });

/** Builds one program from scratch into its folder and keeps its key when every step worked. */
export async function build(w: Wiring, plan: Plan, log: string, step: StepRunner = runStep): Promise<boolean> {
  rmSync(plan.out, { recursive: true, force: true });
  mkdirSync(plan.out, { recursive: true });
  writePrivate(log, "");
  for (const args of plan.steps) {
    if (!(await step(args, join(w.root, plan.program.dir), log))) return false;
  }
  writeBuild(w.home, plan.program.id, plan.key);
  return true;
}

/** How the launcher starts a program: from its build for a person, with its watching dev server for `--dev`. */
export function launchArgs(w: Wiring, program: Program): { args: string[]; env: Record<string, string> } {
  return program.built && !w.dev ? program.built.serve(w, buildDir(w.home, program.id)) : program.start(w);
}

/** What a failed build tells the person: which part, where its own words are, and what to do. */
export function buildFailed(label: string, log: string, dir: string): string {
  return `  ${label} could not be built, so Open Sourcebook did not start. What the build said is in ${log}. If you changed files in ${dir}/, undo the change, or run "npm start -- --dev" to run it without a build; otherwise get Open Sourcebook again ("git pull") and run "npm start" again.`;
}
