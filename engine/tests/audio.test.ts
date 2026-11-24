/**
 * Audio, the fourth shape (engines/audio, engine/docs/audio.md): it registers
 * and everything read from the registry picks it up (its command, its tile's
 * settings, plan sizes); it is not ready, and says why in the scenes
 * service's words, when there is no voice; the person's agent writes it part
 * by part through tools that answer (a bad cite refused, the spoken length
 * told, background marked and never cited); the scenes service voices it and
 * the file and word times are kept; a moment of it is said in words.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { forgetAgentStatus, AgentWork } from "../src/chat/agent/work";
import { createDefaultSkills } from "../src/chat/default-skills";
import { formatLine } from "../src/chat/about-opensourcebook";
import type { DraftPlan } from "../src/chat/planning/draft";
import { planSize } from "../src/chat/planning/size";
import { audioAnchor } from "../src/engines/audio/anchor";
import { createAgentAudioMaker } from "../src/engines/audio/agent-maker";
import type { AudioPayload } from "../src/engines/audio/contract";
import { createAudioDefinition } from "../src/engines/audio/definition";
import { parseAudioSettings, type AudioSettings } from "../src/engines/audio/settings";
import { AudioVoiceClient } from "../src/engines/audio/voice-client";
import { forgetScenesStatus, rememberScenesStatus, type ScenesStatus } from "../src/engines/video/scenes/client";
import { InMemoryUsageSink } from "../src/providers/usage";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, EngineProgress, JsonValue, NodeSource } from "../src/studio/types";
import type { FetchLike, SourceEnvelope } from "../src/types";
import { FAKE_CONNECTOR_TOKEN, FAKE_CONNECTOR_URL, FAKE_ENGINE_URL, FakeConnector } from "./support/fake-connector";
import { FakeR2Bucket } from "./support/fake-r2";

const SCENES_URL = "http://127.0.0.1:8671";
const P1 = "The river broke its banks in the spring of 1820 and cut a new channel to the east of the old town.";
const P2 = "The town council moved the market to the higher ground near the church, where the floods could not reach it.";

function envelope(text: string): SourceEnvelope {
  return { originalText: text, kind: "text", title: "Town history", text, references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-18T09:00:00.000Z" };
}

function source(): NodeSource {
  let at = 0;
  const chunks = [P1, P2].map((text, index) => {
    const chunk = { id: `chunk-${index + 1}`, ord: index, text, locator: { charStart: at, charEnd: at + text.length } };
    at += text.length + 2;
    return chunk;
  });
  return { sourceId: "src-1", title: "Town history", envelope: envelope([P1, P2].join("\n\n")), chunks };
}

function memoryCheckpoint(): EngineCheckpoint & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return { entries, get: (key) => entries.get(key), put: async (key, value) => void entries.set(key, JSON.parse(JSON.stringify(value)) as JsonValue) };
}

function status(audio: ScenesStatus["audio"]): ScenesStatus {
  return { reachable: true, styles: [], voice: { id: "elevenlabs", label: "ElevenLabs" }, ...(audio ? { audio } : {}) };
}

/** The scenes service's audio calls, voicing at once: every word given a time, 400 ms each. */
class FakeVoice {
  readonly started: Array<{ id: string; title: string; parts: Array<{ id: string; text: string }> }> = [];
  refuse?: string;
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/audio") {
      if (this.refuse) return Response.json({ error: "no_voice", message: this.refuse }, { status: 409 });
      this.started.push(JSON.parse(String(init?.body)));
      return Response.json({ id: this.started.at(-1)!.id }, { status: 202 });
    }
    const one = /^\/audio\/([^/]+)(\/file)?$/.exec(url.pathname);
    const job = one ? this.started.find((started) => started.id === decodeURIComponent(one[1]!)) : undefined;
    if (!job) return Response.json({ error: "not_found" }, { status: 404 });
    if (one![2]) return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "audio/mp4" } });
    let at = 250;
    const parts = job.parts.map((part) => {
      const startMs = at;
      const words = part.text.split(/\s+/).filter(Boolean).map((text) => ({ text, startMs: (at += 400) - 400, endMs: at - 50 }));
      at += 1200;
      return { id: part.id, startMs, endMs: at - 700, words };
    });
    return Response.json({ id: job.id, state: "done", progress: 1, step: "Done", result: { durationMs: at + 2000, bytes: 8, contentType: "audio/mp4", voice: { id: "elevenlabs", label: "ElevenLabs", real: true }, loudness: { lufs: -14, truePeak: -1.5 }, parts } });
  };
}

function work(connector: FakeConnector): AgentWork {
  return new AgentWork({ url: FAKE_CONNECTOR_URL, token: FAKE_CONNECTOR_TOKEN, agent: "claude", callbackUrl: FAKE_ENGINE_URL, timeoutMs: 180_000 }, connector.fetch, {
    pollMs: 20,
    graceMs: 0,
    settleMs: 300,
    maxMissedReads: 2,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  });
}

function definition(connector: FakeConnector, voice: FakeVoice) {
  const client = new AudioVoiceClient({ url: SCENES_URL, token: "scenes-token-0123456789" }, voice.fetch);
  return createAudioDefinition({ voice: client, makers: [createAgentAudioMaker({ work: work(connector), voice: client, pollMs: 1, sleep: async () => undefined })] });
}

function settings(raw: Record<string, unknown> = { minutes: 1 }): AudioSettings {
  const parsed = parseAudioSettings(raw);
  if (!parsed.ok) throw new Error("bad settings");
  return parsed.settings;
}

function context(audioSettings: AudioSettings) {
  const progress: EngineProgress[] = [];
  const bucket = new FakeR2Bucket();
  const ctx: EngineContext<AudioSettings> = {
    jobId: "job-audio-1",
    node: { id: "node-1", type: "audio", title: "The flood of 1820", prompt: "Walk through why the town moved its market, for a listener on a walk.", settings: audioSettings },
    sources: [source()],
    assumes: [],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async () => { throw new Error("no model is called"); } },
      assets: new AssetStore(bucket),
      usage: new InMemoryUsageSink(),
      fetch: async () => new Response(null),
      now: () => "2026-11-18T09:00:00.000Z",
      checkpoint: memoryCheckpoint(),
      progress: (update) => void progress.push(update),
    },
  };
  return { ctx, progress, bucket };
}

const sourcePart = {
  title: "The flood",
  text: "Your town history opens in the spring of 1820, when the river broke its banks and cut a new channel to the east.",
  cites: [{ passage: "P1", quote: "The river broke its banks in the spring of 1820" }],
};

beforeEach(() => {
  forgetAgentStatus();
  forgetScenesStatus();
});

describe("the audio shape in the registry", () => {
  it("registers, and its command, its settings and its plan words come from the registry", () => {
    rememberScenesStatus(SCENES_URL, status({ ready: true }));
    const registry = createDefaultRegistry({ audio: { voice: new AudioVoiceClient({ url: SCENES_URL, token: "t".repeat(20) }, new FakeVoice().fetch), makers: [createAgentAudioMaker({ work: work(new FakeConnector(async () => ({ ok: true }))), voice: new AudioVoiceClient({ url: SCENES_URL, token: "t".repeat(20) }, new FakeVoice().fetch) })] } });
    expect(registry.ready()).toContain("audio");
    const view = registry.views().find((format) => format.id === "audio")!;
    expect(view).toMatchObject({ label: "audio", singular: "audio walk-through", plural: "audio walk-throughs", icon: "listen", ready: true, defaults: { minutes: 0 } });
    expect(view.problem).toBeUndefined();
    expect(view.settings.map((field) => field.key)).toEqual(["minutes", "agent"]);
    const command = createDefaultSkills().commands(registry).find((known) => known.word === "audio");
    expect(command).toMatchObject({ label: "audio walk-through", about: view.blurb, format: "audio", skill: "make" });
    const audio = registry.get("audio")!;
    expect(audio.settle!(settings({ minutes: 0 }), { sourceChars: 15_000, sourceCount: 1 })).toEqual({ maker: "agent", minutes: 6 });
    expect(audio.describe!(settings({ minutes: 6 }))).toEqual(["Your agent", "about 6 min"]);
    // A plan's size counts it in its own words and times it by its minutes, as it does every shape.
    const item = (key: string, type: string, minutes: number) => ({ key, type, title: key, prompt: "", settings: { minutes }, sources: [], enabled: true, level: 0 });
    const size = planSize({ title: "Walks", items: [item("a", "audio", 6), item("b", "audio", 4), item("c", "quiz", 0)], edges: [] } as unknown as DraftPlan, registry);
    expect(size).toBe("2 audio walk-throughs (about 10 min), 1 quiz; 3 items in 1 stage");
  });

  it("is not ready without a voice, and its tile, command and the planner say why in the service's words", () => {
    const problem = "Audio needs a voice, and this computer has none set up: pick one in Settings, under Voice.";
    rememberScenesStatus(SCENES_URL, status({ ready: false, problem }));
    const client = new AudioVoiceClient({ url: SCENES_URL, token: "t".repeat(20) }, new FakeVoice().fetch);
    const registry = createDefaultRegistry({ audio: { voice: client, makers: [createAgentAudioMaker({ work: work(new FakeConnector(async () => ({ ok: true }))), voice: client })] } });
    expect(registry.ready()).not.toContain("audio");
    const view = registry.views().find((format) => format.id === "audio")!;
    expect(view.ready).toBe(false);
    expect(view.problem).toBe(problem);
    expect(createDefaultSkills().commands(registry).find((known) => known.word === "audio")?.about).toBe(problem);
    expect(formatLine(view)).toContain(problem);
  });

  it("says what is missing when there is no scenes service or no agent at all", () => {
    expect(createDefaultRegistry().problem("audio")).toMatch(/scene maker/);
    const client = new AudioVoiceClient({ url: SCENES_URL, token: "t".repeat(20) }, new FakeVoice().fetch);
    expect(createDefaultRegistry({ audio: { voice: client } }).problem("audio")).toMatch(/your own agent/);
  });
});

describe("an audio written by the person's agent", () => {
  it("is written part by part through tools that answer, then voiced, and kept with its file and a time for every word", async () => {
    const answers: Record<string, string> = {};
    const connector = new FakeConnector(async (agent) => {
      expect((await agent.call("read_skill", { path: "listening" })).text).toContain("listen");
      await agent.call("plan_audio", { title: "The flood of 1820", about: "Why the town moved its market.", parts: 3 });
      answers.badQuote = (await agent.call("write_part", { ...sourcePart, cites: [{ passage: "P1", quote: "the river flooded every year" }] })).text;
      answers.noCite = (await agent.call("write_part", { ...sourcePart, cites: [] })).text;
      answers.markup = (await agent.call("write_part", { ...sourcePart, text: "**The flood** came in 1820." })).text;
      answers.citedBackground = (await agent.call("write_part", { ...sourcePart, background: true })).text;
      answers.first = (await agent.call("write_part", sourcePart)).text;
      answers.background = (await agent.call("write_part", { title: "An aside", background: true, text: "A thought of my own, not from your notes: towns often move to higher ground after a flood like this." })).text;
      answers.beyond = (await agent.call("write_part", { title: "The market", text: "So the council moved the market to the higher ground near the church, about 300 paces away.", cites: [{ passage: "P2", quote: "moved the market to the higher ground near the church" }] })).text;
      answers.read = (await agent.call("read_script")).text;
      answers.finish = (await agent.call("finish_audio")).text;
      return { ok: true };
    });
    const voice = new FakeVoice();
    const { ctx, bucket } = context(settings({ minutes: 1 }));
    const result = await runEngine(definition(connector, voice), ctx);

    expect(answers.badQuote).toContain("not word for word in P1");
    expect(answers.noCite).toContain("set background to true");
    expect(answers.markup).toContain("no markup");
    expect(answers.citedBackground).toContain("a background part is your own explanation, so it cites nothing");
    expect(answers.first).toMatch(/Kept as p1, part 1 of 1 \(3 planned\): 23 words, about 0:10 spoken\. The script so far runs about 0:10 of about 1 min asked\./);
    expect(answers.background).toContain("Kept as background. A listener cannot see that it is marked");
    expect(answers.beyond).toContain("your sources do not contain 300");
    expect(answers.read).toContain("## p2 · An aside · background");
    expect(answers.finish).toContain("The script is finished and kept");

    expect(result.report.valid).toBe(true);
    const audio = result.output.payload;
    expect(voice.started).toHaveLength(1);
    expect(voice.started[0]!.parts.map((part) => part.id)).toEqual(["p1", "p2", "p3"]);
    expect(audio.parts.map((part) => [part.id, part.background, part.cites.length])).toEqual([
      ["p1", false, 1],
      ["p2", true, 0],
      ["p3", false, 1],
    ]);
    for (const part of audio.parts) {
      expect(part.words!.map((word) => word.text).join(" ")).toBe(part.text);
      expect(part.startMs).toBeLessThanOrEqual(part.words![0]!.startMs);
    }
    expect(audio.file).toMatchObject({ contentType: "audio/mp4", voice: { id: "elevenlabs" }, loudness: { lufs: -14 }, by: { maker: "agent" } });
    expect(audio.file!.url).toMatch(/^\/v1\/assets\//);
    expect(bucket.objects.size).toBe(1);
    expect(result.output.citations.map((cite) => cite.anchor)).toEqual(["parts[0]", "parts[2]"]);
  });

  it("asks for a word to the person when it runs far from the length asked", async () => {
    let first = "";
    const connector = new FakeConnector(async (agent) => {
      await agent.call("write_part", sourcePart);
      first = (await agent.call("finish_audio", { title: "Short" })).text;
      await agent.call("finish_audio", { note: "Your notes hold only a few lines on the flood, so it runs well under the ten minutes asked." });
      return { ok: true };
    });
    const result = await runEngine(definition(connector, new FakeVoice()), context(settings({ minutes: 10 })).ctx);
    expect(first).toContain("call finish_audio again with `note`");
    expect(result.output.payload.lengthNote).toContain("well under");
  });

  it("an agent that ends in an error of its own before writing any part fails as that, with its own words, never as a dropped turn", async () => {
    const said = "The 'some-model' model is not supported on this account.";
    const connector = new FakeConnector(async () => ({ ok: false, problem: "error", said }));
    const failure = await runEngine(definition(connector, new FakeVoice()), context(settings()).ctx).catch((error: unknown) => error);
    expect(failure).toMatchObject({ failureCode: "agent_error", said, retryable: false });
  });

  it("fails in the service's words when the voice is gone by the time it is voiced", async () => {
    const connector = new FakeConnector(async (agent) => {
      await agent.call("write_part", sourcePart);
      await agent.call("finish_audio", { title: "Flood", note: "Short on purpose." });
      return { ok: true };
    });
    const voice = new FakeVoice();
    voice.refuse = "Audio needs a voice, and this computer has none set up.";
    await expect(runEngine(definition(connector, voice), context(settings()).ctx)).rejects.toThrow("Audio needs a voice");
  });
});

describe("a moment of an audio in words", () => {
  const audio: AudioPayload = {
    schemaVersion: 1,
    title: "The flood",
    about: "Why the market moved.",
    parts: [
      { id: "p1", title: "The flood", text: "The river broke its banks.", background: false, cites: [{ sourceId: "src-1", quote: "The river broke its banks" }], startMs: 0, endMs: 2000, words: ["The", "river", "broke", "its", "banks."].map((text, at) => ({ text, startMs: at * 400, endMs: at * 400 + 350 })) },
      { id: "p2", title: "An aside", text: "My own thought: towns move uphill.", background: true, cites: [], startMs: 2000, endMs: 4500, words: ["My", "own", "thought:", "towns", "move", "uphill."].map((text, at) => ({ text, startMs: 2000 + at * 400, endMs: 2350 + at * 400 })) },
    ],
    file: { assetId: "a", url: "/v1/assets/a", contentType: "audio/mp4", bytes: 1, durationMs: 6000, voice: { id: "elevenlabs", label: "ElevenLabs" }, madeAt: "2026-11-18T09:00:00.000Z", by: { maker: "agent" } },
  };

  it("is the time, the words said around it, and the part's cites", () => {
    const words = audioAnchor(audio, { time: 1.0 })!;
    expect(words.label).toBe("at 0:01");
    expect(words.facts[0]).toBe('At 0:01 of 0:06, in part 1 of 2: "The flood".');
    expect(words.facts.join("\n")).toContain('Around this moment the voice says: "The river broke its banks."');
    expect(words.facts.join("\n")).toContain('The part cites: "The river broke its banks"');
    const aside = audioAnchor(audio, { time: 3 })!;
    expect(aside.facts.join("\n")).toContain("the maker's own explanation");
    expect(aside.facts.join("\n")).toContain('The part before ("The flood") said');
    expect(audioAnchor(audio, { card: 2 })).toBeUndefined();
  });
});

describe("an audio's own agent, model and effort", () => {
  it("reach the connector", async () => {
    const connector = new FakeConnector(async () => ({ ok: false, problem: "error", said: "stop here" }));
    await runEngine(definition(connector, new FakeVoice()), context(settings({ minutes: 1, agent: "agent:codex:gpt-5", effort: "high" })).ctx).catch(() => undefined);
    const body = connector.bodies[0] as unknown as Record<string, unknown>;
    expect([body.agent, body.model, body.effort]).toEqual(["codex", "gpt-5", "high"]);
  });
});
