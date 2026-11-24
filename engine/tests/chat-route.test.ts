/**
 * The chat routes (docs/api.md, "Chats") over the real repositories and
 * migrations, with a scripted provider: chats are stored and listed, a
 * reply cites the exact passage with a checked quote, the turn reads the
 * right sources, skills are forced or routed, and spend is logged per chat.
 */
import { describe, expect, it } from "vitest";
import { ANSWER_SYSTEM_PROMPT } from "../src/chat/answer";
import { ABOUT_OPENSOURCEBOOK, formatLine } from "../src/chat/about-opensourcebook";
import { renderHistory } from "../src/chat/context";
import { createTalkSkill, TALK_SYSTEM_PROMPT } from "../src/chat/talk";
import { say } from "../src/chat/pieces";
import { ROUTER_SYSTEM_PROMPT } from "../src/chat/router";
import { ChatService } from "../src/chat/service";
import { createDefaultSkills } from "../src/chat/default-skills";
import { SkillRegistry, type ChatSkill, type SkillTurn } from "../src/chat/skills";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { FormatRegistry } from "../src/studio/registry";
import { handleRequest } from "../src/index";
import { createDefaultConditions } from "../src/studio/conditions";
import type { StructuredGenerationRequest } from "../src/types";
import { authed, bodyOf, createTestEngine, PROVIDER_CALL_USD, type ProviderAnswer } from "./support/engine-harness";

const LIMITS = "A limit exists only when both one-sided limits agree.\n\nIf the left and right values differ, there is no limit at that point.";
const SERIES = "A geometric series converges when the ratio is smaller than one in absolute value.";

async function setup(options: { answer?: ProviderAnswer; skills?: SkillRegistry; registry?: FormatRegistry } = {}) {
  const engine = createTestEngine({ answer: (request) => options.answer?.(request) ?? {}, ...(options.skills ? { skills: options.skills } : {}), ...(options.registry ? { registry: options.registry } : {}) });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  const limits = (await call("/v1/sources", "POST", { text: LIMITS, projectId: project.id })).body.source;
  const series = (await call("/v1/sources", "POST", { text: SERIES, projectId: project.id })).body.source;
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  const answers = () => engine.provider.calls.filter((request) => request.systemPrompt === ANSWER_SYSTEM_PROMPT);
  return { engine, call, project, limits, series, chat, answers };
}

/** The label the prompt gave the passage holding `text`. */
function labelOf(request: StructuredGenerationRequest, text: string): string {
  const match = new RegExp(`\\[(P\\d+)\\][^\\n]*\\n${text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(request.userPrompt);
  if (!match) throw new Error(`no passage starting "${text.slice(0, 20)}" in the prompt`);
  return match[1];
}

describe("chats in a project", () => {
  it("creates, lists, opens and renames chats, and keeps the ticked sources", async () => {
    const t = await setup();
    expect(t.chat).toMatchObject({ projectId: t.project.id, messageCount: 0 });
    expect(t.chat.title).toBeUndefined();
    const named = await t.call(`/v1/projects/${t.project.id}/chats`, "POST", { title: "Exam", sources: [t.limits.id] });
    expect(named.status).toBe(201);
    expect(named.body.chat).toMatchObject({ title: "Exam", sources: [t.limits.id] });

    const listed = await t.call(`/v1/projects/${t.project.id}/chats`);
    expect(listed.body.chats).toHaveLength(2);
    const patched = await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { title: "Renamed", sources: [t.series.id] });
    expect(patched.body.chat).toMatchObject({ title: "Renamed", sources: [t.series.id] });
    const cleared = await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { sources: null });
    expect(cleared.body.chat.sources).toBeUndefined();
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body).toEqual({ chat: cleared.body.chat, messages: [] });
  });

  it("refuses sources from elsewhere, a bad body and another owner's chat", async () => {
    const t = await setup();
    const other = (await t.call("/v1/projects", "POST", { title: "Other" })).body.project;
    const stranger = (await t.call("/v1/sources", "POST", { text: "Elsewhere.", projectId: other.id })).body.source;
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { sources: [stranger.id] })).body.error).toBe("source_not_in_project");
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", sources: [stranger.id] })).body.error).toBe("source_not_in_project");
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "  " })).status).toBe(400);
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", mentions: [{ id: "x" }] })).status).toBe(400);
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", skill: "nothing" })).body.error).toBe("unknown_skill");
    expect((await t.call("/v1/chats/missing")).status).toBe(404);
    const foreign = await t.engine.deps.repos.sessions.create({ ownerId: "someone-else", projectId: t.project.id });
    expect((await t.call(`/v1/chats/${foreign.id}`)).status).toBe(404);
    // Nothing was stored for the refused turns.
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages).toEqual([]);
  });
});

describe("answers from sources", () => {
  it("answers with a cite at the exact passage and a checked quote, and stores both messages", async () => {
    const t = await setup({
      answer: (request) => ({
        parts: [
          { text: "Both one-sided limits have to agree.", cites: [{ passage: labelOf(request, LIMITS), quote: "both one-sided limits agree" }] },
          { text: "Otherwise there is none.", cites: [{ passage: labelOf(request, LIMITS), quote: "both one-sided limits agree" }, { passage: "P99" }] },
        ],
        covered: true,
      }),
    });
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    expect(sent.status).toBe(200);
    const [user, reply] = sent.body.messages;
    expect(user).toMatchObject({ role: "user", seq: 0, text: "When does a limit exist?", chatId: t.chat.id });
    const chunk = (await t.engine.deps.repos.sources.listChunks((await t.engine.deps.repos.sources.get(t.limits.id))!.contentHash))[0];
    expect(reply).toMatchObject({
      role: "assistant",
      seq: 1,
      text: "Both one-sided limits have to agree.\n\nOtherwise there is none.",
      covered: true,
      // The same cite twice is one cite; an unknown passage is dropped.
      pieces: [
        { kind: "text", text: "Both one-sided limits have to agree.", cites: [0] },
        { kind: "text", text: "Otherwise there is none.", cites: [0] },
      ],
      cites: [{ sourceId: t.limits.id, spot: "passage", chunkId: chunk.id, locator: chunk.locator, quote: "A limit exists only when both one-sided limits agree." }],
      usage: { calls: 1, usd: PROVIDER_CALL_USD },
    });
    expect(sent.body.chat).toMatchObject({ title: "When does a limit exist?", messageCount: 2 });
    expect(sent.body.chat.busySince).toBeUndefined();
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages).toEqual(sent.body.messages);
    expect((await t.call(`/v1/chats/${t.chat.id}/usage`)).body.usage).toMatchObject({ calls: 1, usd: PROVIDER_CALL_USD });
    expect((await t.call(`/v1/projects/${t.project.id}/usage`)).body.usage.calls).toBe(1);
  });

  it("asks once more for a quote that is not in its passage, then drops a quote that still is not", async () => {
    let round = 0;
    const t = await setup({
      answer: (request) => {
        round += 1;
        return { parts: [{ text: "Limits need agreement.", cites: [{ passage: labelOf(request, LIMITS), quote: round === 1 ? "limits always exist" : "still not there" }] }], covered: true };
      },
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Limits?" })).body.messages[1];
    expect(t.answers()).toHaveLength(2);
    expect(t.answers()[1].userPrompt).toContain('"limits always exist"');
    expect(reply.cites).toEqual([expect.objectContaining({ sourceId: t.limits.id, spot: "passage" })]);
    expect(reply.cites[0].quote).toBeUndefined();
  });

  it("says when the sources do not cover the question", async () => {
    const t = await setup({ answer: () => ({ parts: [{ text: "Your sources don't say anything about integrals.", cites: [] }], covered: false }) });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "What is an integral?" })).body.messages[1];
    expect(reply).toMatchObject({ covered: false, pieces: [{ kind: "text", cites: [] }] });
    expect(reply.cites).toBeUndefined();
  });

  it("reads the mentioned sources, else the ticked ones (kept on the chat), else all", async () => {
    const t = await setup({ answer: () => ({ parts: [{ text: "ok" }], covered: null }) });
    const prompt = () => t.answers().at(-1)!.userPrompt;
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    expect(prompt()).toContain(LIMITS.slice(0, 30));
    expect(prompt()).toContain(SERIES.slice(0, 30));

    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "series?", sources: [t.series.id] });
    expect(prompt()).not.toContain(LIMITS.slice(0, 30));
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.chat.sources).toEqual([t.series.id]);
    // The chat's ticked sources carry over to a turn that sends none.
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "again" });
    expect(prompt()).not.toContain(LIMITS.slice(0, 30));

    const mentioned = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "@Limits explain", mentions: [{ kind: "source", id: t.limits.id, label: "Limits" }] });
    expect(prompt()).toContain(LIMITS.slice(0, 30));
    expect(prompt()).not.toContain(SERIES.slice(0, 30));
    expect(mentioned.body.messages[0].mentions).toEqual([{ kind: "source", id: t.limits.id, label: "Limits" }]);
    // Earlier turns reach the model as the conversation so far.
    expect(prompt()).toContain("Person: series?");
  });

  it("refuses a second turn while one is being written, and takes over a stale one", async () => {
    const t = await setup({ answer: () => ({ parts: [{ text: "ok" }] }) });
    await t.engine.deps.repos.sessions.claimTurn(t.chat.id, "2000-01-01T00:00:00.000Z");
    const busy = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    expect(busy).toMatchObject({ status: 409, body: { error: "chat_busy" } });
    t.engine.clock.advance(5 * 60_000 + 1);
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" })).status).toBe(200);
  });

  it("keeps the question and says so when the model call fails", async () => {
    const t = await setup({
      answer: () => {
        throw new Error("upstream down");
      },
    });
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Limits?" });
    expect(sent.status).toBe(200);
    expect(sent.body.messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
    expect(sent.body.messages[1].text).toMatch(/couldn't write a reply/);
    // The data says it failed, so a client never reads that from the text.
    expect(sent.body.messages[1].failed).toEqual({ reason: "error" });
    expect(sent.body.messages[1].pieces).toEqual([{ kind: "text", text: sent.body.messages[1].text, cites: [] }]);
    expect(sent.body.chat.busySince).toBeUndefined();
    // Stored the same way: reading the chat back shows the marker.
    const read = await t.call(`/v1/chats/${t.chat.id}`);
    expect(read.body.messages[1].failed).toEqual({ reason: "error" });
  });

  it("marks only a reply it could not write as failed", async () => {
    const t = await setup({ answer: () => ({ parts: [{ text: "ok" }] }) });
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    expect(sent.body.messages[1]).not.toHaveProperty("failed");
  });

  it("stops at the turn's budget and says so", async () => {
    const t = await setup({ answer: (request) => ({ parts: [{ text: "x", cites: [{ passage: labelOf(request, LIMITS), quote: "not in it" }] }] }) });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Limits?", budgetUsd: 0.001 })).body.messages[1];
    // The first call spent past the budget, so the repair call never ran.
    expect(t.answers()).toHaveLength(1);
    expect(reply.text).toMatch(/budget of \$0\.00/);
    expect(reply.failed).toEqual({ reason: "budget", budgetUsd: 0.001 });
  });

  it("is unavailable without a provider, and stores nothing", async () => {
    const t = await setup();
    t.engine.deps.chat = new ChatService({
      repos: t.engine.deps.repos,
      registry: t.engine.deps.registry,
      skills: new SkillRegistry(),
      conditions: createDefaultConditions(),
      provider: () => undefined,
    });
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" })).body.error).toBe("chat_unavailable");
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages).toEqual([]);
  });
});

describe("skills", () => {
  function echo(seen: SkillTurn[]): ChatSkill {
    return {
      id: "echo",
      label: "echo",
      command: "echo",
      title: "Say it back",
      group: "chat",
      about: "Says the message back.",
      whenToUse: "the person asks to hear it back",
      async run(turn) {
        seen.push(turn);
        return { pieces: [say(`echo: ${turn.text}`)] };
      },
    };
  }

  it("lists skills, and a /command forces one without asking the router", async () => {
    const seen: SkillTurn[] = [];
    const t = await setup({ skills: new SkillRegistry().register(echo(seen)) });
    expect((await t.call("/v1/skills")).body).toEqual({
      skills: [{ id: "echo", label: "echo", command: "echo", about: "Says the message back." }],
      commands: [{ command: "echo", title: "Say it back", group: "chat", label: "echo", chatOnly: true, about: "Says the message back.", skill: "echo" }],
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/echo hello there" })).body.messages[1];
    expect(reply).toMatchObject({ text: "echo: hello there", skill: "echo" });
    expect(seen[0]).toMatchObject({ text: "hello there", how: "command" });
    expect(t.engine.provider.calls.some((request) => request.systemPrompt === ROUTER_SYSTEM_PROMPT)).toBe(false);
    // Naming the skill in the request is the same as its command.
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "again", skill: "echo" });
    expect(seen[1]).toMatchObject({ text: "again", how: "command" });
  });

  it("titles a chat from what was asked, without the command", async () => {
    const t = await setup({ skills: new SkillRegistry().register(echo([])) });
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/echo   limits at infinity\nand more" });
    expect(sent.body.chat.title).toBe("Limits at infinity");
    // A command with nothing after it, and a reply that names nothing, leave the chat untitled until a message asks something.
    const bare = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    expect((await t.call(`/v1/chats/${bare.id}/messages`, "POST", { text: "/echo" })).body.chat.title).toBeUndefined();
    expect((await t.call(`/v1/chats/${bare.id}/messages`, "POST", { text: "squeeze theorem", skill: "echo" })).body.chat.title).toBe("Squeeze theorem");
    // A word after "/" that is no command is part of what was asked.
    const other = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    expect((await t.call(`/v1/chats/${other.id}/messages`, "POST", { text: "/nope keep me", skill: "echo" })).body.chat.title).toBe("/nope keep me");
  });

  it("lets the router pick a skill or answer", async () => {
    const seen: SkillTurn[] = [];
    const t = await setup({
      skills: new SkillRegistry().register(echo(seen)),
      answer: (request) => (request.systemPrompt === ROUTER_SYSTEM_PROMPT ? { use: request.userPrompt.split("Message:\n").at(-1)!.includes("say it back") ? "echo" : "answer" } : { parts: [{ text: "an answer" }] }),
    });
    const routed = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "say it back please" })).body.messages[1];
    expect(routed).toMatchObject({ skill: "echo", text: "echo: say it back please" });
    expect(seen[0].how).toBe("routed");
    const answered = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "what is a limit" })).body.messages[1];
    expect(answered.text).toBe("an answer");
    expect(answered.skill).toBeUndefined();
    expect(answered.usage.calls).toBe(2);
  });

  it("refuses two skills with one command", () => {
    const registry = new SkillRegistry().register(echo([]));
    expect(() => registry.register({ ...echo([]), id: "other" })).toThrow(/already taken/);
  });

  it("refuses a command with no title or no group", () => {
    const { title: _title, ...untitled } = echo([]);
    expect(() => new SkillRegistry().register(untitled)).toThrow(/needs a title/);
    const { group: _group, ...ungrouped } = echo([]);
    expect(() => new SkillRegistry().register(ungrouped)).toThrow(/needs a group/);
  });
});

describe("one name for each command", () => {
  it("every default command has one title and a group, no two share a title, listed make, plan, then chat", async () => {
    const t = await setup({ skills: createDefaultSkills(), registry: createDefaultRegistry() });
    const { commands } = (await t.call("/v1/skills")).body as { commands: Array<{ command: string; title: string; group: string; chatOnly?: boolean }> };
    expect(commands.length).toBeGreaterThan(3);
    for (const command of commands) {
      expect(command.title.trim()).not.toBe("");
      expect(["make", "plan", "chat"]).toContain(command.group);
      expect(Boolean(command.chatOnly)).toBe(command.group === "chat");
    }
    expect(new Set(commands.map((command) => command.title.toLowerCase())).size).toBe(commands.length);
    const order = commands.map((command) => ["make", "plan", "chat"].indexOf(command.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(commands.filter((command) => command.group !== "make").map((command) => [command.command, command.title, command.group])).toEqual([
      ["plan", "Plan a whole subject", "plan"],
      ["teachback", "Explain it back", "chat"],
      ["mindmap", "Map the ideas", "chat"],
    ]);
  });

  it("a format registered in a test is a make command titled by its label, with no other change", async () => {
    const registry = createDefaultRegistry();
    const quiz = registry.require("quiz");
    registry.register({ ...quiz, descriptor: { ...quiz.descriptor, id: "riddle", label: "riddle", aliases: [], blurb: "questions told as riddles" }, engine: { ...quiz.engine, type: "riddle" } } as never);
    const t = await setup({ skills: createDefaultSkills(), registry });
    const { commands } = (await t.call("/v1/skills")).body as { commands: Array<Record<string, unknown>> };
    const riddle = commands.find((command) => command.command === "riddle");
    expect(riddle).toMatchObject({ title: "riddle", group: "make", about: "questions told as riddles", skill: "make", format: "riddle" });
    expect(commands.findIndex((command) => command.command === "riddle")).toBeLessThan(commands.findIndex((command) => command.command === "plan"));
  });
});

describe("questions in a reply", () => {
  function asker(seen: SkillTurn[]): ChatSkill {
    return {
      id: "asker",
      label: "ask",
      command: "ask",
      title: "Ask first",
      group: "chat",
      about: "Asks before it acts.",
      whenToUse: "never by itself",
      async run(turn) {
        seen.push(turn);
        return {
          pieces: [
            say("Before I start:"),
            { kind: "question", id: "q1", text: "Which part?", options: [{ id: "o1", label: "The first", skill: "asker" }, { id: "o2", label: "The second", skill: "asker" }], multiple: false },
            { kind: "question", id: "q2", text: "Anything else?", options: [{ id: "o1", label: "A", skill: "asker" }, { id: "o2", label: "B", skill: "asker" }], multiple: true },
          ],
        };
      },
    };
  }

  it("keeps the pieces in order, and a picked option hands the turn to its skill", async () => {
    const seen: SkillTurn[] = [];
    const t = await setup({ skills: new SkillRegistry().register(asker(seen)), answer: () => ({ use: "answer" }) });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/ask" })).body.messages[1];
    expect(reply.pieces.map((piece: any) => piece.kind)).toEqual(["text", "question", "question"]);
    expect(reply.text).toContain("Which part?\n(options: The first / The second)");

    const answer = { messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o2"] }, { questionId: "q2", optionIds: ["o1", "o2"] }] };
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "The second\nA, B", answer });
    expect(sent.status).toBe(200);
    expect(sent.body.messages[0]).toMatchObject({ role: "user", answer });
    expect(seen[1]).toMatchObject({ how: "picked", text: "The second\nA, B" });
    expect(t.engine.provider.calls.some((request) => request.systemPrompt === ROUTER_SYSTEM_PROMPT)).toBe(false);
  });

  it("refuses picks that do not fit the reply, and stores nothing", async () => {
    const t = await setup({ skills: new SkillRegistry().register(asker([])) });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/ask" })).body.messages[1];
    const send = (answer: unknown) => t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "x", answer });
    expect((await send({ messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o1", "o2"] }] })).body.error).toBe("invalid_answer");
    expect((await send({ messageId: reply.id, picks: [{ questionId: "q9", optionIds: ["o1"] }] })).body.error).toBe("invalid_answer");
    expect((await send({ messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o7"] }] })).body.error).toBe("invalid_answer");
    expect((await send({ messageId: "elsewhere", picks: [{ questionId: "q1", optionIds: ["o1"] }] })).body.error).toBe("invalid_answer");
    expect((await send({ messageId: reply.id, picks: [] })).status).toBe(400);
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages).toHaveLength(2);
  });

  it("may end an answer by offering a skill that says when it may be offered", async () => {
    const seen: SkillTurn[] = [];
    const offered: ChatSkill = { ...asker(seen), offerWhen: "the person seems ready" };
    const t = await setup({
      skills: new SkillRegistry().register(offered),
      answer: (request) =>
        request.systemPrompt === ROUTER_SYSTEM_PROMPT
          ? { use: "answer" }
          : { parts: [{ text: "Here is what they say." }], offer: { skill: "asker", question: "Shall I ask you more?", accept: "Yes", decline: "No thanks" } },
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hello" })).body.messages[1];
    expect(t.answers()[0].userPrompt).toContain("- asker: Asks before it acts. Offer it when: the person seems ready");
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Here is what they say.", cites: [] },
      { kind: "question", id: "q1", text: "Shall I ask you more?", options: [{ id: "o1", label: "Yes", skill: "asker" }, { id: "o2", label: "No thanks" }], multiple: false },
    ]);
    // Declining names no skill, so the router picks; accepting runs the skill.
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "No thanks", answer: { messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o2"] }] } });
    expect(seen).toHaveLength(0);
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Yes", answer: { messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o1"] }] } });
    expect(seen[0].how).toBe("picked");
    expect(renderHistory(seen[0].history, 2_000)).toContain("Person (picked): No thanks");
  });

  it("drops an offer of a skill that may not be offered", async () => {
    const t = await setup({
      skills: new SkillRegistry().register(asker([])),
      answer: (request) => (request.systemPrompt === ROUTER_SYSTEM_PROMPT ? { use: "answer" } : { parts: [{ text: "ok" }], offer: { skill: "asker", question: "?", accept: "Yes" } }),
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hello" })).body.messages[1];
    expect(reply.pieces.map((piece: any) => piece.kind)).toEqual(["text"]);
    expect(t.answers()[0].userPrompt).not.toContain("Open Sourcebook can also do");
  });
});

describe("mentions tick their sources", () => {
  it("adds a mentioned source to the chat's ticked sources", async () => {
    const t = await setup({ answer: () => ({ parts: [{ text: "ok" }] }) });
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", {
      text: "@Limits too",
      sources: [t.series.id],
      mentions: [{ kind: "source", id: t.limits.id }],
    });
    expect(sent.body.chat.sources).toEqual([t.series.id, t.limits.id]);
    // The message keeps what was ticked when it was sent.
    expect(sent.body.messages[0].sources).toEqual([t.series.id]);
    // With nothing ticked or saved, every source is ticked already: nothing to add.
    const fresh = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    const all = await t.call(`/v1/chats/${fresh.id}/messages`, "POST", { text: "@Limits", mentions: [{ kind: "source", id: t.limits.id }] });
    expect(all.body.chat.sources).toBeUndefined();
  });
});

describe("talk about Open Sourcebook and the conversation", () => {
  it("goes to the talk skill, which knows Open Sourcebook's formats and their state and never cites", async () => {
    const t = await setup({
      skills: new SkillRegistry().register(createTalkSkill()),
      answer: (request) =>
        request.systemPrompt === ROUTER_SYSTEM_PROMPT
          ? { use: request.userPrompt.split("Message:\n").at(-1)!.includes("what can you make") ? "talk" : "sources" }
          : request.systemPrompt === TALK_SYSTEM_PROMPT
            ? { parts: [{ text: "Bytes and quizzes now; video is not made yet." }] }
            : { parts: [{ text: "from the sources" }] },
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "what can you make?" })).body.messages[1];
    expect(reply).toMatchObject({ skill: "talk", pieces: [{ kind: "text", text: "Bytes and quizzes now; video is not made yet.", cites: [] }] });
    expect(reply.cites).toBeUndefined();
    expect(reply.covered).toBeUndefined();
    const prompt = t.engine.provider.calls.find((request) => request.systemPrompt === TALK_SYSTEM_PROMPT)!.userPrompt;
    expect(prompt).toContain(ABOUT_OPENSOURCEBOOK);
    // Every declared format, with whether it can be made now, from the registry.
    for (const format of t.engine.deps.registry.views()) expect(prompt).toContain(formatLine(format));
    expect(prompt).toContain("- talk: Talks about Open Sourcebook itself");
    expect(prompt).toContain("Sources in this project:");
    // A question about the sources still goes to the sources.
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Limits?" })).body.messages[1].text).toBe("from the sources");
  });

  it("reads anything but a registered skill from the router as the sources", async () => {
    const t = await setup({
      skills: new SkillRegistry().register(createTalkSkill()),
      answer: (request) => (request.systemPrompt === ROUTER_SYSTEM_PROMPT ? { use: "nonsense" } : { parts: [{ text: "from the sources" }] }),
    });
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hm" })).body.messages[1].skill).toBeUndefined();
  });
});

describe("what the chat says about Open Sourcebook", () => {
  it("says what of Open Sourcebook reaches the web, as the README's Privacy section does", () => {
    // The video agent searches the web and link sources are fetched, so "Open Sourcebook does not search the web" would be false.
    expect(ABOUT_OPENSOURCEBOOK).not.toMatch(/does not search the web/);
    expect(ABOUT_OPENSOURCEBOOK).toMatch(/chat itself does not browse the web/);
    expect(ABOUT_OPENSOURCEBOOK).toMatch(/link source/);
    expect(ABOUT_OPENSOURCEBOOK).toMatch(/making a video may search the web/);
  });
});
