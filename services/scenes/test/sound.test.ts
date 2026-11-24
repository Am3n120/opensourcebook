import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { graph, KIT, mix, placements } from "../src/sound.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-sound-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const scenes = [
  { id: "s1", offset: 0, words: [0.25, 0.6, 1.0, 1.4, 1.9].map((start) => ({ start })) },
  { id: "s2", offset: 3, words: [0.25, 0.7, 1.2, 1.6].map((start) => ({ start })) },
];

test("every kit sound has its source", () => {
  assert.ok(Object.keys(KIT.music).length >= 1 && Object.keys(KIT.sfx).length >= 1);
  for (const name of [...Object.keys(KIT.music), ...Object.keys(KIT.sfx)]) assert.ok(existsSync(join(import.meta.dirname, "..", "audio", "kit", "src", `${name}.mp3`)), name);
});

test("placements land on scene words, drop what does not exist, keep effects apart and levels in range", () => {
  const { hits, music } = placements({
    music: [{ scene: "s1", at: 2, name: "focus", level: 5, why: "" }, { scene: "s2", at: 0, name: "nope", level: -4, why: "" }],
    effects: [
      { scene: "s1", at: 4, name: "pop", level: -10, why: "" },
      { scene: "s2", at: 0, name: "pop", level: -30, why: "too close to the one before" },
      { scene: "s2", at: 3, name: "whoosh", level: -60, why: "" },
      { scene: "s9", at: 0, name: "pop", level: -20, why: "" },
      { scene: "s2", at: 9, name: "pop", level: -20, why: "" },
    ],
  }, scenes, 10);
  assert.deepEqual(hits.map((h) => [h.name, h.at, h.level]), [["pop", 1.9, -18], ["whoosh", 4.6, -40]]);
  assert.deepEqual(music.map((m) => [m.name, m.at, m.level]), [["focus", 0, -80], ["focus", 1, 0]]);
});

test("with no music the graph still mixes the voice and fades out at the end", () => {
  const g = graph([], [], 8, "anull");
  assert.match(g, /\[sc\]anullsink/);
  assert.match(g, /afade=t=out:st=6\.000:d=2\.000/);
});

test("the voice with a bed and an effect is mastered to -14 LUFS", async () => {
  const voice = join(dir, "voice.wav");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-af", "volume=0.3,apad=pad_dur=3", "-ar", "48000", "-ac", "1", voice]);
  const { hits, music } = placements({ music: [{ scene: "s1", at: 0, name: Object.keys(KIT.music)[0]!, level: -2, why: "" }], effects: [{ scene: "s2", at: 1, name: Object.keys(KIT.sfx)[0]!, level: -20, why: "" }] }, scenes, 9);
  const out = await mix({ voice, hits, music, seconds: 9, folder: dir, kitDir: join(dir, "kit") });
  assert.ok(Math.abs(out.lufs + 14) < 0.6, `${out.lufs} LUFS`);
  assert.ok(out.truePeak <= -1, `${out.truePeak} dBTP`);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out.file], { encoding: "utf8" }));
  assert.ok(Math.abs(seconds - 9) < 0.05, `${seconds} s`);
});
