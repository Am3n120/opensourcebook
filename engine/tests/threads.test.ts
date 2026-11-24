/**
 * The thread on a made thing (engine/docs/api.md, "Threads"): a message
 * written on a thing at a spot is one message of the chat that made it,
 * stored once and seen in both; its reply carries the same thing and shows
 * in both; a thing no chat made gets a chat of its own; the agent's turn is
 * told the facts of the spot, from the format; a format with no words for
 * spots still works with the spot as given; old chats are unchanged. Over
 * the real routes, repositories and migrations, with a fake connector for
 * the person's agent.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSkills } from "../src/chat/default-skills";
import { aboutOf, threadFacts, type Thing } from "../src/chat/threads";
import { videoAnchor } from "../src/engines/video/anchor";
import { CARD_SET_SCHEMA_VERSION } from "../src/cards/contract";
import { handleRequest } from "../src/index";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import type { FetchLike } from "../src/types";
import type { Video } from "../src/video/contract";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const HEART = "The heart pumps blood in two loops. The right side sends blood to the lungs; the left side sends it to the body.";
const PRICE = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

interface Started {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  callback: { url: string; token: string };
}

function fakeConnector() {
  const started: Started[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/status") return Response.json({ agent: "claude", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true }] });
    if (url.pathname === "/turns") {
      started.push(JSON.parse(String(init?.body)) as Started);
      return Response.json({ turnId: started.at(-1)!.turnId }, { status: 202 });
    }
    if (/\/stop$/.test(url.pathname)) return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  };
  return { fetch, started };
}

const QUIZ_PAYLOAD = {
  title: "The heart's two loops",
  passMark: 0.6,
  feedback: "afterEach",
  questions: [
    {
      id: "q1",
      kind: "choice",
      topic: "Loops",
      prompt: "Where does the right side of the heart send blood?",
      points: 1,
      options: ["To the body", "To the lungs", "To the brain only"],
      answer: 1,
      optionFeedback: ["That is the left side's loop.", "The right side's loop goes to the lungs.", "No side sends blood only there."],
      feedback: { correct: "The right side sends blood to the lungs.", incorrect: "The source says the right side sends blood to the lungs." },
      cites: [{ passageId: "P1", sourceId: "x", quote: "The right side sends blood to the lungs" }],
    },
  ],
};

async function setup(registry: FormatRegistry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } })) {
  const connector = fakeConnector();
  const engine = createTestEngine({ agent: { fetch: connector.fetch }, skills: createDefaultSkills(), registry });
  engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async () => undefined });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Biology" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: HEART, projectId: project.id })).body.source;
  const tool = async (turn: Started, name: string, args: unknown = {}) => {
    const response = await handleRequest(
      new Request(`${turn.callback.url}/tools`, { method: "POST", headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) }),
      engine.deps,
    );
    return (await bodyOf(response)) as { text: string; isError: boolean };
  };
  const finish = (turn: Started) =>
    handleRequest(
      new Request(`${turn.callback.url}/finish`, { method: "POST", headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" }, body: JSON.stringify({ outcome: "done" }) }),
      engine.deps,
    );
  /** Answers the last turn the connector was given with a one-paragraph reply. */
  const answer = async (words: string) => {
    const turn = connector.started.at(-1)!;
    await tool(turn, "reply", { blocks: [{ kind: "paragraph", text: words }] });
    await finish(turn);
    engine.clock.advance(1_000);
    return turn;
  };
  /** A quiz made on its own (as from the Studio, no chat) and made: its plan, item and output. */
  const madeQuiz = async (chatId?: string) => {
    const made = await call(`/v1/projects/${project.id}/make`, "POST", { format: "quiz", about: "the heart's loops", ...(chatId ? { chatId } : {}) });
    expect(made.status).toBe(200);
    const plan = made.body.plan;
    const item = made.body.items[0];
    const owner = (await engine.deps.repos.plans.get(plan.id))!.ownerId;
    const output = await engine.deps.repos.outputs.create({ ownerId: owner, projectId: project.id, nodeId: item.id, type: "quiz", schemaVersion: 1, title: QUIZ_PAYLOAD.title, summary: "Where each side of the heart sends blood.", payload: QUIZ_PAYLOAD });
    return { plan, item, output };
  };
  return { engine, registry, call, project, source, connector, tool, answer, madeQuiz };
}

const WRONG = { at: 0, responses: { q1: { choice: 0 } }, ended: false };

describe("a thread message is a message of the thing's chat", () => {
  it("a thing made from the Studio gets a chat of its own, titled from it and linked to it", async () => {
    const t = await setup();
    const { plan, item } = await t.madeQuiz();
    expect(plan.chatId).toBeUndefined();
    // No thread yet: nothing, and no chat made by looking.
    const empty = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`);
    expect(empty.body).toMatchObject({ item: { id: item.id, planId: plan.id, type: "quiz" }, messages: [] });
    expect(empty.body.chat).toBeUndefined();
    expect((await t.call(`/v1/projects/${t.project.id}/chats`)).body.chats).toEqual([]);

    const sent = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "Why not A?", at: WRONG });
    expect(sent.status).toBe(200);
    expect(sent.body.created).toBe(true);
    expect(sent.body.chat.title).toBe("The heart's loops");
    expect((await t.call(`/v1/plans/${plan.id}`)).body.plan.chatId).toBe(sent.body.chat.id);

    // The second message goes to the same chat.
    await t.answer("Because the right side sends blood to the lungs.");
    const again = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "And the left?" });
    expect(again.body.created).toBe(false);
    expect(again.body.chat.id).toBe(sent.body.chat.id);
  });

  it("is stored once: the chat and the thread show the same message and the same reply", async () => {
    const t = await setup();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    const { plan, item, output } = await t.madeQuiz(chat.id);
    const sent = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "Why not A?", at: WRONG });
    expect(sent.body.created).toBe(false);
    expect(sent.body.chat.id).toBe(chat.id);
    const [user, reply] = sent.body.messages;
    expect(user).toMatchObject({ role: "user", text: "Why not A?", about: { item: item.id, plan: plan.id, output: output.id, format: "quiz", title: QUIZ_PAYLOAD.title, at: WRONG, label: "question 1 · wrong" } });
    // The reply is running and already belongs to the thread.
    expect(reply).toMatchObject({ role: "assistant", state: "running", about: { item: item.id } });
    await t.answer("A is the left side's loop; the right side's goes to the lungs.");

    const thread = (await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`)).body.messages;
    const inChat = (await t.call(`/v1/chats/${chat.id}`)).body.messages;
    expect(thread.map((m: { id: string }) => m.id)).toEqual([user.id, reply.id]);
    expect(inChat.map((m: { id: string }) => m.id)).toEqual([user.id, reply.id]);
    expect(thread[1]).toMatchObject({ text: "A is the left side's loop; the right side's goes to the lungs.", about: { item: item.id } });
    expect(thread[1].state).toBeUndefined();
    expect(inChat[1]).toEqual(thread[1]);

    // Counts, for the Studio list and the feed.
    const counts = (await t.call(`/v1/threads?project=${t.project.id}`)).body.threads;
    expect(counts).toEqual([{ itemId: item.id, chatId: chat.id, count: 2, lastAt: expect.any(String) }]);
  });

  it("the thread shows only its own thing's messages; the chat's other messages and old chats are unchanged", async () => {
    const t = await setup();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    await t.call(`/v1/chats/${chat.id}/messages`, "POST", { text: "What does the heart do?" });
    await t.answer("It pumps blood in two loops.");
    const first = await t.madeQuiz(chat.id);
    const second = await t.madeQuiz(chat.id);
    await t.call(`/v1/plans/${first.plan.id}/items/${first.item.id}/thread`, "POST", { text: "On the first" });
    await t.answer("About the first.");
    await t.call(`/v1/plans/${second.plan.id}/items/${second.item.id}/thread`, "POST", { text: "On the second" });
    await t.answer("About the second.");
    const one = (await t.call(`/v1/plans/${first.plan.id}/items/${first.item.id}/thread`)).body.messages;
    expect(one.map((m: { text: string }) => m.text)).toEqual(["On the first", "About the first."]);
    const all = (await t.call(`/v1/chats/${chat.id}`)).body.messages;
    expect(all).toHaveLength(6);
    // A plain message carries no `about`.
    expect(all[0].about).toBeUndefined();
    expect(all[1].about).toBeUndefined();
    // The next turn's history says which messages were on a thing.
    await t.call(`/v1/chats/${chat.id}/messages`, "POST", { text: "thanks" });
    expect(t.connector.started.at(-1)!.prompt).toContain(`Person (in the thread on "${QUIZ_PAYLOAD.title}"): On the first`);
  });

  it("refuses another owner's item and a spot too big to keep", async () => {
    const t = await setup();
    const { plan, item } = await t.madeQuiz();
    expect((await t.call(`/v1/plans/${plan.id}/items/nope/thread`)).status).toBe(404);
    const big = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "hi", at: { pad: "x".repeat(30_000) } });
    expect(big.status).toBe(400);
  });
});

describe("the answer knows what the person is looking at", () => {
  it("a quiz question: the question, its options, the answer given, the right one and the explanation", async () => {
    const t = await setup();
    const { plan, item } = await t.madeQuiz();
    await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "Why not A?", at: WRONG });
    const { prompt, systemPrompt } = t.connector.started.at(-1)!;
    expect(prompt).toContain("in the thread on one thing Open Sourcebook made");
    expect(prompt).toContain(`the quiz "${QUIZ_PAYLOAD.title}"`);
    expect(prompt).toContain("Its brief:");
    expect(prompt).toContain("Where they are in it (question 1 · wrong):");
    expect(prompt).toContain("Question 1 of 1 (on Loops): Where does the right side of the heart send blood?");
    expect(prompt).toContain("A) To the body");
    expect(prompt).toContain(`Their answer: A) To the body (the quiz's line on that option: "That is the left side's loop."). That is wrong.`);
    expect(prompt).toContain("The right answer, as the quiz has it: B) To the lungs");
    expect(prompt).toContain(`The explanation the quiz gave them: "The source says the right side sends blood to the lungs."`);
    expect(prompt).toContain(`The quiz cites for it: "The right side sends blood to the lungs"`);
    // The thing is open in front of them, so a remake knows which one.
    expect(prompt).toContain("open in front of the person now");
    // How to answer is knowledge in the chat's guidance, once.
    expect(systemPrompt).toContain("When they disagree, read the source before you defend the thing");
    expect(systemPrompt).toContain("offer to remake it with the fix (remake_item");
  });

  it("a question not answered yet says so, and a right answer says right", async () => {
    const t = await setup();
    const { plan, item } = await t.madeQuiz();
    const open = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread?at=${encodeURIComponent(JSON.stringify({ at: 0, responses: {} }))}`);
    expect(open.body.here).toEqual({ label: "question 1" });
    const right = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread?at=${encodeURIComponent(JSON.stringify({ at: 0, responses: { q1: { choice: 1 } } }))}`);
    expect(right.body.here).toEqual({ label: "question 1 · right" });
    await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "what is this asking?", at: { at: 0, responses: {} } });
    expect(t.connector.started.at(-1)!.prompt).toContain("They have not answered it yet");
  });

  it("a card of a set of flashcards: its front and back, and how the person last marked it", async () => {
    const t = await setup();
    const made = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "flashcards", about: "the loops" });
    const plan = made.body.plan;
    const item = made.body.items[0];
    const owner = (await t.engine.deps.repos.plans.get(plan.id))!.ownerId;
    const set = {
      schemaVersion: CARD_SET_SCHEMA_VERSION, id: "set", title: "Two loops", subtitle: "", sourceKind: "article", tags: [],
      cards: [
        { id: "c1", kind: "term", front: [{ type: "text", text: "Where does the right side send blood?" }], back: [{ type: "text", text: "To the lungs." }], cites: [{ sourceId: "x", spot: "passage", quote: "The right side sends blood to the lungs" }] },
        { id: "c2", kind: "gap", front: [{ type: "text", text: "The left side sends blood to the [[body]]." }], cites: [] },
      ],
    };
    await t.engine.deps.repos.outputs.create({ ownerId: owner, projectId: t.project.id, nodeId: item.id, type: "flashcards", schemaVersion: CARD_SET_SCHEMA_VERSION, title: "Two loops", payload: set });
    const at = { card: 0, cards: { c1: { box: 0, due: 1, seen: 2, missed: 2 } } };
    const sent = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "why the lungs?", at });
    expect(sent.status).toBe(200);
    expect(sent.body.messages[0].about).toMatchObject({ format: "flashcards", label: "card 1 · not yet" });
    const prompt = t.connector.started.at(-1)!.prompt;
    expect(prompt).toContain("Card 1 of 2.");
    expect(prompt).toContain("Its front: Where does the right side send blood?");
    expect(prompt).toContain("Its back: To the lungs.");
    expect(prompt).toContain('They last marked it "not yet" (marked 2 times, "not yet" 2 of them).');
    expect(prompt).toContain('The card cites: "The right side sends blood to the lungs"');
    // A card not marked yet is said so.
    const second = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread?at=${encodeURIComponent(JSON.stringify({ card: 1, cards: {} }))}`);
    expect(second.body.here).toEqual({ label: "card 2" });
  });

  it("a format with no words for spots keeps the spot as its player gave it", async () => {
    // A shape whose definition brings no describeAnchor (here the quiz's engine under another name).
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } });
    const quiz = registry.require("quiz");
    registry.register({ ...quiz, describeAnchor: undefined, descriptor: { ...quiz.descriptor, id: "riddle", label: "riddle", aliases: [] }, engine: { ...quiz.engine, type: "riddle" } } as never);
    const t = await setup(registry);
    const made = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "riddle", about: "the loops" });
    expect(made.status).toBe(200);
    const plan = made.body.plan;
    const item = made.body.items[0];
    const owner = (await t.engine.deps.repos.plans.get(plan.id))!.ownerId;
    await t.engine.deps.repos.outputs.create({ ownerId: owner, projectId: t.project.id, nodeId: item.id, type: "riddle", schemaVersion: 1, title: "Two loops", payload: QUIZ_PAYLOAD });
    const sent = await t.call(`/v1/plans/${plan.id}/items/${item.id}/thread`, "POST", { text: "what is this saying?", at: { step: 2 } });
    expect(sent.status).toBe(200);
    expect(sent.body.messages[0].about).toMatchObject({ at: { step: 2 }, format: "riddle" });
    expect(sent.body.messages[0].about.label).toBeUndefined();
    expect(t.connector.started.at(-1)!.prompt).toContain('Where they are in it, as its player keeps it: {"step":2}');
  });

  it("a moment of a video: the scene then, what it shows and what is said around that time", () => {
    const video: Video = {
      schemaVersion: 1,
      title: "Area of a circle",
      idea: "A circle's area is pi times the radius squared.",
      aspect: { width: 9, height: 16 },
      scenes: [
        { id: "s1", kind: "question", durationMs: 10_000, visual: { kind: "drawn scene", description: "A circle drawn in chalk." }, narration: "How much space does a circle cover?", onScreenText: ["Area?"], cites: [] },
        {
          id: "s2",
          kind: "build",
          durationMs: 20_000,
          visual: { kind: "drawn scene", description: "The circle is cut into wedges laid out like a rectangle." },
          narration: "Cut it into thin wedges and lay them side by side: they make a rectangle pi r long and r high.",
          onScreenText: ["πr × r"],
          cites: [{ sourceId: "x", spot: "passage", quote: "the area is pi r squared" }],
        },
      ],
      render: { by: "scenes", storyboard: false, assetId: "a", url: "/v1/assets/a", contentType: "video/mp4", width: 1080, height: 1920, fps: 30, durationMs: 31_000, audio: true, captions: true, scenes: [{ id: "s1", startMs: 0, endMs: 11_000 }, { id: "s2", startMs: 11_000, endMs: 31_000 }], renderMs: 1, madeAt: "x" },
    };
    const words = videoAnchor(video, { time: 25 })!;
    expect(words.label).toBe("at 0:25");
    expect(words.facts[0]).toBe("At 0:25 of 0:31, in scene 2 of 2 (build).");
    expect(words.facts).toContain("What the scene shows: The circle is cut into wedges laid out like a rectangle.");
    expect(words.facts).toContain('Words on screen: "πr × r"');
    expect(words.facts.find((fact) => fact.startsWith("Around this moment"))).toContain("a rectangle pi r long");
    expect(words.facts).toContain('The scene before said: "How much space does a circle cover?"');
    expect(words.facts).toContain('The scene cites: "the area is pi r squared"');
    // The render's own spans place the scene, not the planned lengths: 10.5 s is still the first scene.
    expect(videoAnchor(video, { time: 10.5 })!.facts[0]).toContain("scene 1 of 2");
    expect(videoAnchor(video, { bit: 1 })).toBeUndefined();

    // Through the registry, into the turn's facts.
    const registry = new FormatRegistry();
    const quiz = createDefaultRegistry().require("quiz");
    registry.register({ ...quiz, descriptor: { ...quiz.descriptor, id: "video", label: "video", aliases: [] }, engine: { ...quiz.engine, type: "video" }, describeAnchor: videoAnchor } as never);
    const thing = {
      project: { id: "p" },
      plan: { id: "pl", direct: true },
      node: { id: "n", type: "video", title: "Area of a circle", prompt: "Shows why the area is pi r squared.", settings: {}, status: "done" },
      output: { id: "o", type: "video", schemaVersion: 1, title: "Area of a circle", summary: "", payload: video },
    } as unknown as Thing;
    const { about, facts } = aboutOf(registry, thing, { time: 25 });
    expect(about).toMatchObject({ item: "n", output: "o", format: "video", label: "at 0:25" });
    const said = threadFacts(registry, thing, { ...about, facts });
    expect(said).toContain('The thing: the video "Area of a circle"');
    expect(said).toContain("Where they are in it (at 0:25):");
    expect(said).toContain("What the scene shows: The circle is cut into wedges");
  });
});
