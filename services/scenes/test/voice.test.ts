import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimate, LEAD, sayVoice, sentences, silentVoice, spread, TAIL, voiceFromEnv } from "../src/voice.ts";
import { chooseVoice, NO_KEY_NOTE } from "../src/voice-choice.ts";
import { SILENT_CAPTION_WORDS } from "../src/timeline.ts";
import { captions } from "../pipeline/stages/timeline.ts";

const ordered = (words: { start: number; end: number }[]) => words.every((w, i) => w.end > w.start && (i === 0 || w.start >= words[i - 1]!.end - 1e-6));

test("estimated times start after the lead, run in order, and end before the tail", () => {
  const t = estimate("A lever is a stiff bar. It turns on one point, the fulcrum.");
  assert.equal(t.words.length, 13);
  assert.ok(Math.abs(t.words[0]!.start - LEAD) < 1e-6);
  assert.ok(ordered(t.words));
  assert.ok(Math.abs(t.seconds - (t.words.at(-1)!.end + TAIL)) < 1e-3);
});

test("sentences split after their last word, and a measured stretch is shared by weight", () => {
  assert.deepEqual(sentences("One two. Three four! Five"), [["One", "two."], ["Three", "four!"], ["Five"]]);
  const words = spread(["a", "considerable", "lever"], 1, 2);
  assert.ok(ordered(words));
  assert.ok(Math.abs(words[0]!.start - 1) < 1e-3);
  assert.ok(Math.abs(words.at(-1)!.end - 3) < 1e-3);
  assert.ok(words[1]!.end - words[1]!.start > words[0]!.end - words[0]!.start, "a longer word takes longer");
});

test("the silent voice gives the estimate and no audio", async () => {
  const [s] = await silentVoice().speak([{ id: "s1", text: "Push down far from it." }], tmpdir());
  assert.equal(s!.audio, undefined);
  assert.deepEqual(s!.words, estimate("Push down far from it.").words);
});

test("which voice runs is a setting", () => {
  assert.equal(voiceFromEnv({ SCENES_VOICE: "silent" }).id, "silent");
  assert.equal(voiceFromEnv({ SCENES_VOICE: "say" }).id, "say");
  assert.equal(voiceFromEnv({ SCENES_VOICE: "kokoro" }, undefined, { kokoro: true }).id, "kokoro");
  assert.throws(() => voiceFromEnv({ SCENES_VOICE: "robot" }), /not a voice/);
});

test("with no voice key a video has no sound on every system; nothing falls back to this computer's voice by itself", () => {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      Object.defineProperty(process, "platform", { ...was, value: platform });
      for (const env of [{}, { ELEVENLABS_API_KEY: "" }, { ELEVENLABS_API_KEY: "   " }]) {
        const voice = voiceFromEnv(env);
        assert.equal(voice.id, "silent", platform);
        assert.equal(voice.real, false);
        assert.equal(voice.note, NO_KEY_NOTE);
      }
      assert.equal(voiceFromEnv({ ELEVENLABS_API_KEY: "k" }).id, "elevenlabs");
    }
  } finally {
    Object.defineProperty(process, "platform", was);
  }
});

test("this computer's voice is on only when a person turns it on, and is named as robotic and a quick test", () => {
  const voice = voiceFromEnv({ SCENES_VOICE: "say" });
  assert.equal(voice.id, "say");
  assert.match(voice.label, /robotic/);
  assert.match(voice.note ?? "", /robotic.*SCENES_VOICE=say.*quick test.*Settings, under Voice/);
  // With a key, ElevenLabs it is; asking for it without one is an error, never a quiet change of voice.
  assert.equal(chooseVoice({ ELEVENLABS_API_KEY: "k" }).note, undefined);
  assert.throws(() => chooseVoice({ SCENES_VOICE: "elevenlabs" }), /needs ELEVENLABS_API_KEY/);
});

test("the no-key line says what is made and what to do, once, in one place", () => {
  assert.equal(NO_KEY_NOTE, "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.");
  assert.match(chooseVoice({ ELEVENLABS_API_KEY: "k", SCENES_VOICE: "silent" }).note ?? "", /SCENES_VOICE=silent/);
});

const PASSAGE = "A lever is a stiff bar that turns on one point, the fulcrum. Push down far from it and a small push lifts a heavy load. That is why a long wrench loosens a stubborn bolt. The longer the arm, the less force you need, but the further your hand has to travel.";

test("the silent pace is a believable speaking pace, inside what a real ElevenLabs voice does, since the video's length now follows it", () => {
  // Real narrated scenes (words, characters and seconds from first to last character, measured from ElevenLabs word times).
  const real = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "eleven-pace.json"), "utf8")) as { scenes: { words: number; characters: number; seconds: number }[] }).scenes;
  const sum = (key: "words" | "characters" | "seconds") => real.reduce((a, r) => a + r[key], 0);
  const realWpm = (sum("words") / sum("seconds")) * 60;
  const fastest = Math.max(...real.map((r) => (r.words / r.seconds) * 60));
  const slowest = Math.min(...real.map((r) => (r.words / r.seconds) * 60));
  const quiet = estimate(PASSAGE);
  const seconds = quiet.words.at(-1)!.end - quiet.words[0]!.start;
  const wpm = (PASSAGE.split(" ").length / seconds) * 60;
  assert.ok(wpm > slowest && wpm < fastest, `${wpm.toFixed(0)} words a minute is outside what ElevenLabs gives (${slowest.toFixed(0)} to ${fastest.toFixed(0)})`);
  assert.ok(Math.abs(wpm - realWpm) / realWpm < 0.12, `silent ${wpm.toFixed(0)} against real ${realWpm.toFixed(0)} words a minute`);
});

test("a silent video's captions are pages long enough to read, and a style's own setting wins", () => {
  const words = PASSAGE.split(" ").map((text, i) => ({ text, start: 0.25 + i * 0.4, end: 0.25 + i * 0.4 + 0.35, beatId: "s1" }));
  const project = { narration: { words, holds: [] }, script: { beats: [{ id: "s1", emphasis: [] }] } } as never;
  const pages = (most?: number) => captions(project, [], most);
  const longest = (list: ReturnType<typeof pages>) => Math.max(...list.map((p) => p.words.length));
  assert.ok(longest(pages(SILENT_CAPTION_WORDS)) <= SILENT_CAPTION_WORDS && longest(pages(SILENT_CAPTION_WORDS)) >= 4);
  assert.ok(pages(SILENT_CAPTION_WORDS).length < pages().length, "fewer, longer pages than the default of three words");
  // Every word is on some page, in order: the captions are the whole script.
  assert.equal(pages(SILENT_CAPTION_WORDS).flatMap((p) => p.words.map((w) => w.text)).join(" "), PASSAGE.replace(/[.,;:]/g, ""));
});

const hasSay = process.platform === "darwin" && spawnSync("which", ["say"]).status === 0;

test("macOS say speaks each scene to a file whose length holds every word", { skip: !hasSay && "no say here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-voice-"));
  try {
    const spoken = await sayVoice().speak([{ id: "s1", text: "A lever is a stiff bar. It turns on one point." }, { id: "s2", text: "Push down far from it." }], dir);
    for (const s of spoken) {
      assert.ok(s.audio && existsSync(s.audio));
      assert.ok(ordered(s.words));
      assert.ok(s.words[0]!.start >= LEAD - 1e-6);
      assert.ok(s.words.at(-1)!.end <= s.seconds - TAIL + 0.05, `${s.id}: last word ends ${s.words.at(-1)!.end}, file ${s.seconds}`);
      assert.ok(s.words.length / (s.words.at(-1)!.end - s.words[0]!.start) < 4.5, "a natural pace");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
