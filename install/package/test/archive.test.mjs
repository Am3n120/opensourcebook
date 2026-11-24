import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyFiles, fetchArchive, insideApp, readManifest, updateApp } from "../lib/archive.mjs";
import { Problem } from "../lib/problem.mjs";
import { runProcess } from "../lib/run.mjs";
import { appFiles, makeArchive, scratch } from "./helpers.mjs";

const read = (path) => readFileSync(path, "utf8");

test("an update removes the files the new archive dropped and keeps everything it never put there", async () => {
  const dir = scratch();
  const home = join(dir, "home");
  const first = makeArchive(dir, "one", appFiles({ "web/old.txt": "old", "web/deep/gone.txt": "gone", "keep.txt": "v1" }));
  const second = makeArchive(dir, "two", appFiles({ "keep.txt": "v2", "new/file.txt": "new" }));
  await updateApp({ home, archive: first, run: runProcess });
  assert.deepEqual(readManifest(join(home, "app.manifest")), ["cli/fake.mjs", "keep.txt", "package.json", "web/deep/gone.txt", "web/old.txt"]);

  // What a person's use leaves in the app folder: projects, packages, settings, a file beside a dropped one.
  for (const rel of [".opensourcebook/x", "node_modules/y", "engine/.wrangler/db", "web/mine.txt", ".env"]) {
    mkdirSync(join(home, "app", rel, ".."), { recursive: true });
    writeFileSync(join(home, "app", rel), "mine");
  }
  const result = await updateApp({ home, archive: second, run: runProcess });
  assert.deepEqual(result, { files: 4, removed: 2 });
  assert.equal(read(join(home, "app", "keep.txt")), "v2");
  assert.equal(read(join(home, "app", "new/file.txt")), "new");
  assert.ok(!existsSync(join(home, "app", "web/old.txt")));
  assert.ok(!existsSync(join(home, "app", "web/deep")), "a folder left empty is removed");
  for (const rel of [".opensourcebook/x", "node_modules/y", "engine/.wrangler/db", "web/mine.txt", ".env"]) assert.equal(read(join(home, "app", rel)), "mine");
  assert.deepEqual(readManifest(join(home, "app.manifest")), ["cli/fake.mjs", "keep.txt", "new/file.txt", "package.json"]);
  assert.ok(!existsSync(join(home, "tmp")), "nothing is left of the download");
});

test("a failed unpack leaves the app exactly as it was, and never asks it to stop", async () => {
  const dir = scratch();
  const home = join(dir, "home");
  await updateApp({ home, archive: makeArchive(dir, "one", appFiles({ "keep.txt": "v1" })), run: runProcess });
  const broken = join(dir, "broken.tar.gz");
  writeFileSync(broken, "this is not an archive");
  let stopped = false;
  await assert.rejects(updateApp({ home, archive: broken, run: runProcess, beforeChange: async () => (stopped = true) }), (error) => error instanceof Problem && /could not be unpacked/.test(error.message) && !!error.next);
  assert.equal(stopped, false);
  assert.equal(read(join(home, "app", "keep.txt")), "v1");
  assert.deepEqual(readManifest(join(home, "app.manifest")), ["cli/fake.mjs", "keep.txt", "package.json"]);
  assert.ok(!existsSync(join(home, "tmp")));
});

test("an archive that is not the app, a missing file and a failed download each stop before anything changes", async () => {
  const dir = scratch();
  const home = join(dir, "home");
  await updateApp({ home, archive: makeArchive(dir, "one", appFiles()), run: runProcess });
  await assert.rejects(updateApp({ home, archive: makeArchive(dir, "other", { "readme.txt": "hello" }), run: runProcess }), /does not hold Open Sourcebook/);
  await assert.rejects(updateApp({ home, archive: join(dir, "nowhere.tar.gz"), run: runProcess }), /There is no file/);
  await assert.rejects(updateApp({ home, archive: "https://example.invalid/app.tar.gz", run: runProcess, fetchImpl: async () => ({ ok: false, status: 404 }) }), /answer was 404/);
  await assert.rejects(updateApp({ home, archive: "https://example.invalid/app.tar.gz", run: runProcess, fetchImpl: async () => { throw new Error("offline"); } }), /could not be downloaded/);
  assert.deepEqual(readManifest(join(home, "app.manifest")), ["cli/fake.mjs", "package.json"]);
});

test("a web address is downloaded to a file in the home and unpacked like a local one", async () => {
  const dir = scratch();
  const home = join(dir, "home");
  const archive = makeArchive(dir, "one", appFiles({ "keep.txt": "from the web" }));
  const asked = [];
  const fetchImpl = async (address, options) => {
    asked.push([address, options.redirect]);
    return new Response(readFileSync(archive));
  };
  await updateApp({ home, archive: "https://example.invalid/app.tar.gz", run: runProcess, fetchImpl });
  assert.deepEqual(asked, [["https://example.invalid/app.tar.gz", "follow"]]);
  assert.equal(read(join(home, "app", "keep.txt")), "from the web");
  assert.equal(await fetchArchive(`file://${archive}`, join(dir, "unused")), archive);
});

test("a manifest line that points outside the app folder is never followed", () => {
  for (const bad of ["../x", "/etc/passwd", "a/../../b", "C:\\x", "a\\..\\b", ""]) assert.equal(insideApp(bad), false, bad);
  assert.equal(insideApp("web/.env.example"), true);
  const dir = scratch();
  writeFileSync(join(dir, "outside.txt"), "safe");
  mkdirSync(join(dir, "staging"));
  writeFileSync(join(dir, "staging", "a.txt"), "a");
  writeFileSync(join(dir, "app.manifest"), "../outside.txt\n");
  applyFiles(join(dir, "staging"), join(dir, "app"), join(dir, "app.manifest"));
  assert.equal(read(join(dir, "outside.txt")), "safe");
});
