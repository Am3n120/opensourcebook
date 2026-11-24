/**
 * The service end to end with a fake connector that plays an agent: it calls the tools through the service's turn
 * callback in the order an agent would, then reports the end. Building, looking and rendering are real; the voice is
 * the silent one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { framesAtOnce, thisMachine } from "../pipeline/lib/frames-at-once.ts";
import { closeRenderer } from "../pipeline/stages/scene.ts";
import { useChrome } from "../src/chrome.ts";
import { Connector } from "../src/connector.ts";
import { agentErrorWords, Jobs, type JobsOptions } from "../src/jobs.ts";
import { createScenesServer } from "../src/server.ts";
import { SpeedBook, useSpeedBook } from "../src/speed.ts";
import { allStyles, listStyles } from "../src/styles.ts";
import { voiceFromEnv, type Voice } from "../src/voice.ts";
import { elevenlabs, elevenlabsCheck, elevenVoice, type Tts } from "../src/eleven.ts";
import { readRequest } from "../src/request.ts";
import { DEFAULT_LIMITS } from "../src/script.ts";
import { callTool, emptyDraft, type ToolAnswer, type ToolContext } from "../src/tools.ts";
import { BAD_KEY_400, elevenAnswers, fakeTts } from "./fixtures/voice.ts";
import { NO_KEY_NOTE } from "../src/voice-choice.ts";
import { passages, script, sources } from "./fixtures/scenes.ts";

useChrome();
const TOKEN = "scenes-token-0123456789";
const CONNECTOR_TOKEN = "connector-token-0123456789";
const dataDir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-service-"));
const servers: Server[] = [];
after(async () => {
  for (const s of servers) s.close();
  await closeRenderer();
  rmSync(dataDir, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Call = (name: string, args: unknown) => Promise<any>;
/** What the fake agent plays: nothing returned reports done; a report returned is sent as the turn's end. */
type Play = (call: Call, start: any) => Promise<void | Record<string, unknown>>;
/**
 * A connector whose agent runs `play` with the turn's tools, then reports its end. It answers whether a turn still runs
 * as a connector does (until its end is sent), unless `running` says otherwise.
 */
async function fakeConnector(play: Play, o: { running?: (turnId: string) => boolean | undefined; replacesWorkPrompt?: boolean } = {}) {
  const starts: any[] = [];
  const stopped: string[] = [];
  const live = new Set<string>();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.headers.authorization !== `Bearer ${CONNECTOR_TOKEN}`) return response.writeHead(401).end();
    if (request.url === "/status") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agent: "fake", model: "small", agents: [{ id: "fake", label: "Fake agent", installed: true, signedIn: true, ...(o.replacesWorkPrompt ? { replacesWorkPrompt: true } : {}) }] }));
    const stop = /^\/turns\/(.+)\/stop$/.exec(request.url ?? "");
    if (stop) {
      stopped.push(decodeURIComponent(stop[1]!));
      return response.writeHead(200).end("{}");
    }
    const one = /^\/turns\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "GET" && one) {
      const id = decodeURIComponent(one[1]!);
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ running: o.running?.(id) ?? live.has(id) }));
    }
    const start = JSON.parse(raw);
    starts.push(start);
    live.add(start.turnId);
    response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, agent: "fake" }));
    const headers = { authorization: `Bearer ${start.callback.token}`, "content-type": "application/json" };
    const call: Call = async (name, args) => (await fetch(`${start.callback.url}/tools`, { method: "POST", headers, body: JSON.stringify({ name, arguments: args }) })).json();
    let outcome = { outcome: "done", text: "made it", model: "small-1" } as Record<string, unknown>;
    try {
      outcome = (await play(call, start)) ?? outcome;
    } catch (e) {
      outcome = { outcome: "failed", problem: (e as Error).message === "stopped" ? "stopped" : "error" };
    }
    live.delete(start.turnId);
    await fetch(`${start.callback.url}/finish`, { method: "POST", headers, body: JSON.stringify(outcome) });
  });
  return { url: await listen(server), starts, stopped };
}

async function service(play: Play, dir = dataDir, more: Partial<JobsOptions> & { running?: (turnId: string) => boolean | undefined; replacesWorkPrompt?: boolean } = {}) {
  const { running, replacesWorkPrompt, ...options } = more;
  const connector = await fakeConnector(play, { ...(running ? { running } : {}), ...(replacesWorkPrompt ? { replacesWorkPrompt } : {}) });
  let base = "";
  const c = new Connector({ url: connector.url, token: CONNECTOR_TOKEN, model: "small" });
  const voice = options.voice ?? voiceFromEnv({});
  const jobs = new Jobs({ dataDir: dir, connector: c, voice, styles: listStyles, callbackBase: () => base, log: () => undefined, ...options });
  base = await listen(createScenesServer({ token: TOKEN, jobs, connector: c, voice, styles: allStyles, dataDir: dir }));
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  // Up to two minutes: a whole job here is two renders and a revise's two more, and the end card is four seconds of
  // every one; a two-core runner renders at about half this Mac's pace.
  const until = async (id: string, states: string[], tries = 1200) => {
    for (let i = 0; i < tries; i++) {
      // A busy computer can reset a kept-alive connection between two polls; the next poll asks again.
      const job = await api(`/videos/${id}`).then((r) => r.json()).catch(() => undefined);
      if (job && states.includes(job.state)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${id} never reached ${states.join("/")}`);
  };
  return { base, api, until, connector, jobs };
}

/** finish's one answer to an agent that never rendered. */
const NEVER_RENDERED = "Not handed over yet. From Open Sourcebook's record of this video:\n- The video was never rendered: it has not existed yet as the viewer will meet it, with the real voice and its pace, the cuts and the captions.\nOpen Sourcebook says this once. Calling finish again hands the video over as it is.";

const body = (id: string, extra = {}) => JSON.stringify({ id, title: "Levers", brief: "how a lever lifts a load", frame: { width: 1080, height: 1920 }, targetSeconds: 12, style: "auto", passages, ...extra });

const agent: (call: Call) => Promise<void> = async (call) => {
  await call("read_passages", { ids: ["p1"] });
  await call("about_video", { title: script.title, idea: script.idea, style: "flat", styleWhy: "plain steps" });
  for (const [i, id] of (["s1", "s2"] as const).entries()) {
    const built = await call("write_beat", { ...script.scenes[i], source: sources[id] });
    if (built.isError) throw new Error(built.text);
    const seen = await call("look", { scene: id });
    if (!seen.images?.length) throw new Error("no stills");
  }
  await call("sound", { music: [], effects: [] });
  await call("finish", {});
};

test("status names the maker, the agent, the voice and every style; previews are pictures", async () => {
  const s = await service(async () => undefined);
  assert.equal((await fetch(`${s.base}/status`)).status, 401);
  const status = await (await s.api("/status")).json();
  assert.equal(status.ok, true);
  assert.equal(status.maker.id, "scenes");
  assert.deepEqual(status.agent, { reachable: true, id: "fake", label: "Fake agent", model: "small" });
  // With no key a video is made without sound, and the status says so in one line, the same line the launcher's check reads.
  assert.deepEqual(status.voice, { id: "silent", label: "No voice (made without sound)", real: false, note: NO_KEY_NOTE });
  assert.ok(status.styles.length >= 7 && status.styles.every((x: any) => x.id && x.label && x.description && typeof x.offered === "boolean"));
  // Every style is listed with whether it is offered; one kept but not offered still has its preview.
  assert.deepEqual(status.styles.filter((x: any) => x.offered).map((x: any) => x.id), listStyles().map((x) => x.id));
  const kept = status.styles.find((x: any) => !x.offered)?.id ?? listStyles()[0]!.id;
  const preview = await s.api(`/styles/${kept}/preview`);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await preview.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
  assert.equal((await s.api("/styles/no-such-style/preview")).status, 404);
  assert.ok(!("speed" in status), "nothing measured, so nothing about time");
});

test("the status carries how fast this computer draws each style once it has been measured, and nothing before", async () => {
  const connector = await fakeConnector(async () => undefined);
  const c = new Connector({ url: connector.url, token: CONNECTOR_TOKEN, model: "small" });
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-speed-status-"));
  const speed = new SpeedBook(join(dir, "speed.json"));
  const base = await listen(createScenesServer({ token: TOKEN, jobs: new Jobs({ dataDir: dir, connector: c, voice: voiceFromEnv({}), styles: listStyles, callbackBase: () => "", log: () => undefined }), connector: c, voice: voiceFromEnv({}), styles: allStyles, dataDir: dir, speed }));
  const status = async () => (await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { speed?: unknown };
  assert.ok(!("speed" in (await status())));
  const [offered] = listStyles();
  speed.record(offered!.id, { fps: 40, frames: 900, concurrency: framesAtOnce(thisMachine()).frames, by: "render", setupSeconds: 7.4 });
  assert.deepEqual((await status()).speed, { [offered!.id]: { framesPerSecond: 40, setupSeconds: 7, measuredBy: "render" } });
  rmSync(dir, { recursive: true, force: true });
});

test("a video is written by the agent through the tools, voiced and rendered; the same id again is the same job", async () => {
  const lines: string[] = [];
  const s = await service(agent, dataDir, { log: (l) => lines.push(l) });
  assert.equal((await s.api("/videos", { method: "POST", body: "{}" })).status, 400);
  const started = await s.api("/videos", { method: "POST", body: body("v1") });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { id: "v1" });
  assert.deepEqual(await (await s.api("/videos", { method: "POST", body: body("v1") })).json(), { id: "v1" });
  const done = await s.until("v1", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(done.progress, 1);
  assert.equal(done.style, "flat");
  assert.ok(done.steps.some((x: any) => x.label === "Drawing scene 2"));
  assert.ok(done.steps.some((x: any) => x.label === "Rendering the video"));
  const r = done.result;
  assert.equal(r.title, "How a lever lifts");
  assert.deepEqual(r.scenes.map((x: any) => x.id), ["s1", "s2"]);
  assert.equal(r.scenes[0].cites[0].sourceId, "src-lever");
  assert.ok(r.scenes.every((x: any) => x.durationMs > 1500 && x.visual.length >= 20));
  assert.deepEqual(r.by, { maker: "scenes", agent: "fake", model: "small-1", style: "flat" });
  // How it was made, from Open Sourcebook's record of the calls: this agent never rendered, so its one finish was answered with that.
  assert.deepEqual(r.making, { passagesRead: ["p1"], skillsRead: [], beatsWritten: 2, beatsRefused: 0, looks: 2, renders: 0, watched: 0, watchedBuilds: 0, reportsRead: 0, changedAfterReport: [], changedAfterRender: [], piecesSearched: [], piecesSearchedBeforeFirstBeat: false, picturesSearched: [], picturesKept: [], soundPlaced: 1, finishCalls: 1, finishAnswer: NEVER_RENDERED, calls: { read_passages: 1, about_video: 1, write_beat: 2, look: 2, sound: 1, finish: 1 }, seen: [], beats: 2, piecesUsed: [], watchedRender: false, readReport: false, finishAnswered: true, handedOver: "after" });
  assert.deepEqual(s.jobs.get("v1")!.making, r.making);
  // finish's answer is in the log whole, and in the record's line, so it can be read afterwards.
  assert.ok(lines.some((l) => l.includes(" finish ok in ") && l.endsWith(NEVER_RENDERED.split("\n").join(" | "))), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("how it was made: ") && l.includes("answered once with facts (The video was never rendered: it has not existed yet")), lines.join("\n"));
  assert.deepEqual(r.voice, { id: "silent", label: "No voice (made without sound)", real: false, note: NO_KEY_NOTE });
  const file = await s.api("/videos/v1/file");
  assert.equal(file.headers.get("content-type"), "video/mp4");
  const mp4 = Buffer.from(await file.arrayBuffer());
  assert.equal(mp4.length, r.file.bytes);
  assert.equal(mp4.subarray(4, 8).toString(), "ftyp");
  // No voice, so no sound: the file carries no audio stream a player could wait on, and its captions carry the words.
  const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", "-"], { input: mp4, encoding: "utf8" }).stdout.trim().split(/[\s,]+/).filter(Boolean);
  assert.deepEqual(streams, ["video"]);
  // The agent got the guide, the tools and a turn of its own.
  const start = s.connector.starts[0];
  assert.match(start.systemPrompt, /# Skills\n.*\n- make-a-video: /);
  assert.equal(start.keepAgentPrompt, true);
  assert.match(start.prompt, /Style: yours to pick/);
  assert.deepEqual(start.tools.map((t: any) => t.name), ["read_passages", "read_skill", "about_video", "write_beat", "look", "render", "watch", "viewer_report", "sound", "finish", "find_piece", "save_piece"]);
  // No clock: the turn runs until the agent finishes or the person stops it.
  assert.equal(start.timeoutMs, 0);
  assert.deepEqual(start.target, { type: "video", id: "v1" });
  // A tool call with a wrong token is not taken.
  assert.equal((await fetch(`${start.callback.url}/tools`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status, 404);
});

test("each turn gives the agent the skills' pages whole, and its log says how large the system prompt and first message are; the setting gives the index alone", async () => {
  for (const knowledge of [true, false]) {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-knowledge-"));
    const s = await service(async () => undefined, dir, { knowledge, log: (l) => lines.push(l) });
    assert.equal((await s.api("/videos", { method: "POST", body: body("k1", { style: "ink" }) })).status, 202);
    await s.until("k1", ["failed", "done"]);
    const start = s.connector.starts[0];
    const said = lines.find((l) => / gives the agent a system prompt of about /.test(l));
    assert.ok(said, lines.join("\n"));
    const [, sys, sysChars, first, firstChars] = /system prompt of about (\d+) tokens \((\d+) characters.*first message of about (\d+) tokens \((\d+) characters\)/.exec(said!)!;
    assert.equal(Number(sysChars), start.systemPrompt.length);
    assert.equal(Number(sys), Math.round(start.systemPrompt.length / 4));
    assert.equal(Number(firstChars), start.prompt.length);
    assert.equal(Number(first), Math.round(start.prompt.length / 4));
    if (knowledge) {
      assert.match(start.systemPrompt, /<page file="skills\/teaching\/references\/attention\.md">/);
      assert.match(start.systemPrompt, /written for this video's style, ink/);
      assert.match(said!, /the skills' pages given whole/);
    } else {
      assert.doesNotMatch(start.systemPrompt, /<page file=/);
      assert.match(said!, /the index of skills only/);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent declaring replacesWorkPrompt replaces its built-in prompt unless keepAgentPrompt overrides it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-replace-"));
  const replaced = await service(async () => undefined, dir, { replacesWorkPrompt: true });
  assert.equal((await replaced.api("/videos", { method: "POST", body: body("rw1") })).status, 202);
  await replaced.until("rw1", ["failed", "done"]);
  assert.equal(replaced.connector.starts[0].keepAgentPrompt, false);

  const kept = await service(async () => undefined, dir, { replacesWorkPrompt: true, keepAgentPrompt: true });
  assert.equal((await kept.api("/videos", { method: "POST", body: body("rw2") })).status, 202);
  await kept.until("rw2", ["failed", "done"]);
  assert.equal(kept.connector.starts[0].keepAgentPrompt, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a render says how long it will take here when this computer has drawn the style before, and adds its own speed to what it keeps", async () => {
  const speed = new SpeedBook();
  const concurrency = framesAtOnce(thisMachine()).frames;
  // Flat was measured here at 2 frames a second, so the few hundred frames of this video take minutes.
  speed.record("flat", { fps: 2, frames: 60, concurrency, by: "measured", setupSeconds: 0 });
  useSpeedBook(speed);
  try {
    const s = await service(agent);
    assert.equal((await s.api("/videos", { method: "POST", body: body("timed") })).status, 202);
    const done = await s.until("timed", ["done", "failed"]);
    assert.equal(done.state, "done", JSON.stringify(done.failure));
    const said = done.steps.map((x: any) => x.label).find((l: string) => /^Drawing the video, /.test(l));
    assert.match(said, /^Drawing the video, (under a minute|about \d+ minutes?|about a minute) on this computer$/);
    assert.ok(done.steps.map((x: any) => x.label).includes("Rendering the video"));
    // The render measured itself, and a real render outranks the short measure it started from.
    const after = speed.speed("flat", concurrency)!;
    assert.equal(after.by, "render");
    assert.notEqual(after.fps, 2);
  } finally {
    useSpeedBook(undefined);
  }
});

test("an agent that renders and watches its video before finishing hands the person that very file, with no second render", async () => {
  let watched = "";
  const s = await service(async (call) => {
    await call("read_passages", { ids: ["p1"] });
    await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
    for (const [i, id] of (["s1", "s2"] as const).entries()) {
      const built = await call("write_beat", { ...script.scenes[i], source: sources[id] });
      if (built.isError) throw new Error(built.text);
    }
    const made = await call("render", {});
    if (made.isError) throw new Error(made.text);
    const seen = await call("watch", {});
    if (seen.isError || !seen.images?.length) throw new Error(seen.text);
    watched = seen.text;
    await call("finish", {});
  });
  await s.api("/videos", { method: "POST", body: body("v-cut") });
  const done = await s.until("v-cut", ["done", "failed"], 3000);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.match(watched, /^Cut 1: /);
  assert.ok(done.steps.some((x: any) => x.label === "Making a first cut for your agent to watch"));
  assert.ok(!done.steps.some((x: any) => x.label === "Rendering the video"), "no render after the agent's");
  const mp4 = Buffer.from(await (await s.api("/videos/v-cut/file")).arrayBuffer());
  assert.equal(mp4.length, done.result.file.bytes);
  assert.deepEqual(done.result.scenes.map((x: any) => x.id), ["s1", "s2"]);
});

test("a done video can be revised with Open Sourcebook's checker's problems: a new turn hears them and starts from the draft", async () => {
  let round = 0;
  const s = await service(async (call, start) => {
    round += 1;
    if (round === 1) return agent(call);
    assert.match(start.prompt, /Open Sourcebook's own checker refused it/);
    assert.match(start.prompt, /scene 2 runs too fast/);
    await call("write_beat", { beat: "s2", narration: "Push down far from the fulcrum, and the heavy load near it slowly rises." });
    await call("look", { scene: "s2" });
    await call("finish", {});
  });
  await s.api("/videos", { method: "POST", body: body("v2") });
  await s.until("v2", ["done", "failed"]);
  assert.equal((await s.api("/videos/v2/revise", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await s.api("/videos/v2/revise", { method: "POST", body: JSON.stringify({ problems: ["scene 2 runs too fast"] }) })).status, 202);
  const done = await s.until("v2", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.match(done.result.scenes[1].narration, /slowly rises/);
  assert.equal(s.connector.starts.length, 2);
});

test("one scene of a done video is made again as a new video copied from it, in the person's words, and the old one plays until it is done", async () => {
  let round = 0;
  let release: () => void = () => undefined;
  const s = await service(async (call, start) => {
    round += 1;
    if (round === 1) return agent(call);
    // A remake of the remake, stopped before it does anything.
    if (round > 2) return new Promise<void>(() => undefined);
    assert.match(start.prompt, /asked for one scene of it to be made again: beat s2 \(scene 2 of 2\)/);
    assert.match(start.prompt, /in their own words: "show the load rising, not a box"/);
    assert.match(start.prompt, /The rest of the video stays as it is/);
    assert.doesNotMatch(start.prompt, /checker refused/);
    await new Promise<void>((resolve) => (release = resolve));
    await call("write_beat", { beat: "s2", narration: "Push down far from the fulcrum, and the heavy load near it slowly rises." });
    await call("look", { scene: "s2" });
    await call("finish", {});
  });
  await s.api("/videos", { method: "POST", body: body("v-old") });
  const old = await s.until("v-old", ["done", "failed"]);
  assert.equal(old.state, "done", JSON.stringify(old.failure));
  assert.equal(old.draft, true);
  const remake = (extra: Record<string, unknown>, id = "v-old") => s.api(`/videos/${id}/remake-scene`, { method: "POST", body: JSON.stringify({ id: "v-new", beat: "s2", ...extra }) });

  assert.equal((await s.api("/videos/v-old/remake-scene", { method: "POST", body: JSON.stringify({ beat: "s2" }) })).status, 400);
  assert.equal((await remake({ beat: "s9" })).status, 404);
  assert.equal((await remake({}, "v-none")).status, 404);
  const started = await remake({ note: "show the load rising, not a box" });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { id: "v-new" });
  // The same id again is the same remake.
  assert.equal((await remake({ note: "again" })).status, 202);

  // While the new one is made, the old one is as it was: done, with its file.
  for (let i = 0; i < 200 && round < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const making = await (await s.api("/videos/v-new")).json();
  assert.equal(making.state, "writing");
  assert.deepEqual(making.remakeOf, { id: "v-old", beat: "s2" });
  assert.equal(existsSync(join(dataDir, "v-new", "video.mp4")), false);
  assert.equal((await (await s.api("/videos/v-old")).json()).state, "done");
  assert.equal((await s.api("/videos/v-old/file")).status, 200);
  // The copy's paths point into its own folder.
  assert.ok(!readFileSync(join(dataDir, "v-new", "draft.json"), "utf8").includes(join(dataDir, "v-old")));
  release();

  const done = await s.until("v-new", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(done.result.scenes[0].narration, old.result.scenes[0].narration);
  assert.match(done.result.scenes[1].narration, /slowly rises/);
  assert.equal((await (await s.api("/videos/v-old")).json()).result.scenes[1].narration, old.result.scenes[1].narration);

  // Not done yet, or its draft gone: refused in plain words.
  assert.equal((await s.api("/videos/v-new/remake-scene", { method: "POST", body: JSON.stringify({ id: "v-new-2", beat: "s1" }) })).status, 202);
  const busy = await s.api("/videos/v-new-2/remake-scene", { method: "POST", body: JSON.stringify({ id: "v-new-3", beat: "s1" }) });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, "not_done");
  await s.api("/videos/v-new-2/stop", { method: "POST" });
  rmSync(join(dataDir, "v-old", "draft.json"));
  assert.equal((await (await s.api("/videos/v-old")).json()).draft, false);
  const gone = await s.api("/videos/v-old/remake-scene", { method: "POST", body: JSON.stringify({ id: "v-other", beat: "s2" }) });
  assert.equal(gone.status, 409);
  assert.deepEqual(await gone.json(), { error: "draft_gone", message: "This video's draft is no longer on this computer, so one scene of it cannot be made again. Make the whole video again instead." });
});

test("stopping a video stops the agent's turn", async () => {
  let release: () => void = () => undefined;
  const s = await service(async (call) => {
    await call("read_passages", { ids: ["p1"] });
    await new Promise<void>((resolve) => (release = resolve));
    throw new Error("stopped");
  });
  await s.api("/videos", { method: "POST", body: body("v3") });
  for (let i = 0; i < 100 && !s.connector.starts.length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const stopped = await (await s.api("/videos/v3/stop", { method: "POST" })).json();
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.failure, { code: "stopped", message: "Stopped." });
  assert.deepEqual(s.connector.stopped, ["v3-1"]);
  release();
  assert.equal((await s.api("/videos/v3/revise", { method: "POST", body: JSON.stringify({ problems: ["x"] }) })).status, 409);
});

test("an agent whose turn ends in an error of its own before any tool call fails as that, with its own words and what to do, never as a refused script", async () => {
  const said = "The 'small' model is not supported when using this agent with your account.";
  const s = await service(async () => ({ outcome: "failed", problem: "error", said, toolCalls: 0 }));
  await s.api("/videos", { method: "POST", body: body("v-err") });
  const failed = await s.until("v-err", ["done", "failed"]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "agentError");
  assert.equal(failed.failure.said, said);
  assert.match(failed.failure.message, /stopped with an error of its own before it did any work/);
  assert.match(failed.failure.message, /It said: "The 'small' model is not supported/);
  assert.match(failed.failure.message, /model "small" \(SCENES_AGENT_MODEL\): set one your agent offers, or leave it empty for its own default/);
  // The same end after the agent had called a tool is not this: it did work, and its missing script is said as before.
  const t = await service(async (call) => {
    await call("read_passages", { ids: ["p1"] });
    return { outcome: "failed", problem: "error", said };
  });
  await t.api("/videos", { method: "POST", body: body("v-err2") });
  assert.equal((await t.until("v-err2", ["done", "failed"])).failure.code, "scriptRefused");
});

test("an agent that ends without a script fails as refused; an unreachable connector fails plainly", async () => {
  const s = await service(async (call) => {
    await call("read_passages", { ids: ["p1"] });
  });
  await s.api("/videos", { method: "POST", body: body("v4") });
  const refused = await s.until("v4", ["failed", "done"]);
  assert.equal(refused.failure.code, "scriptRefused");
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-gone-"));
  const c = new Connector({ url: "http://127.0.0.1:9", token: CONNECTOR_TOKEN });
  const jobs = new Jobs({ dataDir: dir, connector: c, voice: voiceFromEnv({}), styles: listStyles, callbackBase: () => "http://127.0.0.1:1", log: () => undefined });
  jobs.create({ id: "v5", title: "Levers", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, style: "auto", passages, limits: DEFAULT_LIMITS });
  for (let i = 0; i < 100 && jobs.get("v5")!.state === "writing"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(jobs.get("v5")!.failure?.code, "agentUnreachable");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Carrying a video on: after this service restarts, after a dropped turn, and when the engine resumes it.

const request = (id: string) => {
  const read = readRequest(JSON.parse(body(id)), allStyles().map((s) => s.id));
  if ("problems" in read) throw new Error(read.problems.join(" "));
  return read.request;
};
const record = (id: string, state: string, extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return { id, request: request(id), state, progress: 0.4, step: "Your agent is writing", steps: [], timings: { writingMs: 0, voiceMs: 0, buildMs: 0, renderMs: 0, toolCalls: 0, turns: 1 }, createdAt: now, updatedAt: now, ...extra };
};

/** A job left on disk as a service that stopped mid-way leaves it: its job.json, and a draft made by the real tools. */
async function leftOnDisk(dir: string, id: string, state: string, voice: Voice, play: (call: (name: string, args: unknown) => Promise<ToolAnswer>) => Promise<void>, extra: Record<string, unknown> = {}) {
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  const draft = emptyDraft();
  const ctx: ToolContext = { request: request(id), draft, folder, styles: listStyles(), voice, step: () => undefined, save: () => writeFileSync(join(folder, "draft.json"), JSON.stringify(draft)) };
  await play(async (name, args) => {
    const answer = await callTool(name, args, ctx);
    if (answer.isError) throw new Error(answer.text);
    return answer;
  });
  ctx.save();
  writeFileSync(join(folder, "job.json"), JSON.stringify(record(id, state, extra)));
}

const firstBeat = async (call: (name: string, args: unknown) => Promise<ToolAnswer>) => {
  await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
  await call("write_beat", { ...script.scenes[0], source: sources.s1 });
  await call("look", { scene: "s1" });
};
const bothBeats = async (call: (name: string, args: unknown) => Promise<ToolAnswer>) => {
  await firstBeat(call);
  await call("write_beat", { ...script.scenes[1], source: sources.s2 });
  await call("finish", {});
};
const fast = { resumeDelaysMs: [20, 40, 60], connectorWait: { everyMs: 20, forMs: 400 } };

test("a restart mid-writing carries the video on: a new turn is told the beats that exist, and the video is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-restart-"));
  await leftOnDisk(dir, "w1", "writing", voiceFromEnv({}), firstBeat);
  mkdirSync(join(dir, "d1"), { recursive: true });
  writeFileSync(join(dir, "d1", "job.json"), JSON.stringify(record("d1", "done")));
  const s = await service(async (call, start) => {
    assert.match(start.prompt, /your turn was cut off \(the service restarted\)/);
    assert.match(start.prompt, /s1: "A lever is a stiff bar that turns on one fixed point, the fulcrum\.", its picture builds and you looked at it\./);
    assert.match(start.prompt, /Style: flat \(your pick\)/);
    assert.match(start.prompt, /there is no need to start over/);
    await call("write_beat", { ...script.scenes[1], source: sources.s2 });
    await call("look", { scene: "s2" });
    await call("finish", {});
  }, dir, fast);
  assert.equal(s.jobs.get("d1")!.state, "done", "a finished video stays as it is");
  assert.equal(s.jobs.get("w1")!.state, "writing");
  const done = await s.until("w1", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.deepEqual(done.result.scenes.map((x: any) => x.id), ["s1", "s2"]);
  assert.ok(done.steps.some((x: any) => x.label === "Carrying on after a restart"));
  assert.equal(s.connector.starts.length, 1);
  assert.equal(s.connector.starts[0].turnId, "w1-2");
  assert.equal(JSON.parse(readFileSync(join(dir, "w1", "job.json"), "utf8")).resumes, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a restart mid-voicing makes the video again without speaking again the lines already spoken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-revoice-"));
  const calls: { text: string }[] = [];
  // No cache: a line spoken again would reach the voice again.
  const voice = elevenVoice({ tts: fakeTts(calls) });
  await leftOnDisk(dir, "v1", "voicing", voice, bothBeats);
  assert.equal(calls.length, 2, "each beat was spoken once while it was written");
  const s = await service(async () => assert.fail("no turn: the writing was done"), dir, { ...fast, voice });
  const done = await s.until("v1", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(calls.length, 2, "nothing was spoken again");
  assert.equal(done.result.voice.real, true);
  assert.equal(s.connector.starts.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a video cut off by restarts three times fails plainly the fourth, and keeps what was made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-bound-"));
  await leftOnDisk(dir, "b1", "writing", voiceFromEnv({}), firstBeat, { resumes: 3 });
  const s = await service(async () => assert.fail("no turn"), dir, fast);
  const job = s.jobs.get("b1")!;
  assert.equal(job.state, "failed");
  assert.equal(job.failure!.code, "error");
  assert.equal(job.failure!.message, "This video was cut off 3 times while it was being made. What was made is kept: try again to carry on from there.");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.connector.starts.length, 0);
  assert.ok(JSON.parse(readFileSync(join(dir, "b1", "draft.json"), "utf8")).script.scenes.length === 1);
  rmSync(dir, { recursive: true, force: true });
});

test("stopping a video while it waits to carry on stops it: no new turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-stopwait-"));
  await leftOnDisk(dir, "x1", "writing", voiceFromEnv({}), firstBeat);
  const s = await service(async () => undefined, dir, { resumeDelaysMs: [400] });
  const stopped = await (await s.api("/videos/x1/stop", { method: "POST" })).json();
  assert.equal(stopped.state, "stopped");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(s.jobs.get("x1")!.state, "stopped");
  assert.equal(s.connector.starts.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a turn the connector dropped (it says the turn no longer runs, and no end comes) is carried on", async () => {
  let release: () => void = () => undefined;
  const s = await service(
    async (call, start) => {
      if (start.turnId === "dropped-1") {
        await call("read_passages", { ids: ["p1"] });
        await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error("stopped");
      }
      assert.match(start.prompt, /your turn was cut off \(your agent's turn ended\)/);
      return agent(call);
    },
    dataDir,
    { ...fast, heartbeat: { everyMs: 20, endedMs: 300, silentMs: 600, sleptMs: 5_000 }, running: (id) => (id === "dropped-1" ? false : undefined) },
  );
  await s.api("/videos", { method: "POST", body: body("dropped") });
  const done = await s.until("dropped", ["done", "failed"]);
  release();
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.ok(done.steps.some((x: any) => x.label === "Carrying on after a restart"));
  assert.deepEqual(s.connector.starts.map((x: any) => x.turnId), ["dropped-1", "dropped-2"]);
  assert.ok(s.connector.stopped.includes("dropped-1"));
  assert.equal(JSON.parse(readFileSync(join(dataDir, "dropped", "job.json"), "utf8")).resumes, 1);
});

test("an agent that calls none of Open Sourcebook's tools for the idle time is stopped as hung, its work kept and said plainly; one that keeps calling slowly is not", async () => {
  let release: () => void = () => undefined;
  const s = await service(
    async (call, start) => {
      if (start.turnId === "hung-1") {
        await call("read_passages", { ids: ["p1"] });
        await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
        await call("write_beat", { ...script.scenes[0], source: sources.s1 });
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error("stopped");
      }
      return agent(call);
    },
    dataDir,
    { ...fast, heartbeat: { everyMs: 20, endedMs: 60_000, silentMs: 60_000, sleptMs: 5_000, idleMs: 400 } },
  );
  await s.api("/videos", { method: "POST", body: body("hung") });
  const failed = await s.until("hung", ["done", "failed"]);
  release();
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "timedOut");
  assert.match(failed.failure.message, /did nothing for \d+ minutes \(no call to Open Sourcebook's tools\), so Open Sourcebook stopped its turn as hung\. What it made \(one beat\) is kept: try again to carry on from there\./);
  assert.ok(s.connector.stopped.includes("hung-1"));
  // Trying again carries it on from the draft, in a new turn told why the last one ended.
  assert.ok((await s.api("/videos/hung/resume", { method: "POST" })).ok);
  const done = await s.until("hung", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.match(s.connector.starts[1].prompt, /called none of Open Sourcebook's tools for a long time/);

  // Slow but working: a call every so often, each gap shorter than the idle time, for longer than it in all.
  const slow = await service(
    async (call) => {
      for (let i = 0; i < 4; i++) {
        await call("read_passages", { ids: ["p1"] });
        await new Promise((r) => setTimeout(r, 200));
      }
      return agent(call);
    },
    dataDir,
    { ...fast, heartbeat: { everyMs: 20, endedMs: 60_000, silentMs: 60_000, sleptMs: 5_000, idleMs: 400 } },
  );
  await slow.api("/videos", { method: "POST", body: body("slow") });
  const made = await slow.until("slow", ["done", "failed"]);
  assert.equal(made.state, "done", JSON.stringify(made.failure));
});

test("a gap between checks as long as a sleep is not counted: the turn's own end still comes through", async () => {
  let offset = 0;
  const s = await service(
    async (call) => {
      await new Promise((r) => setTimeout(r, 100));
      // The computer slept: an hour passes between two checks.
      offset = 3_600_000;
      await new Promise((r) => setTimeout(r, 150));
      await call("read_passages", { ids: ["p1"] });
    },
    dataDir,
    { ...fast, heartbeat: { everyMs: 20, endedMs: 400, silentMs: 400, sleptMs: 1_000 }, running: () => false, now: () => Date.now() + offset },
  );
  await s.api("/videos", { method: "POST", body: body("slept") });
  const job = await s.until("slept", ["done", "failed"]);
  // The end came and was taken (no script), rather than the turn being counted gone over the hour.
  assert.equal(job.failure.code, "scriptRefused");
  assert.equal(s.connector.starts.length, 1);
  assert.ok(!job.steps.some((x: any) => x.label === "Carrying on after a restart"));
});

test("a usage limit keeps when the agent said it resets; resume carries the video on from its draft", async () => {
  const limit = { resetsAt: "2026-11-18T15:00:00.000Z", resets: "3pm (Europe/Berlin)" };
  const s = await service(async (call, start) => {
    if (start.turnId === "limited-1") {
      await call("read_passages", { ids: ["p1"] });
      await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
      // Its words, not yet its picture: the video is not done when the limit comes.
      await call("write_beat", { ...script.scenes[0] });
      return { outcome: "failed", problem: "agentLimit", limit, text: "limit reached" };
    }
    assert.match(start.prompt, /your turn was cut off \(your agent's plan reached its limit\)/);
    assert.match(start.prompt, /s1: "A lever is a stiff bar[^\n]*", no picture yet\./);
    await call("write_beat", { beat: "s1", source: sources.s1 });
    await call("look", { scene: "s1" });
    await call("write_beat", { ...script.scenes[1], source: sources.s2 });
    await call("look", { scene: "s2" });
    await call("finish", {});
  });
  await s.api("/videos", { method: "POST", body: body("limited") });
  const failed = await s.until("limited", ["failed", "done"]);
  assert.equal(failed.failure.code, "agentLimit");
  assert.deepEqual(failed.failure.limit, limit);
  assert.equal((await s.api("/videos/nope/resume", { method: "POST" })).status, 404);
  const resumed = await s.api("/videos/limited/resume", { method: "POST" });
  assert.equal(resumed.status, 200);
  const view = await resumed.json();
  assert.equal(view.state, "writing");
  assert.equal(view.failure, undefined);
  const again = await s.api("/videos/limited/resume", { method: "POST" });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /this one is writing/);
  const done = await s.until("limited", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.deepEqual(done.result.scenes.map((x: any) => x.id), ["s1", "s2"]);
  assert.equal(s.connector.starts.length, 2);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "limited", "job.json"), "utf8")).resumes ?? 0, 0, "a resume asked for does not count");
  assert.equal((await s.api("/videos/limited/resume", { method: "POST" })).status, 409);
});

test("a turn cut off by a usage limit with every scene built is not delivered unseen: it waits, and a resume carries the writing on", async () => {
  const s = await service(async (call, start) => {
    if (start.turnId === "unseen-1") {
      await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
      await call("write_beat", { ...script.scenes[0], source: sources.s1 });
      await call("write_beat", { ...script.scenes[1], source: sources.s2 });
      // Every scene builds, but the agent has not looked, rendered or finished when its plan's limit comes.
      return { outcome: "failed", problem: "agentLimit", text: "limit reached" };
    }
    assert.match(start.prompt, /your agent's plan reached its limit/);
    await call("look", { scene: "s1" });
    await call("finish", {});
  });
  await s.api("/videos", { method: "POST", body: body("unseen") });
  const failed = await s.until("unseen", ["failed", "done"]);
  assert.equal(failed.state, "failed", "no video is made from a draft the agent never judged done");
  assert.equal(failed.failure.code, "agentLimit");
  assert.equal(existsSync(join(dataDir, "unseen", "video.mp4")), false);
  assert.equal((await s.api("/videos/unseen/resume", { method: "POST" })).status, 200);
  const done = await s.until("unseen", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(s.connector.starts.length, 2);
});

test("a start the connector refuses for a usage limit fails with when the agent said it resets", async () => {
  const limit = { resetsAt: "2026-11-18T15:00:00.000Z", resets: "3pm" };
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    if (request.url === "/status") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agent: "fake", agents: [{ id: "fake", label: "Fake agent", installed: true, signedIn: true }] }));
    response.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ problem: "agentLimit", message: "Fake agent has used up its plan's usage for now.", limit: { since: "2026-11-18T12:00:00.000Z", ...limit } }));
  });
  const url = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-429-"));
  const jobs = new Jobs({ dataDir: dir, connector: new Connector({ url, token: CONNECTOR_TOKEN }), voice: voiceFromEnv({}), styles: listStyles, callbackBase: () => "http://127.0.0.1:1", log: () => undefined });
  jobs.create(request("l429"));
  for (let i = 0; i < 100 && jobs.get("l429")!.state === "writing"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobs.get("l429")!.failure?.code, "agentLimit");
  assert.deepEqual(jobs.get("l429")!.failure?.limit, limit);
  rmSync(dir, { recursive: true, force: true });
});

/** An ElevenLabs voice that runs out of credits when `out` is set, as the real account does, and says so when asked. */
function runningOut() {
  const state = { out: false, calls: 0 };
  const speak = fakeTts();
  const OUT = "The ElevenLabs account is out of credits for this narration.";
  const tts: Tts = async (v, req, signal) => {
    state.calls += 1;
    if (state.out) throw Object.assign(new Error(OUT), { final: true, trouble: "credits" });
    return speak(v, req, signal);
  };
  const voice = elevenVoice({ tts, retryMs: 1, check: async () => (state.out ? { ok: false, trouble: "credits", message: OUT } : { ok: true }) });
  return { state, voice, OUT };
}

/**
 * An ElevenLabs voice whose key goes bad when `out` is set: from then on the real call and the real free check read
 * what ElevenLabs answers (`elevenAnswers` makes that its real 400 for a malformed key).
 */
function keyGoesBad() {
  const state = { out: false, calls: 0 };
  const speak = fakeTts();
  const real = elevenlabs("bad-key");
  const check = elevenlabsCheck("bad-key");
  const tts: Tts = async (v, req, signal) => {
    state.calls += 1;
    return state.out ? real(v, req, signal) : speak(v, req, signal);
  };
  const voice = elevenVoice({ tts, retryMs: 1, check: async () => (state.out ? check() : { ok: true }) });
  return { state, voice, OUT: "ElevenLabs refused the API key (ELEVENLABS_API_KEY): API key must start with 'sk_'. Fix the key in services/scenes/.env, or remove it to make videos without sound." };
}

/** An agent whose voice runs out after the first beat, and what each of its calls was answered. */
async function outMidway(id: string, v: { state: { out: boolean; calls: number }; voice: Voice; OUT: string } = runningOut()) {
  const said: Record<string, any> = {};
  const s = await service(async (call) => {
    await call("about_video", { title: script.title, idea: script.idea, style: "flat" });
    said.one = await call("write_beat", { ...script.scenes[0], source: sources.s1 });
    v.state.out = true;
    said.two = await call("write_beat", { ...script.scenes[1], source: sources.s2 });
    said.again = await call("write_beat", { beat: "s2", narration: "Push down far from it, and the big load near it rises." });
    said.render = await call("render", {});
    await call("look", { scene: "s1" });
    await call("look", { scene: "s2" });
    said.finish = await call("finish", {});
    said.calls = v.state.calls;
  }, dataDir, { voice: v.voice });
  await s.api("/videos", { method: "POST", body: body(id) });
  const failed = await s.until(id, ["failed", "done"]);
  return { s, v, said, failed };
}

test("a voice that runs out mid-video is said to the agent once as a fact; it writes on by the estimate, and the video waits with its draft kept until the voice is back", async () => {
  const { s, v, said, failed } = await outMidway("outmid");
  assert.ok(!said.one.isError && !/cannot speak/.test(said.one.text));
  // Told once, as a fact, with the beat still taken and built: no "try once more".
  assert.ok(!said.two.isError, said.two.text);
  assert.ok(said.two.text.startsWith(`The voice cannot speak: ${v.OUT.replace(/\.$/, "")}. Trying again will not help, so Open Sourcebook has stopped asking it for this video; nothing you wrote is lost.\n`), said.two.text);
  assert.match(said.two.text, /Once the voice is back, Open Sourcebook voices it/);
  assert.match(said.two.text, /the person may choose to finish it without sound/);
  assert.match(said.two.text, /s2 \([^)]*\), [\d.]+ s by the estimate \(the voice cannot speak for now\):/);
  assert.match(said.two.text, /Its picture builds/);
  assert.doesNotMatch(said.two.text, /Try once more/);
  // Not said again, and the voice is not asked again while the agent writes.
  assert.doesNotMatch(said.again.text, /Trying again will not help/);
  assert.match(said.again.text, /by the estimate \(the voice cannot speak for now\)/);
  assert.equal(said.calls, 2, "one call for s1, the one that failed for s2, none after");
  assert.ok(said.render.isError);
  assert.equal(said.render.text, `The voice cannot speak for now (${v.OUT.replace(/\.$/, "")}), so no render can be made. Keep writing and building beats; finish when they are ready, and the video waits for the voice.`);
  assert.equal(said.finish.text, "The video is taken. The voice cannot speak for now, so it is not voiced or rendered yet: it waits for the voice, and the person is told why and that they may finish it without sound instead. Stop now.");
  // The video waits for the voice: failed as that, never as something that went wrong, with nothing lost.
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "voiceDown");
  assert.equal(failed.failure.voice, "credits");
  assert.equal(failed.failure.message, "The voice could not speak. What was made is kept: the video carries on once the voice can speak again, or it can be finished without sound.");
  assert.equal(existsSync(join(dataDir, "outmid", "video.mp4")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "outmid", "draft.json"), "utf8")).script.scenes.map((x: any) => x.id), ["s1", "s2"]);
  // The engine can ask whether the voice is back, for free.
  assert.deepEqual(await (await s.api("/voice")).json(), { ok: false, trouble: "credits", message: v.OUT });
  v.state.out = false;
  assert.deepEqual(await (await s.api("/voice")).json(), { ok: true });
  // With the voice back, a resume voices it and renders, with no new turn of the agent: its writing was finished.
  assert.equal((await s.api("/videos/outmid/resume", { method: "POST" })).status, 200);
  const done = await s.until("outmid", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.equal(done.result.voice.id, "elevenlabs");
  assert.equal(done.result.voice.real, true);
  assert.equal(s.connector.starts.length, 1);
});

test("a video waiting for its voice is finished without sound when the person asks: captions carry the words, and it says why it has none", async () => {
  const { s, failed } = await outMidway("outsilent");
  assert.equal(failed.failure.code, "voiceDown");
  const resumed = await s.api("/videos/outsilent/resume", { method: "POST", body: JSON.stringify({ withoutSound: true }) });
  assert.equal(resumed.status, 200);
  const done = await s.until("outsilent", ["done", "failed"]);
  assert.equal(done.state, "done", JSON.stringify(done.failure));
  assert.deepEqual(done.result.voice, {
    id: "silent",
    label: "No voice (made without sound)",
    real: false,
    note: "Made without sound, as you chose, because the voice could not speak (The ElevenLabs account is out of credits for this narration); the captions carry the words. Once the voice can speak again, make it again for the full video with sound.",
  });
  assert.equal(s.connector.starts.length, 1);
  const mp4 = Buffer.from(await (await s.api("/videos/outsilent/file")).arrayBuffer());
  const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", "-"], { input: mp4, encoding: "utf8" }).stdout.trim().split(/[\s,]+/).filter(Boolean);
  assert.deepEqual(streams, ["video"]);
});

test("a voice that runs out while the finished video is voiced makes it wait the same way, its draft kept", async () => {
  const v = runningOut();
  // A voice that speaks only once the writing ends, so the out comes at the final voicing.
  const s = await service(async (call) => {
    v.state.out = true;
    await agent(call);
  }, dataDir, { voice: { ...v.voice, quick: false } });
  await s.api("/videos", { method: "POST", body: body("outlate") });
  const failed = await s.until("outlate", ["failed", "done"]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "voiceDown");
  assert.equal(failed.failure.voice, "credits");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "outlate", "draft.json"), "utf8")).voiceDown.trouble, "credits");
});

test("a key ElevenLabs refuses with a 400, as it really did, is said once with its own words mid-video, and the video waits; the free check says the same", async () => {
  const answers = elevenAnswers(400, BAD_KEY_400);
  try {
    const v = keyGoesBad();
    const { s, said, failed } = await outMidway("badkeymid", v);
    assert.ok(!said.two.isError, said.two.text);
    assert.ok(said.two.text.startsWith(`The voice cannot speak: ${v.OUT.replace(/\.$/, "")}. Trying again will not help`), said.two.text);
    assert.doesNotMatch(said.two.text, /Try once more/);
    assert.doesNotMatch(said.again.text, /Trying again will not help/);
    // The bad key was asked once, never again for this video.
    assert.equal(said.calls, 2);
    assert.equal(failed.failure.code, "voiceDown");
    assert.equal(failed.failure.voice, "refused");
    assert.match(failed.failure.detail, /API key must start with 'sk_'/);
    assert.deepEqual(await (await s.api("/voice")).json(), { ok: false, trouble: "refused", message: v.OUT });
  } finally {
    answers.restore();
  }
});

test("a key ElevenLabs refuses with a 400 at the final voicing makes the video wait the same way", async () => {
  const answers = elevenAnswers(400, BAD_KEY_400);
  try {
    const v = keyGoesBad();
    const s = await service(async (call) => {
      v.state.out = true;
      await agent(call);
    }, dataDir, { voice: { ...v.voice, quick: false } });
    await s.api("/videos", { method: "POST", body: body("badkeylate") });
    const failed = await s.until("badkeylate", ["failed", "done"]);
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure.code, "voiceDown");
    assert.equal(failed.failure.voice, "refused");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "badkeylate", "draft.json"), "utf8")).voiceDown.message, v.OUT);
    // Not tried again: one try per beat (the two are voiced side by side), final at the first answer.
    assert.equal(answers.calls.length, 2);
  } finally {
    answers.restore();
  }
});

test("POST /videos validates and forwards agent, model, and effort, recording effort in result.by and /status.made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-picks-"));
  const speed = new SpeedBook(join(dir, "speed.json"));
  useSpeedBook(speed);
  try {
    const connector = await fakeConnector(async (call) => {
      await agent(call);
      return { outcome: "done", text: "made with effort", model: "chosen-1", effort: "high" };
    });
    let base = "";
    const c = new Connector({ url: connector.url, token: CONNECTOR_TOKEN, model: "small" });
    const voice = voiceFromEnv({});
    const jobs = new Jobs({ dataDir: dir, connector: c, voice, styles: listStyles, callbackBase: () => base, log: () => undefined });
    base = await listen(createScenesServer({ token: TOKEN, jobs, connector: c, voice, styles: allStyles, dataDir: dir, speed }));
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });

    for (const bad of [{ agent: "" }, { model: 123 }, { effort: "   " }, { reviewModel: "m" }, { reviewEffort: "low" }, { reviewAgent: "" }]) {
      const rejected = await api("/videos", { method: "POST", body: body("v-bad", bad) });
      assert.equal(rejected.status, 400);
    }
    assert.match(agentErrorWords("bad model", "chosen", true), /model "chosen": pick another model, or let Open Sourcebook pick the default/);

    const started = await api("/videos", { method: "POST", body: body("v-pick", { agent: "fake", model: "chosen", effort: "high" }) });
    assert.equal(started.status, 202);
    let done: any;
    for (let i = 0; i < 600; i++) {
      const job = await (await api("/videos/v-pick")).json();
      if (job.state === "done" || job.state === "failed") {
        done = job;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(done?.state, "done", JSON.stringify(done?.failure));
    assert.deepEqual([connector.starts[0].agent, connector.starts[0].model, connector.starts[0].effort], ["fake", "chosen", "high"]);
    assert.deepEqual(done.result.by, { maker: "scenes", agent: "fake", model: "chosen-1", effort: "high", style: "flat" });
    // How long the making took, for the engine to keep under this pick; no viewer ran, so no review time.
    assert.ok(done.result.timing.makingSeconds > 0);
    assert.ok(!("review" in done.result.timing));
    const status = await (await api("/status")).json();
    assert.deepEqual(
      status.made.map((m: any) => ({ agent: m.agent, model: m.model, effort: m.effort })),
      [{ agent: "fake", model: "chosen-1", effort: "high" }],
    );
  } finally {
    useSpeedBook(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
