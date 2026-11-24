import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachedChrome, findBinary, useChrome } from "../src/chrome.ts";
import { carryOldNames } from "../src/old-names.ts";

test("the downloaded headless Chrome is found by its name on each system, chrome-headless-shell.exe on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-chrome-"));
  try {
    for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
      const inner = join(dir, name === "chrome-headless-shell" ? "mac" : "win", "chrome-headless-shell-x");
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, name), "");
      assert.equal(findBinary(join(dir, name === "chrome-headless-shell" ? "mac" : "win")), join(inner, name));
    }
    assert.equal(findBinary(join(dir, "none")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const shell = (home: string, name: string) => {
  const dir = join(home, "Library", "Caches", name, "chrome-headless-shell", "mac-arm64");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chrome-headless-shell"), "");
  return join(dir, "chrome-headless-shell");
};

test("the copy of Chrome made before the rename is used where it is, and a new one goes to the new folder", () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-chrome-home-"));
  try {
    const now = join(home, "Library", "Caches", "opensourcebook-scenes", "chrome-headless-shell");
    const old = join(home, "Library", "Caches", "re-scenes", "chrome-headless-shell");
    assert.equal(cachedChrome(home), now, "neither is there: the new folder");
    const oldShell = shell(home, "re-scenes");
    assert.equal(cachedChrome(home), old, "only the old one: read in place");
    const env: NodeJS.ProcessEnv = {};
    assert.equal(useChrome(env, "darwin", home), oldShell);
    assert.equal(env.OPENSOURCEBOOK_CHROME, oldShell);
    const newShell = shell(home, "opensourcebook-scenes");
    assert.equal(cachedChrome(home), now, "both: the new one");
    assert.equal(useChrome({}, "darwin", home), newShell);
    assert.equal(findBinary(old), oldShell, "the old copy is still there, untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Chrome named in the settings wins, and only under its new name", () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-chrome-home-"));
  try {
    assert.equal(useChrome({ OPENSOURCEBOOK_CHROME: "/somewhere/chrome" }, "darwin", home), "/somewhere/chrome");
    const env: NodeJS.ProcessEnv = { ["BETTER" + "VID_CHROME"]: "/old/chrome" };
    assert.equal(useChrome(env, "darwin", home), undefined);
    assert.equal(env.OPENSOURCEBOOK_CHROME, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a setting under its name from before the rename is carried to the new name, unless the new one is set", () => {
  const env: NodeJS.ProcessEnv = { RE_AGENT: "codex", RE_HOME: "/state", RE_NO_OPEN: "1", OPENSOURCEBOOK_NO_OPEN: "0", SCENES_TOKEN: "t", RENDER_CRF: "20" };
  carryOldNames(env);
  assert.equal(env.OPENSOURCEBOOK_AGENT, "codex");
  assert.equal(env.OPENSOURCEBOOK_STATE, "/state");
  assert.equal(env.OPENSOURCEBOOK_HOME, undefined);
  assert.equal(env.OPENSOURCEBOOK_NO_OPEN, "0");
  assert.equal(env.OPENSOURCEBOOK_NDER_CRF, undefined);
  assert.equal(env.SCENES_TOKEN, "t");
});
