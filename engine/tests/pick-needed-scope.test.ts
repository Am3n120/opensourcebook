/**
 * A pick_needed answer names the scope that really needs a pick, in words and as `scope` (with every scope the
 * request needs in `scopes`), so the web app and the opensourcebook command open or name the right one. A thing made from the
 * terminal goes through a chat turn that settles it and then its shape's maker: the maker is checked first, and the
 * chat's pick is needed only because that turn runs. Making it with no chat turn never needs the chat's pick.
 */
import { describe, expect, it } from "vitest";
import { AgentChat } from "../src/chat/agent/turn";
import { createDefaultTools } from "../src/chat/agent/default-tools";
import { AgentWork, forgetAgentStatus } from "../src/chat/agent/work";
import { createDefaultSkills } from "../src/chat/default-skills";
import { PickNeededError, pickNeededWords } from "../src/chat/providers";
import { ChatService } from "../src/chat/service";
import { createAgentQuizMaker } from "../src/engines/quiz/agent-maker";
import { handleRequest } from "../src/index";
import { createDefaultConditions } from "../src/studio/conditions";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { PlanRunner } from "../src/studio/plan-runner";
import type { FetchLike } from "../src/types";
import { pickChecker } from "../src/wiring";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

/** A connector with two ready agents and none of its own; it records each turn handed to it. */
function connector() {
  const turns: unknown[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/status") return Response.json({ agents: ["claude", "codex"].map((id) => ({ id, label: id, installed: true, signedIn: true })) });
    if (url.pathname === "/turns") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: false, problem: "error", message: "not this time" }, { status: 500 });
    }
    return Response.json({ ok: true });
  };
  return { fetch, turns };
}

async function setUp() {
  forgetAgentStatus();
  const fake = connector();
  const work = new AgentWork({ url: "http://127.0.0.1:8662", token: "connector-token", callbackUrl: "http://127.0.0.1:8802", timeoutMs: 60_000 }, fake.fetch, { pollMs: 5, settleMs: 0, sleep: async () => undefined });
  const registry = createDefaultRegistry({ quiz: { api: false, makers: [createAgentQuizMaker({ work })] } });
  const engine = createTestEngine({ registry });
  const plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, checkPick: pickChecker(engine.deps.repos, work), schedule: async () => undefined });
  engine.deps.plans = plans;
  engine.deps.chat = new ChatService({
    repos: engine.deps.repos,
    registry,
    skills: createDefaultSkills(),
    conditions: createDefaultConditions(),
    plans,
    provider: () => undefined,
    agent: new AgentChat({ url: "http://127.0.0.1:8662", token: "connector-token", agent: undefined, timeoutMs: 60_000 }, createDefaultTools(), fake.fetch),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Heat" })).body.project;
  await call("/v1/sources", "POST", { text: "Heat flows from a warmer body to a cooler one until both are the same.", projectId: project.id });
  const owner = (await engine.deps.repos.projects.get(project.id))!.ownerId;
  const ask = async (text: string, from?: "terminal") => {
    const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
    return call(`/v1/chats/${chat.id}/messages`, "POST", { text, ...(from ? { from } : {}) });
  };
  return { engine, call, project, owner, ask, fake };
}

describe("which pick a request needs", () => {
  it("says it in words of the scope: the chat, a shape's maker, a reviewer, or several", () => {
    expect(pickNeededWords(["chat"])).toBe("Several of your agents could answer the chat and none is picked: pick who answers in the chat's picker, or for every chat in Settings, What makes what.");
    expect(pickNeededWords(["flashcards"])).toBe("Several of your agents could do it and none is picked: pick who makes flashcards in Settings, What makes what.");
    expect(pickNeededWords(["video.review"])).toBe("Several of your agents could do it and none is picked: pick who reviews video in Settings, What makes what.");
    expect(pickNeededWords(["chat", "quiz"])).toBe("Several of your agents could do it and none is picked: pick who makes quiz and who answers the chat (the chat settles what it will be), in Settings, What makes what.");
    const error = new PickNeededError("quiz", ["chat", "quiz"]);
    expect([error.scope, error.scopes]).toEqual(["quiz", ["quiz", "chat"]]);
  });

  it("a thing made from the terminal names its shape's maker first, then the chat that settles it", async () => {
    const { ask, owner, engine, fake } = await setUp();
    const both = await ask("/quiz two questions on heat", "terminal");
    expect(both.status).toBe(409);
    expect(both.body).toMatchObject({ error: "pick_needed", scope: "quiz", scopes: ["quiz", "chat"] });
    expect(both.body.message).toContain("who makes quiz and who answers the chat");

    // With the chat picked, only the shape's maker blocks it.
    await engine.deps.repos.providerSettings.setPick(owner, "chat", { agent: "claude" });
    const maker = await ask("/quiz two questions on heat", "terminal");
    expect(maker.body).toEqual({ error: "pick_needed", message: pickNeededWords(["quiz"]), scope: "quiz", scopes: ["quiz"] });

    // With the shape's maker picked and the chat not, the chat is what blocks it, since its turn settles the quiz.
    await engine.deps.repos.providerSettings.setPick(owner, "chat", { agent: null });
    await engine.deps.repos.providerSettings.setPick(owner, "quiz", { agent: "codex" });
    const chat = await ask("/quiz two questions on heat", "terminal");
    expect(chat.body).toEqual({ error: "pick_needed", message: pickNeededWords(["chat"]), scope: "chat", scopes: ["chat"] });
    // Nothing was handed to an agent while a pick was missing.
    expect(fake.turns).toEqual([]);
  });

  it("a message in the app that makes nothing at once needs only the chat's pick", async () => {
    const { ask } = await setUp();
    for (const sent of [await ask("/quiz two questions on heat"), await ask("what is heat?", "terminal")]) {
      expect(sent.body).toMatchObject({ error: "pick_needed", scope: "chat", scopes: ["chat"] });
    }
  });

  it("making it with no chat turn never needs the chat's pick", async () => {
    const { call, project, owner, engine } = await setUp();
    const refused = await call(`/v1/projects/${project.id}/make`, "POST", { format: "quiz" });
    expect(refused.body).toEqual({ error: "pick_needed", message: pickNeededWords(["quiz"]), scope: "quiz", scopes: ["quiz"] });
    await engine.deps.repos.providerSettings.setPick(owner, "quiz", { agent: "codex" });
    expect((await call(`/v1/projects/${project.id}/make`, "POST", { format: "quiz" })).status).toBe(200);
  });
});
