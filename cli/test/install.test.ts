import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { install, linkedLine, linkedPackages, missingPackages, needsInstall, recordInstall } from "../install.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-install-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LOCK = { name: "p", lockfileVersion: 3, packages: { "": { name: "p" }, "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "2.0.0", optional: true } } };

/** A program folder with a lockfile and, unless told not to, packages installed from it (npm's own record of them). */
function folder(name: string, installed: Record<string, { version: string }> | false = { "node_modules/a": { version: "1.0.0" } }): string {
  const pkg = join(dir, name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "p", dependencies: { a: "^1.0.0" } }));
  writeFileSync(join(pkg, "package-lock.json"), JSON.stringify(LOCK, null, 2));
  if (installed) {
    mkdirSync(join(pkg, "node_modules", "a"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "a", "package.json"), "{}");
    writeFileSync(join(pkg, "node_modules", ".package-lock.json"), JSON.stringify({ name: "p", lockfileVersion: 3, packages: installed }));
  }
  return pkg;
}

test("install: needed without packages, and decided from the lockfile's content, not its file time", () => {
  const home = join(dir, "home-1");
  const pkg = folder("pkg", false);
  assert.equal(needsInstall(pkg, home), true);
  assert.equal(needsInstall(join(dir, "nothing-here"), home), false);
  rmSync(pkg, { recursive: true });
  folder("pkg");
  recordInstall(home, pkg);
  assert.equal(needsInstall(pkg, home), false);
  // A fresh checkout gives the lockfile a new time with the same content: nothing to install.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(pkg, "package-lock.json"), later, later);
  assert.equal(needsInstall(pkg, home), false);
  // A pull that changes the lockfile does need one.
  writeFileSync(join(pkg, "package-lock.json"), JSON.stringify({ ...LOCK, packages: { ...LOCK.packages, "node_modules/a": { version: "1.1.0" } } }));
  assert.equal(needsInstall(pkg, home), true);
});

test("install: with no record, the installed packages are compared with the lockfile, and a match is recorded", () => {
  const home = join(dir, "home-2");
  const same = folder("same");
  assert.equal(needsInstall(same, home), false);
  assert.ok(Object.keys(JSON.parse(readFileSync(join(home, "installs.json"), "utf8"))).some((k) => k.endsWith("same")));
  // An optional package for another system is not required; a package at another version is.
  assert.equal(needsInstall(folder("older", { "node_modules/a": { version: "0.9.0" } }), home), true);
  assert.equal(needsInstall(folder("short", {}), home), true);
  assert.equal(needsInstall(folder("extra", { "node_modules/a": { version: "1.0.0" }, "node_modules/z": { version: "1.0.0" } }), home), true);
});

test("install: a node_modules that is a symbolic link is never installed into, and says whether its packages answer", async () => {
  const home = join(dir, "home-3");
  const other = folder("other-checkout/engine");
  const root = join(dir, "root");
  const engine = join(root, "engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "package.json"), readFileSync(join(other, "package.json")));
  // The lockfile differs from what the link's packages were made from: still no install through the link.
  writeFileSync(join(engine, "package-lock.json"), JSON.stringify({ ...LOCK, packages: { ...LOCK.packages, "node_modules/a": { version: "1.1.0" } } }));
  symlinkSync(join(other, "node_modules"), join(engine, "node_modules"));
  assert.equal(needsInstall(engine, home), false);
  assert.deepEqual(missingPackages(root, home), []);
  const [linked] = linkedPackages(root);
  assert.deepEqual(linked, { dir: "engine", target: join(other, "node_modules"), answers: true });
  assert.match(linkedLine("Engine", linked!), /^ {2}Engine: engine\/node_modules is a symbolic link to .*other-checkout\/engine\/node_modules, and Open Sourcebook does not install into a link .* The packages there answer, so Open Sourcebook goes on with them/);

  const log = join(dir, "install.log");
  assert.equal(await install(engine, log, home), false);
  assert.match(readFileSync(log, "utf8"), /is a symbolic link to .* Open Sourcebook does not install into a link/);
  // The folder the link points at is left as it was.
  assert.ok(existsSync(join(other, "node_modules", "a", "package.json")));

  rmSync(join(other, "node_modules", "a"), { recursive: true });
  const [broken] = linkedPackages(root);
  assert.equal(broken!.answers, false);
  assert.match(linkedLine("Engine", broken!), /The packages there do not answer\. Delete the link itself \(not the folder it points at\) and start again/);
});
