/** Tiny archives and a stand-in app for the tests: nothing here touches the network or a real home folder. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const scratch = (name = "opensourcebook-install-") => realpathSync(mkdtempSync(join(tmpdir(), name)));

/**
 * A stand-in for the app: it writes each command line it gets to `calls.log` beside its package.json, answers
 * `stop --json` and `status --json` from a `running` file there, and exits with 7 for `fail`.
 */
export const FAKE_APP = `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const running = join(root, ".opensourcebook", "running");
appendFileSync(join(root, "calls.log"), JSON.stringify({ args, path: process.env.PATH, cwd: process.cwd() }) + "\\n");
if (args[0] === "stop") { const was = existsSync(running); rmSync(running, { force: true }); console.log(JSON.stringify({ ok: true, stopped: was })); }
else if (args[0] === "status") { console.log(JSON.stringify({ ok: true, running: existsSync(running) })); process.exit(existsSync(running) ? 0 : 1); }
else if (args[0] === "start") { mkdirSync(dirname(running), { recursive: true }); writeFileSync(running, args.join(" ")); }
else if (args[0] === "fail") process.exit(7);
`;

/** Makes a .tar.gz with one top folder holding these files ({ "path": "text" }), like a source archive. */
export function makeArchive(dir, name, files, top = "opensourcebook-main") {
  const root = join(dir, `${name}-src`, top);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const file = join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", join(dir, `${name}-src`), top]);
  return file;
}

export const appFiles = (extra = {}) => ({ "package.json": JSON.stringify({ name: "app", type: "module", bin: { app: "cli/fake.mjs" } }), "cli/fake.mjs": FAKE_APP, ...extra });

/** What `main` needs to run against a throwaway home, with everything it says collected. */
export function quietDeps(home, archive, more = {}) {
  const said = [];
  const warned = [];
  return { home, archive, userHome: dirname(home), env: { PATH: process.env.PATH, OPENSOURCEBOOK_NO_SHORTCUT: "1" }, say: (line) => said.push(line), warn: (line) => warned.push(line), said, warned, ...more };
}
