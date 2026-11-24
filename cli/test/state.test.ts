/** The state folder (state.ts): where it is found, and what a start does with one from before the rename. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OLD_STATE_DIR, STATE_DIR, stateFolder } from "../state.ts";

const base = mkdtempSync(join(tmpdir(), "opensourcebook-state-"));
after(() => rmSync(base, { recursive: true, force: true }));

function copy(name: string, folders: string[] = []): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  for (const folder of folders) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "secrets.json"), JSON.stringify({ from: folder }));
  }
  return root;
}

test("the new folder is used when it is there, even next to an old one, and nothing is moved", () => {
  const root = copy("both", [STATE_DIR, OLD_STATE_DIR]);
  const said: string[] = [];
  assert.equal(stateFolder(root, {}), join(root, STATE_DIR));
  assert.equal(stateFolder(root, {}, { settle: true, say: (l) => said.push(l), rename: () => assert.fail("nothing is moved") }), join(root, STATE_DIR));
  assert.deepEqual(said, []);
  assert.equal(JSON.parse(readFileSync(join(root, OLD_STATE_DIR, "secrets.json"), "utf8")).from, OLD_STATE_DIR, "the old folder is left as it was");
});

test("only an old folder: every command but a start reads it where it is and changes nothing", () => {
  const root = copy("old-read", [OLD_STATE_DIR]);
  assert.equal(stateFolder(root, {}), join(root, OLD_STATE_DIR));
  assert.equal(stateFolder(root, {}, { rename: () => assert.fail("only a start moves it") }), join(root, OLD_STATE_DIR));
  assert.ok(!existsSync(join(root, STATE_DIR)));
  assert.ok(lstatSync(join(root, OLD_STATE_DIR)).isDirectory());
});

test("only an old folder: a start moves it to the new name in one step and leaves a link under the old name", () => {
  const root = copy("old-start", [OLD_STATE_DIR]);
  const said: string[] = [];
  const home = stateFolder(root, {}, { settle: true, say: (l) => said.push(l) });
  assert.equal(home, join(root, STATE_DIR));
  assert.equal(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8")).from, OLD_STATE_DIR, "what was in it came along");
  assert.match(said.join("\n"), /moved from \.re\/ to \.opensourcebook\//);
  if (process.platform !== "win32") {
    assert.ok(lstatSync(join(root, OLD_STATE_DIR)).isSymbolicLink());
    assert.equal(readlinkSync(join(root, OLD_STATE_DIR)), STATE_DIR, "a relative link, so the copy can be moved as a whole");
    // A launcher from before the rename reads and writes through the old name and reaches the same files.
    writeFileSync(join(root, OLD_STATE_DIR, "running.json"), "{}");
    assert.ok(existsSync(join(home, "running.json")));
  }
  // The next start, and every command after it, finds the new folder and moves nothing.
  assert.equal(stateFolder(root, {}, { settle: true, rename: () => assert.fail("already moved") }), home);
  assert.equal(stateFolder(root, {}), home);
});

test("a link that cannot be made (Windows) is no problem: the folder is moved and used", () => {
  const root = copy("no-link", [OLD_STATE_DIR]);
  const home = stateFolder(root, {}, { settle: true, link: () => { throw new Error("EPERM: operation not permitted, symlink"); } });
  assert.equal(home, join(root, STATE_DIR));
  assert.ok(existsSync(join(home, "secrets.json")));
  assert.ok(!existsSync(join(root, OLD_STATE_DIR)));
});

test("when the move itself fails the old folder is used where it is, and the log says so", () => {
  const root = copy("stuck", [OLD_STATE_DIR]);
  const said: string[] = [];
  const home = stateFolder(root, {}, { settle: true, say: (l) => said.push(l), rename: () => { throw new Error("EBUSY: resource busy or locked, rename"); } });
  assert.equal(home, join(root, OLD_STATE_DIR));
  assert.match(said.join("\n"), /stay in \.re\/ for now.*EBUSY/);
  assert.ok(existsSync(join(home, "secrets.json")), "nothing in it was touched");
  assert.ok(!existsSync(join(root, STATE_DIR)), "no second, empty folder was made beside it");
});

test("neither folder: a start makes the new one, and anything else only names it", () => {
  const root = copy("fresh");
  assert.equal(stateFolder(root, {}), join(root, STATE_DIR));
  assert.ok(!existsSync(join(root, STATE_DIR)), "a status or a check makes nothing");
  assert.equal(stateFolder(root, {}, { settle: true }), join(root, STATE_DIR));
  assert.ok(lstatSync(join(root, STATE_DIR)).isDirectory());
  assert.ok(!existsSync(join(root, OLD_STATE_DIR)));
});

test("a folder named in the environment wins: OPENSOURCEBOOK_STATE, then the old RE_HOME, and never the installer's OPENSOURCEBOOK_HOME", () => {
  const root = copy("named", [STATE_DIR, OLD_STATE_DIR]);
  const elsewhere = join(base, "elsewhere");
  const before = join(base, "before");
  assert.equal(stateFolder(root, { OPENSOURCEBOOK_STATE: elsewhere, RE_HOME: before }), elsewhere);
  assert.equal(stateFolder(root, { RE_HOME: before }), before);
  assert.ok(!existsSync(before), "naming it makes nothing");
  assert.equal(stateFolder(root, { RE_HOME: before }, { settle: true }), before);
  assert.ok(existsSync(before), "a start makes it");
  // The installer keeps the whole app in OPENSOURCEBOOK_HOME and hands its environment to the launcher.
  assert.equal(stateFolder(root, { OPENSOURCEBOOK_HOME: join(base, "installer") }), join(root, STATE_DIR));
});
