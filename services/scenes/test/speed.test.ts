/**
 * How fast this computer draws, kept and said: what the file holds, which speed is used, and the words for a time.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { useChrome } from "../src/chrome.ts";
import { howLong, measureStyles, SpeedBook } from "../src/speed.ts";

useChrome();

const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-speed-"));
after(() => rmSync(folder, { recursive: true, force: true }));

test("nothing measured says nothing: no number is invented", () => {
  const book = new SpeedBook();
  assert.equal(book.speed("chalkboard", 4), undefined);
  assert.equal(book.seconds("chalkboard", 3000, 4), undefined);
  assert.deepEqual(book.view(["chalkboard", "flat"], 4), {});
});

test("a speed is kept in a file and read again by the next run", () => {
  const file = join(folder, "kept", "speed.json");
  const book = new SpeedBook(file);
  book.record("flat", { fps: 40, frames: 900, concurrency: 4, by: "render", setupSeconds: 8 });
  const again = new SpeedBook(file);
  assert.equal(again.speed("flat", 4)?.fps, 40);
  // 2400 frames at 40 a second, and 8 seconds to start.
  assert.equal(again.seconds("flat", 2400, 4), 68);
  assert.deepEqual(again.view(["flat", "ink"], 4), { flat: { framesPerSecond: 40, setupSeconds: 8, measuredBy: "render" } });
  // A file that cannot be read is no speed, not an error.
  writeFileSync(file, "not json");
  assert.equal(new SpeedBook(file).speed("flat", 4), undefined);
});

test("how long whole videos took to make is kept, the newest few, and a video too short to say anything is not", () => {
  const file = join(folder, "made", "speed.json");
  const book = new SpeedBook(file);
  assert.deepEqual(book.made(), []);
  book.recordMade({ seconds: 840.4, videoSeconds: 556.2, at: "2026-11-19T18:46:00.000Z" });
  book.recordMade({ seconds: 30, videoSeconds: 2 });
  book.recordMade({ seconds: Number.NaN, videoSeconds: 60 });
  assert.deepEqual(new SpeedBook(file).made(), [{ seconds: 840, videoSeconds: 556, at: "2026-11-19T18:46:00.000Z" }]);
  for (let i = 1; i <= 6; i++) book.recordMade({ seconds: 300 + i, videoSeconds: 75 });
  assert.deepEqual(book.made().map((m) => m.seconds), [302, 303, 304, 305, 306]);
});

test("whole-video timing keeps agent, model, and effort and buckets newest runs per pick", () => {
  const file = join(folder, "speed-buckets.json");
  const book = new SpeedBook(file);
  book.recordMade({ seconds: 1500, videoSeconds: 180, agent: "claude", model: "opus", effort: "high" });
  for (let i = 1; i <= 6; i++) {
    book.recordMade({ seconds: 300 + i, videoSeconds: 120, agent: "claude", model: "haiku", effort: "low" });
  }
  const loaded = new SpeedBook(file).made();
  const opus = loaded.filter((m) => m.model === "opus");
  const haiku = loaded.filter((m) => m.model === "haiku");
  assert.deepEqual(opus.map((m) => [m.agent, m.model, m.effort, m.seconds]), [["claude", "opus", "high", 1500]]);
  assert.deepEqual(haiku.map((m) => m.seconds), [302, 303, 304, 305, 306]);
});

test("real renders outrank the short measure, and the middle of the last few is taken", () => {
  const book = new SpeedBook();
  book.record("ink", { fps: 20, frames: 60, concurrency: 4, by: "measured" });
  assert.equal(book.speed("ink", 4)?.by, "measured");
  for (const fps of [30, 90, 32, 31, 29, 33]) book.record("ink", { fps, frames: 900, concurrency: 4, by: "render" });
  const speed = book.speed("ink", 4)!;
  assert.equal(speed.by, "render");
  // The last five are 90, 32, 31, 29, 33: the middle is 32, and one odd render does not move it.
  assert.equal(speed.fps, 32);
});

test("a speed measured at fewer frames at once is what a computer that had to draw fewer really does; one at more is out of date", () => {
  const book = new SpeedBook();
  book.record("flat", { fps: 15, frames: 900, concurrency: 1, by: "render" });
  assert.equal(book.speed("flat", 4)?.fps, 15, "asked for four, it has only ever managed one");
  book.record("flat", { fps: 50, frames: 900, concurrency: 4, by: "render" });
  assert.equal(book.speed("flat", 4)?.fps, 50);
  assert.equal(book.speed("flat", 2)?.fps, 15, "the four-at-once speed does not stand for two");
  assert.equal(new SpeedBook().speed("flat", 4), undefined);
});

test("a speed that is not a number a render could have is not kept", () => {
  const book = new SpeedBook();
  for (const fps of [0, -3, NaN, Infinity]) book.record("flat", { fps, frames: 900, concurrency: 4, by: "render" });
  assert.equal(book.speed("flat", 4), undefined);
});

test("a time is said as a person says it", () => {
  assert.equal(howLong(5), "under a minute");
  assert.equal(howLong(49), "under a minute");
  assert.equal(howLong(60), "about a minute");
  assert.equal(howLong(85), "about a minute");
  assert.equal(howLong(240), "about 4 minutes");
  assert.equal(howLong(25 * 60), "about 25 minutes");
  assert.equal(howLong(3600), "about 60 minutes");
  assert.equal(howLong(2 * 3600), "about 2 hours");
  assert.equal(howLong(2.5 * 3600), "about 2.5 hours");
});

test("a style with no speed is measured once by drawing a sample, in a folder that did not exist; one with a speed is left alone", async () => {
  const book = new SpeedBook();
  const lines: string[] = [];
  const before = process.env.RENDER_CONCURRENCY;
  process.env.RENDER_CONCURRENCY = "1";
  after(() => (before === undefined ? delete process.env.RENDER_CONCURRENCY : (process.env.RENDER_CONCURRENCY = before)));
  const done = await measureStyles(book, ["flat"], { folder: join(folder, "measure", "nested"), concurrency: 1, log: (l) => lines.push(l) });
  assert.deepEqual(done, ["flat"], lines.join("; "));
  const speed = book.speed("flat", 1)!;
  assert.ok(speed.fps > 1 && speed.fps < 2000, `${speed.fps} frames a second`);
  assert.equal(speed.by, "measured");
  assert.deepEqual(await measureStyles(book, ["flat"], { folder: join(folder, "measure"), concurrency: 1 }), [], "already measured: nothing drawn");
  // A style that does not exist is logged and left without a speed; it never throws.
  assert.deepEqual(await measureStyles(book, ["no-such-style"], { folder: join(folder, "measure"), concurrency: 1, log: (l) => lines.push(l) }), []);
  assert.equal(book.speed("no-such-style", 1), undefined);
  assert.ok(lines.some((l) => /could not measure/.test(l)));
});
