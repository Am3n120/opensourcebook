/**
 * One thing at once (engine/docs/api.md, "Making one thing"): the chat's
 * commands come from the registry, one per format that can be made plus the
 * skills' own; asking for one thing makes it and starts it with no card;
 * a path is still a plan that waits for Start; a follow-up remakes the
 * right thing with the change, linked to the old one; a thing being made
 * can be stopped; and when nothing can make it, nothing is saved and the
 * reason is said. Over the real routes, repositories and migrations, with a
 * fake connector for the person's agent.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSkills } from "../src/chat/default-skills";
import { ChatService } from "../src/chat/service";
import { claimProposal, proposalOf } from "../src/chat/making/direct";
import { createDefaultConditions } from "../src/studio/conditions";
import { handleRequest } from "../src/index";
import { createScenesMaker } from "../src/engines/video/scenes/maker";
import { ScenesClient, refreshScenesStatus } from "../src/engines/video/scenes/client";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { FakeScenesService } from "./support/fake-scenes";
import { PlanRunner } from "../src/studio/plan-runner";
import type { FormatRegistry } from "../src/studio/registry";
import type { FetchLike } from "../src/types";
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

async function setup(registry: FormatRegistry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } })) {
  const connector = fakeConnector();
  const engine = createTestEngine({ agent: { fetch: connector.fetch }, skills: createDefaultSkills(), registry });
  const queued: string[] = [];
  engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (id) => void queued.push(id) });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Biology" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: HEART, projectId: project.id })).body.source;
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
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
  /** Sends a message and answers it as the agent would: `act` makes its tool calls, then a one-line reply. */
  const turn = async (text: string, act: (turn: Started) => Promise<void>, extra: Record<string, unknown> = {}) => {
    await call(`/v1/chats/${chat.id}/messages`, "POST", { text, ...extra });
    const started = connector.started.at(-1)!;
    await act(started);
    await tool(started, "reply", { blocks: [{ kind: "paragraph", text: "On it." }] });
    await finish(started);
    engine.clock.advance(1_000);
    return { started, reply: (await call(`/v1/chats/${chat.id}`)).body.messages.at(-1) };
  };
  return { engine, registry, call, project, source, chat, connector, tool, turn, queued };
}

const QUIZ = { format: "quiz", title: "The heart's two loops", brief: "Checks that you can say where each side of the heart sends blood.", settings: { questions: 5 }, sources: [{ source: "S1" }] };

describe("commands come from the registry", () => {
  it("lists the skills' own commands and one per format that can be made, with the format's own words", async () => {
    const t = await setup();
    const { commands } = (await t.call("/v1/skills")).body;
    const ready = t.registry.ready();
    // A format that cannot be made here for a reason the person can fix keeps its command, which says the reason.
    const blocked = t.registry.views().filter((view) => !view.ready && view.problem);
    expect(commands.map((c: { command: string }) => c.command)).toEqual([...t.registry.views().filter((view) => view.ready || view.problem).map((view) => view.id), "plan", "teachback", "mindmap"]);
    for (const view of blocked) expect(commands.find((c: { command: string }) => c.command === view.id)?.about).toBe(view.problem);
    for (const id of ready) {
      const descriptor = t.registry.descriptor(id)!;
      expect(commands.find((c: { command: string }) => c.command === id)).toEqual({ command: id, title: descriptor.label, group: "make", label: descriptor.singular ?? descriptor.label, about: descriptor.blurb ?? descriptor.about, skill: "make", format: id });
    }
  });

  it("lists the make commands in the owner's order of the shapes: video, flashcards, quiz, audio, guide", async () => {
    const t = await setup();
    const { commands } = (await t.call("/v1/skills")).body;
    const made = commands.filter((c: { group: string }) => c.group === "make").map((c: { command: string }) => c.command);
    expect(made.length).toBeGreaterThan(1);
    expect(made).toEqual(["video", "flashcards", "quiz", "audio", "guide"].filter((id) => made.includes(id)));
  });

  it("a new format becomes a command with nothing else changed", async () => {
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } });
    const quiz = registry.require("quiz");
    registry.register({ ...quiz, descriptor: { ...quiz.descriptor, id: "riddle", label: "riddle", aliases: [], blurb: "questions told as riddles" }, engine: { ...quiz.engine, type: "riddle" } } as never);
    const t = await setup(registry);
    const { commands } = (await t.call("/v1/skills")).body;
    expect(commands.find((c: { command: string }) => c.command === "riddle")).toEqual({ command: "riddle", title: "riddle", group: "make", label: "riddle", about: "questions told as riddles", skill: "make", format: "riddle" });
    // Typed, it tells the agent to make one of it at once.
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/riddle about the heart" });
    expect(t.connector.started[0]!.prompt).toContain('open the make sheet for one item of format "riddle" now with make_item, about what they wrote');
    expect(t.connector.started[0]!.systemPrompt).toContain("/riddle");
  });
});

/** Makes the thing a reply's make sheet holds, as the web does when the person presses its button. */
async function makeFromSheet(t: Awaited<ReturnType<typeof setup>>, reply: { id: string; pieces: Array<Record<string, any>> }, change: Record<string, unknown> = {}) {
  const index = reply.pieces.findIndex((piece) => piece.kind === "make");
  const sheet = reply.pieces[index]!;
  return t.call(`/v1/projects/${t.project.id}/make`, "POST", {
    format: sheet.format,
    about: sheet.about,
    sources: sheet.sources,
    settings: sheet.settings,
    ...(sheet.remakes ? { remakes: sheet.remakes } : {}),
    proposal: { messageId: reply.id, piece: index },
    ...change,
  });
}

describe("one thing asked for in the chat opens its make sheet", () => {
  it("/quiz with words saves nothing and answers with the sheet filled in; the sheet's button makes it once", async () => {
    const t = await setup();
    const { reply } = await t.turn("/quiz the heart's loops, short", async (turn) => {
      expect(turn.prompt).toContain('open the make sheet for one item of format "quiz" now');
      const opened = await t.tool(turn, "make_item", QUIZ);
      expect(opened.isError).toBe(false);
      expect(opened.text).toContain("Nothing is made until they press its button");
    });
    const sheet = reply.pieces.find((piece: { kind: string }) => piece.kind === "make");
    expect(sheet).toMatchObject({ kind: "make", format: "quiz", title: QUIZ.title, about: QUIZ.brief, sources: [t.source.id], settings: expect.objectContaining({ questions: 5 }), plannedAs: expect.stringMatching(/^quiz/), notices: [], issues: [], state: "open" });
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toEqual([]);
    expect(t.queued).toHaveLength(0);

    const made = await makeFromSheet(t, reply);
    expect(made.status).toBe(200);
    expect(made.body.plan).toMatchObject({ direct: true, status: "running", chatId: t.chat.id, title: QUIZ.title });
    expect(made.body.items[0]).toMatchObject({ prompt: QUIZ.brief, settings: expect.objectContaining({ questions: 5 }) });
    expect(t.queued).toHaveLength(1);
    // The sheet is marked made, so reloading the chat never opens it again, and it makes nothing twice.
    const stored = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages.find((message: { id: string }) => message.id === reply.id);
    expect(stored.pieces.find((piece: { kind: string }) => piece.kind === "make")).toMatchObject({ state: "made", planId: made.body.plan.id });
    const again = await makeFromSheet(t, reply);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("proposal_used");
    // The agent's next turn sees it as made at once.
    const next = t.connector.started.length;
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "thanks" });
    expect(t.connector.started[next]!.prompt).toContain(`"The heart's two loops" (thing ${made.body.plan.id}): quiz`);
  });

  it("Cancel closes the sheet; a closed sheet makes nothing; a wrong place is refused", async () => {
    const t = await setup();
    const { reply } = await t.turn("a quiz on the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const index = reply.pieces.findIndex((piece: { kind: string }) => piece.kind === "make");
    const closed = await t.call(`/v1/chats/${t.chat.id}/messages/${reply.id}/pieces/${index}/close`, "POST", {});
    expect(closed.status).toBe(200);
    expect(closed.body.message.pieces[index]).toMatchObject({ kind: "make", state: "closed" });
    expect((await t.call(`/v1/chats/${t.chat.id}/messages/${reply.id}/pieces/${index}/close`, "POST", {})).status).toBe(200);
    expect((await makeFromSheet(t, reply)).body.error).toBe("proposal_used");
    expect((await t.call(`/v1/chats/${t.chat.id}/messages/${reply.id}/pieces/0/close`, "POST", {})).status).toBe(404);
    const wrong = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "quiz", proposal: { messageId: reply.id, piece: 0 } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_proposal");
    expect(t.queued).toHaveLength(0);
  });

  it("two presses make one thing: the sheet is marked used in one step that only one call wins", async () => {
    const t = await setup();
    const { reply } = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const index = reply.pieces.findIndex((piece: { kind: string }) => piece.kind === "make");
    const ownerId = (await t.engine.deps.repos.projects.get(t.project.id))!.ownerId;
    // Both calls read the sheet open, as two presses at once do; only the first write lands.
    const first = (await proposalOf(t.engine.deps.repos, { ownerId }, reply.id, index))!;
    const second = (await proposalOf(t.engine.deps.repos, { ownerId }, reply.id, index))!;
    expect(await claimProposal(t.engine.deps.repos, first, { state: "made" })).toBeDefined();
    expect(await claimProposal(t.engine.deps.repos, second, { state: "closed" })).toBeUndefined();
    const stored = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages.find((message: { id: string }) => message.id === reply.id);
    expect(stored.pieces[index].state).toBe("made");
    // A press that comes after the sheet was claimed makes nothing.
    const late = await makeFromSheet(t, reply);
    expect(late).toMatchObject({ status: 409, body: { error: "proposal_used" } });
    expect(t.queued).toHaveLength(0);
    // Two presses through the route: one thing is made.
    const again = await t.turn("/quiz the heart again", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const presses = await Promise.all([makeFromSheet(t, again.reply), makeFromSheet(t, again.reply)]);
    expect(presses.map((press) => press.status).sort()).toEqual([200, 409]);
    expect(t.queued).toHaveLength(1);
  });

  it("a press that makes nothing leaves the sheet open", async () => {
    const t = await setup(createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE, api: false } }));
    const { reply } = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    expect((await makeFromSheet(t, reply)).status).toBe(409);
    const stored = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages.find((message: { id: string }) => message.id === reply.id);
    expect(stored.pieces.find((piece: { kind: string }) => piece.kind === "make").state).toBe("open");
  });

  it("a sheet made from cannot be closed", async () => {
    const t = await setup();
    const { reply } = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    await makeFromSheet(t, reply);
    const index = reply.pieces.findIndex((piece: { kind: string }) => piece.kind === "make");
    const closed = await t.call(`/v1/chats/${t.chat.id}/messages/${reply.id}/pieces/${index}/close`, "POST", {});
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("proposal_used");
  });

  it("from a terminal there is no sheet: it is made at once", async () => {
    const t = await setup();
    const { started, reply } = await t.turn(
      "/quiz the heart",
      async (turn) => {
        const made = await t.tool(turn, "make_item", QUIZ);
        expect(made.text).toContain("Made and started");
      },
      { from: "terminal" },
    );
    expect(started.prompt).toContain('make one item of format "quiz" now');
    expect(reply.pieces.at(-1)).toEqual({ kind: "plan", planId: expect.any(String), action: "created", made: "made" });
    expect(t.queued).toHaveLength(1);
  });

  it("a request for a path is a plan that waits for Start", async () => {
    const t = await setup();
    const { reply } = await t.turn("help me learn this for my exam", async (turn) => {
      await t.tool(turn, "make_plan", { title: "Heart", stages: [{ items: [{ key: "a", format: "flashcards", title: "Two loops", brief: "Explains the loops.", sources: [{ source: "S1" }] }] }, { items: [{ key: "b", ...QUIZ }] }] });
    });
    const piece = reply.pieces.at(-1);
    expect(piece).toEqual({ kind: "plan", planId: expect.any(String), action: "created" });
    const view = (await t.call(`/v1/plans/${piece.planId}`)).body;
    expect(view.plan.direct).toBeUndefined();
    expect(view.plan.status).toBe("draft");
    expect(t.queued).toHaveLength(0);
  });

  it("when nothing can make it, the sheet says why, the agent is told, and nothing is saved", async () => {
    const t = await setup(createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE, api: false } }));
    const { reply } = await t.turn("/quiz the heart", async (turn) => {
      const opened = await t.tool(turn, "make_item", QUIZ);
      expect(opened.text).toContain("can't be made on this computer now");
      expect(opened.text).toContain("don't make a plan instead");
    });
    const sheet = reply.pieces.find((piece: { kind: string }) => piece.kind === "make");
    expect(sheet.issues.length).toBeGreaterThan(0);
    expect((await makeFromSheet(t, reply)).status).toBe(409);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toEqual([]);
  });
});

describe("Open Sourcebook's own model opens the same sheet", () => {
  it("a /quiz answered by the make skill saves nothing and carries the sheet", async () => {
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } });
    const engine = createTestEngine({ skills: createDefaultSkills(), registry, answer: () => ({ reply: "Here is a five-question quiz on the loops.", item: QUIZ }) });
    engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async () => undefined });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    const project = (await call("/v1/projects", "POST", { title: "Biology" })).body.project;
    await call("/v1/sources", "POST", { text: HEART, projectId: project.id });
    const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
    const reply = (await call(`/v1/chats/${chat.id}/messages`, "POST", { text: "/quiz the heart" })).body.messages[1];
    expect(reply.pieces[0]).toMatchObject({ kind: "text", text: "Here is a five-question quiz on the loops." });
    expect(reply.pieces[1]).toMatchObject({ kind: "make", format: "quiz", title: QUIZ.title, state: "open" });
    expect((await call(`/v1/projects/${project.id}/plans`)).body.plans).toEqual([]);
  });

  it("from a terminal the make skill makes it at once, as the agent does", async () => {
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } });
    const engine = createTestEngine({ skills: createDefaultSkills(), registry, answer: () => ({ reply: "Making a five-question quiz on the loops.", item: QUIZ }) });
    const queued: string[] = [];
    engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (id) => void queued.push(id) });
    engine.deps.chat = new ChatService({ repos: engine.deps.repos, registry, skills: engine.deps.chat!.skills, conditions: createDefaultConditions(), plans: engine.deps.plans, provider: engine.deps.provider });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    const project = (await call("/v1/projects", "POST", { title: "Biology" })).body.project;
    await call("/v1/sources", "POST", { text: HEART, projectId: project.id });
    const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
    const reply = (await call(`/v1/chats/${chat.id}/messages`, "POST", { text: "/quiz the heart", from: "terminal" })).body.messages[1];
    expect(reply.pieces[0]).toMatchObject({ kind: "text", text: "Making a five-question quiz on the loops." });
    expect(reply.pieces[1]).toEqual({ kind: "plan", planId: expect.any(String), action: "created", made: "made" });
    expect(reply.pieces.some((piece: { kind: string }) => piece.kind === "make")).toBe(false);
    expect(queued).toHaveLength(1);
  });
});

describe("a follow-up opens the sheet to remake the thing it is about", () => {
  it("keeps the brief and settings, applies the change, and once made links old and new; the old one stays", async () => {
    const t = await setup();
    const first = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const oldId = (await makeFromSheet(t, first.reply)).body.plan.id;
    const oldItem = (await t.call(`/v1/plans/${oldId}`)).body.items[0];
    const { reply } = await t.turn("more questions", async (turn) => {
      expect(turn.prompt).toContain(`(thing ${oldId})`);
      expect(turn.prompt).toContain("the newest");
      const again = await t.tool(turn, "remake_item", { thing: oldId, settings: { questions: 10 } });
      expect(again.isError).toBe(false);
    });
    const sheet = reply.pieces.find((piece: { kind: string }) => piece.kind === "make");
    expect(sheet).toMatchObject({ title: QUIZ.title, about: QUIZ.brief, settings: expect.objectContaining({ questions: 10 }), remakes: { planId: oldId, itemId: oldItem.id }, state: "open" });
    const fresh = (await makeFromSheet(t, reply)).body;
    expect(fresh.plan).toMatchObject({ direct: true, status: "running", supersedesPlanId: oldId, version: 2 });
    expect(fresh.items[0]).toMatchObject({ title: QUIZ.title, prompt: QUIZ.brief, settings: expect.objectContaining({ questions: 10 }) });
    expect(fresh.items[0].sources).toEqual([{ sourceId: t.source.id }]);
    expect((await t.call(`/v1/plans/${oldId}`)).body.items[0].settings.questions).toBe(5);
    // The next turn sees the newer first, marked as a remake of the older.
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "again" });
    const prompt = t.connector.started.at(-1)!.prompt;
    expect(prompt.indexOf(fresh.plan.id)).toBeLessThan(prompt.indexOf(oldId));
    expect(prompt).toContain(`a remake of "${QUIZ.title}"`);
  });

  it("refuses a remake of something not in the project", async () => {
    const t = await setup();
    const made = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "quiz", remakes: { planId: "nope", itemId: "nope" } });
    expect(made.status).toBe(400);
  });

  it("names the thing open in front of the person", async () => {
    const t = await setup();
    const first = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const item = (await makeFromSheet(t, first.reply)).body.items[0];
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "simpler", opened: item.id });
    expect(t.connector.started.at(-1)!.prompt).toContain("open in front of the person now");
  });
});

describe("stopping a thing made at once", () => {
  it("stops through the plan's own cancel, and the agent can stop one when asked", async () => {
    const t = await setup();
    const first = await t.turn("/quiz the heart", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const id = (await makeFromSheet(t, first.reply)).body.plan.id;
    expect((await t.call(`/v1/plans/${id}/cancel`, "POST", {})).body.plan.status).toBe("cancelled");
    const second = await t.turn("/quiz the heart again", async (turn) => void (await t.tool(turn, "make_item", QUIZ)));
    const other = (await makeFromSheet(t, second.reply)).body.plan.id;
    await t.turn("stop that", async (turn) => {
      expect((await t.tool(turn, "stop_making", { thing: other })).text).toContain("Stopped");
    });
    expect((await t.call(`/v1/plans/${other}`)).body.plan.status).toBe("cancelled");
  });
});

describe("making without the chat", () => {
  it("settles a format's settings for the form, then makes it at once", async () => {
    const t = await setup();
    const settled = await t.call(`/v1/projects/${t.project.id}/make/settle`, "POST", { format: "quiz", about: "where each side sends blood" });
    expect(settled.status).toBe(200);
    expect(settled.body.plannedAs).toMatch(/^quiz/);
    expect(settled.body.issues).toEqual([]);
    const made = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "quiz", about: "where each side sends blood", settings: settled.body.settings });
    expect(made.status).toBe(200);
    expect(made.body.plan).toMatchObject({ direct: true, status: "running", title: "where each side sends blood" });
    expect(made.body.items[0].prompt).toContain("where each side sends blood");
    expect(t.queued).toHaveLength(1);
  });

  it("refuses with the reason when nothing can make it", async () => {
    const t = await setup(createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE, api: false } }));
    const made = await t.call(`/v1/projects/${t.project.id}/make`, "POST", { format: "quiz" });
    expect(made.status).toBe(409);
    expect(made.body.error).toBe("cannot_make_now");
    expect(made.body.message.length).toBeGreaterThan(10);
  });
});

describe("a video that will have no sound says so, in the maker's own words, wherever it is met", () => {
  const NOTE = "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.";
  const VIDEO = { format: "video", title: "The heart's two loops", brief: "Shows blood leaving each side of the heart.", settings: { minutes: 1 }, sources: [{ source: "S1" }] };

  async function silent() {
    const service = new FakeScenesService({ voice: { id: "silent", label: "No voice (made without sound)", real: false, note: NOTE } });
    const client = new ScenesClient({ url: "http://127.0.0.1:8670", token: service.token }, service.fetch);
    await refreshScenesStatus(client);
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE }, video: { makers: [createScenesMaker({ client, pollMs: 0, sleep: async () => undefined })] } });
    return setup(registry);
  }

  it("the Studio's form is told before it makes one, and the agent that plans reads it in the facts and when it makes one", async () => {
    const t = await silent();
    const settled = await t.call(`/v1/projects/${t.project.id}/make/settle`, "POST", { format: "video", about: "the heart" });
    expect(settled.body.notices).toEqual([NOTE]);
    // Another shape says nothing.
    expect((await t.call(`/v1/projects/${t.project.id}/make/settle`, "POST", { format: "quiz", about: "the heart" })).body.notices).toEqual([]);
    const first = await t.turn("/video the heart", async (turn) => {
      expect(turn.systemPrompt).toContain(`what the person should know about it now: ${NOTE}`);
      const opened = await t.tool(turn, "make_item", VIDEO);
      expect(opened.text).toContain(`Worth telling the person in that line, from what its maker says now: ${NOTE}`);
    });
    // The sheet carries it, and so does its row in the plan view once made, so the plan card, `opensourcebook item status` and an agent driving Open Sourcebook read the same.
    expect(first.reply.pieces.find((piece: { kind: string }) => piece.kind === "make").notices).toEqual([NOTE]);
    const id = (await makeFromSheet(t, first.reply)).body.plan.id;
    const view = (await t.call(`/v1/plans/${id}`)).body;
    expect(view.items[0].notices).toEqual([NOTE]);
  });

  it("a pick on the sheet makes that one thing with it and never becomes the default", async () => {
    const t = await silent();
    const first = await t.call(`/v1/projects/${t.project.id}/make`, "POST", {
      format: "video",
      about: "the heart",
      settings: { minutes: 1, agent: "agent:codex:gpt-6", effort: "max" },
    });
    expect(first.status).toBe(200);
    expect(first.body.items[0].settings).toMatchObject({ agent: "agent:codex:gpt-6", effort: "max" });
    // Nothing is remembered: the next sheet starts from the defaults set in Settings, and there are none.
    expect(await t.engine.deps.repos.providerSettings.listPicks((await t.engine.deps.repos.projects.get(t.project.id))!.ownerId)).toEqual([]);
    const settledAfter = await t.call(`/v1/projects/${t.project.id}/make/settle`, "POST", { format: "video", about: "the kidneys" });
    expect(settledAfter.body.settings.agent).toBeUndefined();
    expect(settledAfter.body.settings.effort).toBeUndefined();
  });
});
