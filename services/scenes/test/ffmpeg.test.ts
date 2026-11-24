import assert from "node:assert/strict";
import test from "node:test";
import { ffmpeg } from "../src/ffmpeg.ts";

const slow = ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=600", "-af", "volume=0.5", "-f", "null", "-"];

test("the service keeps answering while ffmpeg works", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await ffmpeg(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=120", "-af", "loudnorm=I=-14:TP=-1.2", "-f", "null", "-"]);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 3, `${ticks} ticks while ffmpeg ran`);
});

test("stopping the job ends ffmpeg", async () => {
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(ffmpeg(slow, { signal: stop.signal }), /stopped/);
  assert.ok(Date.now() - started < 5000);
});

test("a stopped job never starts ffmpeg", async () => {
  await assert.rejects(ffmpeg(slow, { signal: AbortSignal.abort() }), /stopped/);
});

test("a failed ffmpeg says what it said", async () => {
  await assert.rejects(ffmpeg(["-v", "error", "-i", "/no/such/file.wav", "-f", "null", "-"]), /ffmpeg failed: .*no\/such\/file/s);
});

test("input goes in on stdin and output comes back", async () => {
  const pcm = new Float32Array(4800).fill(0.25);
  const { stdout } = await ffmpeg(["-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "pipe:1"], { input: new Uint8Array(pcm.buffer) });
  assert.equal(stdout.byteLength, pcm.byteLength);
});
