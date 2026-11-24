/**
 * Audio: the request check, the whole voicing with a test voice (a tone per part, estimated word times: no network,
 * nothing paid), and the HTTP calls.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { AudioJobs, audioStatus, PART_GAP, readAudioRequest, voiceAudio, type AudioRequest } from "../src/audio.ts";
import { Connector } from "../src/connector.ts";
import { Jobs } from "../src/jobs.ts";
import { createScenesServer } from "../src/server.ts";
import { allStyles, listStyles } from "../src/styles.ts";
import { estimate, sayVoice, silentVoice, type Voice } from "../src/voice.ts";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-audio-"));
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The test voice: a 220 Hz tone as long as the estimate, at 48 kHz mono, and the estimate's word times. */
function toneVoice(o: { wait?: boolean } = {}): Voice & { calls: number } {
  const v = {
    id: "tone",
    label: "Test tone",
    real: true,
    quick: true,
    calls: 0,
    sound: () => "tone",
    async speak(segments: { id: string; text: string }[], folder: string, signal?: AbortSignal) {
      v.calls++;
      mkdirSync(folder, { recursive: true });
      if (o.wait) await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return Promise.all(segments.map(async (s) => {
        const t = estimate(s.text);
        const audio = join(folder, `${s.id}.wav`);
        await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${t.seconds}`, "-ar", "48000", "-ac", "1", audio], { signal });
        return { id: s.id, audio, ...t };
      }));
    },
  };
  return v;
}

const parts = [
  { id: "p1", text: "A lever is a stiff bar that turns on one point." },
  { id: "p2", text: "Push far from the point, and a small push lifts a heavy load!" },
  { id: "p3", text: "That is why a long handle helps. Try it with a door." },
];

const probe = (file: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" }).stdout.trim());
const lufs = (file: string) => {
  const log = spawnSync("ffmpeg", ["-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return Number(JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1)).input_i);
};

test("the request check refuses bad input with problems it names", () => {
  assert.ok("request" in readAudioRequest({ id: "a.1_x-2", title: "Levers", parts }));
  const bad = readAudioRequest({ id: "no spaces/", title: " ", parts: [{ id: "P1", text: "x" }, { id: "p2", text: "" }, { id: "p2", text: "y".repeat(2501) }] });
  assert.ok("problems" in bad);
  const text = bad.problems.join("\n");
  for (const what of ["id:", "title:", "parts[0].id", "parts[1].text", "parts[2].id", "parts[2].text"]) assert.ok(text.includes(what), `${what} in ${text}`);
  assert.ok("problems" in readAudioRequest({ id: "a", title: "t", parts: [] }));
  assert.ok("problems" in readAudioRequest({ id: "a", title: "t", parts: Array.from({ length: 61 }, (_, i) => ({ id: `p${i}`, text: "Hi." })) }));
  assert.ok("problems" in readAudioRequest(undefined));
});

test("with the test voice, three parts are voiced, joined in order, mastered and encoded", async () => {
  const folder = join(dir, "core");
  const steps: string[] = [];
  const request: AudioRequest = { id: "core", title: "Levers", parts };
  const r = await voiceAudio({ request, voice: toneVoice(), folder, kitDir: join(dir, ".kit"), onStep: (_s, _p, step) => steps.push(step) });
  const file = join(folder, "audio.m4a");
  assert.ok(existsSync(file));
  assert.ok(probe(file) > 0);
  assert.equal(r.contentType, "audio/mp4");
  assert.ok(r.bytes > 0 && r.durationMs > 0);
  assert.deepEqual(r.voice, { id: "tone", label: "Test tone", real: true });
  assert.deepEqual(r.parts.map((p) => p.id), ["p1", "p2", "p3"]);
  let last = 0;
  for (const [i, p] of r.parts.entries()) {
    assert.equal(p.words.map((w) => w.text).join(" "), parts[i]!.text);
    for (const w of p.words) {
      assert.ok(w.startMs >= last && w.endMs >= w.startMs, `${p.id} ${w.text} in order`);
      assert.ok(w.startMs >= p.startMs && w.endMs <= p.endMs, `${p.id} ${w.text} inside its part`);
      last = w.startMs;
    }
    if (i) assert.ok(p.startMs - r.parts[i - 1]!.endMs >= PART_GAP * 1000 - 2, "a gap between parts");
  }
  // The fade-out lands after the last word.
  assert.ok(r.durationMs > r.parts.at(-1)!.words.at(-1)!.endMs + 1500);
  assert.ok(Math.abs(r.loudness.lufs + 14) < 1, `mastered at ${r.loudness.lufs}`);
  assert.ok(Math.abs(lufs(file) + 14) < 1.5, "the m4a is near -14 LUFS");
  assert.ok(steps.includes("Voicing part 1 of 3") && steps.includes("Mastering the sound"));
});

/** A server on its own data folder with this voice, and its audio jobs. */
async function service(voice: Voice, name: string) {
  const dataDir = join(dir, name);
  const connector = new Connector({ url: "http://127.0.0.1:9", token: "connector-token-0123456789", model: "small" });
  const jobs = new Jobs({ dataDir, connector, voice, styles: listStyles, callbackBase: () => "", log: () => undefined });
  const audio = new AudioJobs({ dataDir, voice });
  const server = createScenesServer({ token: "scenes-token-0123456789", jobs, audio, connector, voice, styles: allStyles, dataDir });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer scenes-token-0123456789", "content-type": "application/json" } });
  // Mastering holds the service's thread while ffmpeg runs, so on a busy machine a read can be dropped: read again.
  const until = async (id: string, states: string[]) => {
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      const job = await api(`/audio/${id}`).then((r) => r.json(), () => undefined);
      if (job && states.includes(job.state)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${id} never reached ${states.join("/")}`);
  };
  return { api, until, audio, dataDir };
}

test("readiness follows the voice: a real one is ready, a silent one says what to do", async () => {
  assert.deepEqual(audioStatus(sayVoice()), { ready: true });
  const none = audioStatus(silentVoice());
  assert.equal(none.ready, false);
  assert.match((none as { problem: string }).problem, /Settings, under Voice/);

  const real = await service(toneVoice(), "ready");
  assert.deepEqual((await (await real.api("/status")).json()).audio, { ready: true });
  const silent = await service(silentVoice(), "silent");
  const status = await (await silent.api("/status")).json();
  assert.equal(status.audio.ready, false);
  assert.equal(status.audio.problem, none.problem);
  const refused = await silent.api("/audio", { method: "POST", body: JSON.stringify({ id: "a1", title: "Levers", parts }) });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "no_voice", message: none.problem });
});

test("through the server: posted, voiced, kept, the same id again is the same audio, and a restart still finds it", async () => {
  const voice = toneVoice();
  const s = await service(voice, "http");
  assert.equal((await s.api("/audio", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await s.api("/audio/nope")).status, 404);
  const body = JSON.stringify({ id: "a1", title: "Levers", parts });
  const started = await s.api("/audio", { method: "POST", body });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { id: "a1" });
  assert.deepEqual(await (await s.api("/audio", { method: "POST", body })).json(), { id: "a1" });
  const done = await s.until("a1", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(done.progress, 1);
  assert.equal(done.step, "Done");
  assert.equal(done.result.parts.length, 3);
  const file = await s.api("/audio/a1/file");
  assert.equal(file.headers.get("content-type"), "audio/mp4");
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, done.result.bytes);
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp");
  // Done stays done: posting again does not voice it again.
  const calls = voice.calls;
  assert.equal((await s.api("/audio", { method: "POST", body })).status, 202);
  assert.equal(voice.calls, calls);
  assert.equal((await s.api("/audio/a1")).status, 200);
  // A new service on the same folder still has it.
  const again = new AudioJobs({ dataDir: s.dataDir, voice });
  assert.equal(again.get("a1")?.state, "done");
});

test("stop turns a running audio stopped; posting it again starts it again", async () => {
  const s = await service(toneVoice({ wait: true }), "stop");
  const body = JSON.stringify({ id: "a2", title: "Levers", parts });
  assert.equal((await s.api("/audio", { method: "POST", body })).status, 202);
  await s.until("a2", ["voicing"]);
  const stopped = await (await s.api("/audio/a2/stop", { method: "POST" })).json();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.failure.code, "stopped");
  await s.audio.idle();
  assert.equal((await (await s.api("/audio/a2")).json()).state, "stopped");
  assert.equal((await s.api("/audio/a2/file")).status, 409);
  // A job left voicing when the service stopped reads back as failed.
  assert.equal((await s.api("/audio", { method: "POST", body })).status, 202);
  await s.until("a2", ["voicing"]);
  const later = new AudioJobs({ dataDir: s.dataDir, voice: toneVoice() });
  assert.deepEqual(later.get("a2")?.failure, { code: "error", message: "The scenes service stopped while voicing it.", detail: "was voicing" });
  s.audio.stop("a2");
  await s.audio.idle();
});
