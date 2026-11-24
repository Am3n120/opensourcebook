import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asSceneWords, DEFAULT_VOICE, elevenlabsCheck, elevenVoice, toWords, trouble, troubleOf, voiceOfStyle, type Tts } from "../src/eleven.ts";
import { LEAD, TAIL, VoiceDown, voiceFromEnv } from "../src/voice.ts";
import { BAD_KEY_400, elevenAnswers, fakeTts } from "./fixtures/voice.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-eleven-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ordered = (words: { start: number; end: number }[]) => words.every((w, i) => w.end >= w.start && (i === 0 || w.start >= words[i - 1]!.end - 1e-6));

test("character times become word times, and punctuation does not stretch a word", () => {
  const text = "Hi, you.";
  const t = [...text].map((_, i) => i * 0.1);
  const words = toWords({ characters: [...text], character_start_times_seconds: t, character_end_times_seconds: t.map((x) => x + 0.1) });
  assert.deepEqual(words.map((w) => w.text), ["Hi,", "you."]);
  assert.ok(Math.abs(words[0]!.end - 0.2) < 1e-9, "the comma's time is not the word's");
});

test("the voice per style is the style file's, and a setting overrides it", () => {
  assert.deepEqual(voiceOfStyle("chalkboard"), DEFAULT_VOICE);
  assert.deepEqual(voiceOfStyle("no-such-style"), DEFAULT_VOICE);
  assert.deepEqual(voiceOfStyle("chalkboard", { id: "other" }), { id: "other", model: DEFAULT_VOICE.model });
});

test("a scene's speech is cut from its quiet and set between the lead and the tail, with words inside the speech", async () => {
  const calls: { text: string; previous_text?: string; next_text?: string }[] = [];
  const voice = elevenVoice({ tts: fakeTts(calls), cacheDir: join(dir, "cache") });
  const segs = [
    { id: "s1", text: "A lever is a stiff bar.", next: "Push down far from it." },
    { id: "s2", text: "Push down far from it.", previous: "A lever is a stiff bar." },
  ];
  const spoken = await voice.speak(segs, join(dir, "voice"), undefined, "chalkboard");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.next_text, "Push down far from it.");
  assert.equal(calls[1]!.previous_text, "A lever is a stiff bar.");
  for (const [i, s] of spoken.entries()) {
    assert.ok(s.audio && existsSync(s.audio));
    assert.equal(s.words.length, segs[i]!.text.split(" ").length);
    assert.ok(ordered(s.words));
    assert.ok(Math.abs(s.words[0]!.start - LEAD) < 0.03, `first word at ${s.words[0]!.start}`);
    // The stretched last word is held to the speech, so the tail is quiet, not a caption hanging on.
    assert.ok(s.words.at(-1)!.end <= s.seconds - TAIL + 0.03, `${s.id}: last word ends ${s.words.at(-1)!.end}, scene ${s.seconds}`);
  }
  // The same words again, with other neighbours, are not paid for twice.
  await voice.speak([{ id: "s1", text: "A lever is a stiff bar." }], join(dir, "voice"));
  assert.equal(calls.length, 2);
  assert.equal(readdirSync(join(dir, "cache")).filter((f) => f.endsWith(".mp3")).length, 2);
});

test("a timed word count that differs from the script still gives the script's words", () => {
  const words = asSceneWords([{ text: "six", start: 0.25, end: 0.5 }], "6.022 times ten");
  assert.deepEqual(words.map((w) => w.text), ["6.022", "times", "ten"]);
  assert.ok(Math.abs(words[0]!.start - 0.25) < 1e-3 && Math.abs(words.at(-1)!.end - 0.5) < 1e-3);
});

test("ElevenLabs is the voice when its key is set, unless another is asked for", () => {
  assert.equal(voiceFromEnv({ ELEVENLABS_API_KEY: "k" }).id, "elevenlabs");
  assert.equal(voiceFromEnv({ ELEVENLABS_API_KEY: "k", SCENES_VOICE: "silent" }).id, "silent");
  assert.throws(() => voiceFromEnv({ SCENES_VOICE: "elevenlabs" }), /needs ELEVENLABS_API_KEY/);
  assert.notEqual(voiceFromEnv({ ELEVENLABS_API_KEY: "k" }).sound("chalkboard"), voiceFromEnv({ ELEVENLABS_API_KEY: "k", SCENES_ELEVENLABS_VOICE: "x" }).sound("chalkboard"));
});

/** A voice call that always fails as ElevenLabs would, counting its tries. */
function failing(error: () => Error, calls: { n: number }): Tts {
  return async () => {
    calls.n += 1;
    throw error();
  };
}

test("a voice out of credits, refused, or not answering says so as VoiceDown, and is not tried again when that cannot help", async () => {
  const credits = { n: 0 };
  const out = elevenVoice({ tts: failing(() => Object.assign(new Error("The ElevenLabs account is out of credits for this narration."), { final: true, trouble: "credits" }), credits), retryMs: 1 });
  await assert.rejects(out.speak([{ id: "s5", text: "Then the bill goes to committee." }], join(dir, "v-credits")), (e: unknown) => e instanceof VoiceDown && e.trouble === "credits" && /out of credits/.test(e.message));
  assert.equal(credits.n, 1, "no credits is not tried again");

  const gone = { n: 0 };
  const away = elevenVoice({ tts: failing(() => Object.assign(new Error("ElevenLabs could not be reached (fetch failed)."), { trouble: "unreachable" }), gone), retryMs: 1 });
  await assert.rejects(away.speak([{ id: "s1", text: "A word." }], join(dir, "v-away")), (e: unknown) => e instanceof VoiceDown && e.trouble === "unreachable");
  assert.equal(gone.n, 3, "no answer is tried again first");

  // A busy voice, or anything about what was sent, is not the voice going away.
  const busy = elevenVoice({ tts: failing(() => new Error("ElevenLabs is busy (too many requests); try again in a minute."), { n: 0 }), retryMs: 1 });
  await assert.rejects(busy.speak([{ id: "s1", text: "A word." }], join(dir, "v-busy")), (e: unknown) => !(e instanceof VoiceDown) && /could not speak s1/.test((e as Error).message));
});

test("a key ElevenLabs refuses with 400, as it really did, is refused and final, with its own words on what to fix", async () => {
  const KEY = "ElevenLabs refused the API key (ELEVENLABS_API_KEY): API key must start with 'sk_'. Fix the key in services/scenes/.env, or remove it to make videos without sound.";
  assert.equal(troubleOf(400, BAD_KEY_400), "refused");
  assert.equal(trouble(400, BAD_KEY_400), KEY);
  const answers = elevenAnswers(400, BAD_KEY_400);
  try {
    // The real call: not tried again, and said as a refused key.
    const voice = elevenVoice({ key: "bad", retryMs: 1 });
    await assert.rejects(voice.speak([{ id: "s1", text: "A word." }], join(dir, "v-badkey")), (e: unknown) => e instanceof VoiceDown && e.trouble === "refused" && e.message === KEY);
    assert.deepEqual(answers.calls, [`/v1/text-to-speech/${DEFAULT_VOICE.id}/with-timestamps`]);
    // The free check says the same, without speaking.
    assert.deepEqual(await elevenlabsCheck("bad")(), { ok: false, trouble: "refused", message: KEY });
  } finally {
    answers.restore();
  }
  // A key allowed to speak but not to read the account is no refused key: the check answers able.
  const narrow = elevenAnswers(401, `{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission user_read."}}`);
  try {
    assert.deepEqual(await elevenlabsCheck("narrow")(), { ok: true });
  } finally {
    narrow.restore();
  }
});

test("ElevenLabs' answers are read as the trouble they are", () => {
  assert.equal(troubleOf(402, ""), "credits");
  assert.equal(troubleOf(401, '{"detail":{"status":"quota_exceeded"}}'), "credits");
  assert.equal(troubleOf(401, '{"detail":{"status":"invalid_api_key"}}'), "refused");
  assert.equal(troubleOf(503, "down"), "unreachable");
  assert.equal(troubleOf(429, "busy"), undefined);
  assert.equal(troubleOf(400, "bad text"), undefined);
});
