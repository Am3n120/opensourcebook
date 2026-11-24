import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromeLine, packagesLine } from "../check.ts";
import { CHROME_SIZE, cachedChrome, dropSecondCopy } from "../chrome.ts";
import { installParts, took, type Part } from "../install.ts";
import { PROGRAMS } from "../programs.ts";

const parts: Part[] = [
  { dir: "web", name: "Web app", about: "the pages you open in your browser" },
  { dir: "engine", name: "Engine", about: "keeps your projects and makes the plans" },
  { dir: "services/scenes", name: "Video scenes", about: "draws and renders videos" },
];

test("an install says which part is going, a line per part as it finishes with its time, and what is left", async () => {
  let t = 0;
  const said: string[] = [];
  const waiting: string[] = [];
  const done = new Map<string, () => void>();
  const run = (p: Part) => new Promise<boolean>((resolve) => done.set(p.name, () => resolve(p.name !== "Engine")));
  const all = installParts(parts, run, { line: (x) => said.push(x), waiting: (x) => waiting.push(x) }, { now: () => t * 1000 });
  t = 38;
  done.get("Web app")!();
  await new Promise((r) => setImmediate(r));
  t = 125;
  done.get("Engine")!();
  done.get("Video scenes")!();
  const results = await all;
  assert.equal(waiting[0], "still installing: Web app, Engine, Video scenes");
  assert.equal(waiting[1], "still installing: Engine, Video scenes");
  assert.deepEqual(said, [
    "  Web app (the pages you open in your browser): ready, 38s",
    "  Engine (keeps your projects and makes the plans): did not finish, 2m 5s",
    "  Video scenes (draws and renders videos): ready, 2m 5s",
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(took(59), "59s");
});

test("a screen that cannot redraw is told again that it is still working", async () => {
  const said: string[] = [];
  let release: () => void = () => undefined;
  const run = () => new Promise<boolean>((resolve) => (release = () => resolve(true)));
  const all = installParts([parts[0]!], run, { line: (x) => said.push(x), waiting: () => undefined }, { heartbeatMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  release();
  await all;
  assert.ok(said.some((l) => l.startsWith("  still installing: Web app (")), said.join("\n"));
});

test("every program has a plain name and a few words on what it is for", () => {
  for (const p of PROGRAMS) {
    assert.ok(p.label && p.about, p.id);
    assert.doesNotMatch(`${p.label} ${p.about}`, /services\/|migration|secret|wrangler/i);
  }
});

test("the check names parts by their own names, never by folder", () => {
  const line = packagesLine(["services/agent-connector", "web"])!.text;
  assert.match(line, /Agent connector, Web app/);
  assert.doesNotMatch(line, /services\//);
});

test("the browser's size is said once, in one place", () => {
  assert.match(CHROME_SIZE, /180 MB/);
  assert.ok(chromeLine(null).text.includes(CHROME_SIZE));
});

test("on a Mac the browser is kept in one place: the copy the download leaves in node_modules goes once the outside copy is there", () => {
  const base = mkdtempSync(join(tmpdir(), "opensourcebook-chrome-"));
  try {
    const root = join(base, "repo");
    const home = join(base, "home");
    const inside = join(root, "services", "scenes", "node_modules", ".remotion", "chrome-headless-shell");
    mkdirSync(join(inside, "mac-arm64"), { recursive: true });
    writeFileSync(join(inside, "mac-arm64", "chrome-headless-shell"), "");
    // Without the outside copy the inside one is the only one and stays.
    assert.equal(dropSecondCopy(root, {}, "darwin", home), false);
    assert.ok(existsSync(inside));
    const outside = join(cachedChrome(home), "mac-arm64");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "chrome-headless-shell"), "");
    // Another computer, or a Chrome the person points at, is left alone.
    assert.equal(dropSecondCopy(root, {}, "linux", home), false);
    assert.equal(dropSecondCopy(root, { OPENSOURCEBOOK_CHROME: "/x" }, "darwin", home), false);
    assert.ok(existsSync(inside));
    assert.equal(dropSecondCopy(root, {}, "darwin", home), true);
    assert.ok(!existsSync(inside));
    assert.ok(existsSync(join(outside, "chrome-headless-shell")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
