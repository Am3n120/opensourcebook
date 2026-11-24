/** Settings under their names from before the rename (old-names.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { carryOldNames, newNameOf, oldNameOf, settingOf, underNewNames } from "../old-names.ts";

test("an old name maps to its new one, the state folder to its own name, and never onto a name the installer owns", () => {
  assert.equal(newNameOf("RE_CLIENT_TOKEN"), "OPENSOURCEBOOK_CLIENT_TOKEN");
  assert.equal(newNameOf("RE_UPDATE_CHECK"), "OPENSOURCEBOOK_UPDATE_CHECK");
  assert.equal(newNameOf("RE_HOME"), "OPENSOURCEBOOK_STATE");
  assert.equal(newNameOf("RE_ARCHIVE"), undefined, "OPENSOURCEBOOK_ARCHIVE is the installer's download address");
  for (const other of ["PATH", "RE_", "CORE_X", "OPENSOURCEBOOK_DEBUG", "SCENES_TOKEN"]) assert.equal(newNameOf(other), undefined, other);
  assert.equal(oldNameOf("OPENSOURCEBOOK_STATE"), "RE_HOME");
  assert.equal(oldNameOf("OPENSOURCEBOOK_NO_OPEN"), "RE_NO_OPEN");
  assert.equal(oldNameOf("OPENSOURCEBOOK_HOME"), undefined);
});

test("the shim sets each new name from its old one, and a new name that is set wins", () => {
  const env = carryOldNames<Record<string, string | undefined>>({ RE_NO_OPEN: "1", RE_UPDATE_CHECK: "0", OPENSOURCEBOOK_UPDATE_CHECK: "1", RE_HOME: "/state", RE_DEBUG: "", PATH: "/bin" });
  assert.equal(env.OPENSOURCEBOOK_NO_OPEN, "1");
  assert.equal(env.OPENSOURCEBOOK_UPDATE_CHECK, "1", "the new name was set, so it stays");
  assert.equal(env.OPENSOURCEBOOK_STATE, "/state");
  assert.equal(env.OPENSOURCEBOOK_HOME, undefined, "the installer's folder is never set from the old state folder");
  assert.equal(env.OPENSOURCEBOOK_DEBUG, undefined, "an empty old value sets nothing");
  assert.equal(env.RE_NO_OPEN, "1", "the old names are left for whatever else reads them");
});

test("a file the launcher writes gets new names only", () => {
  assert.deepEqual(underNewNames({ GEMINI_API_KEY: "g", RE_CLIENT_TOKEN: "old", RE_BROWSER_GATE: "off", OPENSOURCEBOOK_BROWSER_GATE: "on" }), { GEMINI_API_KEY: "g", OPENSOURCEBOOK_BROWSER_GATE: "on", OPENSOURCEBOOK_CLIENT_TOKEN: "old" });
});

test("a setting is read by its new name, else by its old one", () => {
  assert.equal(settingOf({ RE_ENGINE_INSPECTOR: "1" }, "OPENSOURCEBOOK_ENGINE_INSPECTOR"), "1");
  assert.equal(settingOf({ RE_ENGINE_INSPECTOR: "1", OPENSOURCEBOOK_ENGINE_INSPECTOR: "0" }, "OPENSOURCEBOOK_ENGINE_INSPECTOR"), "0");
  assert.equal(settingOf({}, "OPENSOURCEBOOK_ENGINE_INSPECTOR"), undefined);
  assert.equal(settingOf({ DEEPSEEK_API_KEY: "k" }, "DEEPSEEK_API_KEY"), "k");
});
