/**
 * Every turn the engine or a maker hands the connector names an agent, since
 * the connector has none of its own unless the person set one (OPENSOURCEBOOK_AGENT):
 * the chat, the quick makers (`AgentWork.run`), the video maker's request to
 * the scenes service and a plan's items. With nothing picked, the shape's
 * default from Settings is used, else the only provider that can; with
 * several the person is asked (409 pick_needed) and nothing is made.
 */
import { describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import { AgentWork, forgetAgentStatus } from "../src/chat/agent/work";
import { PickNeededError, pickNeededWords } from "../src/chat/providers";
import { agentField, settleWorkPick, workPickFor } from "../src/engines/agent-fields";
import { createAgentQuizMaker } from "../src/engines/quiz/agent-maker";
import { createQuizDefinition, type QuizSettings } from "../src/engines/quiz/definition";
import { handleRequest } from "../src/index";
import { InMemoryUsageSink } from "../src/providers/usage";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { openAgentScopes, PlanRunner } from "../src/studio/plan-runner";
import type { PlanNode } from "../src/studio/repositories";
import type { EngineContext } from "../src/studio/types";
import type { FetchLike } from "../src/types";
import { pickChecker, workPickSettler } from "../src/wiring";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const CONNECTOR = "http://127.0.0.1:8662";

/** A connector reporting these agents as ready, with an agent of its own only when `own` is given; it records each turn. */
function connector(ids: string[], own?: string) {
  const turns: Array<{ agent?: string }> = [];
  const state = { reachable: true };
  const fetch: FetchLike = async (input, init) => {
    if (!state.reachable) throw new TypeError("fetch failed: connection refused");
    const url = new URL(String(input));
    if (url.pathname === "/status") {
      return Response.json({ ...(own ? { agent: own } : {}), agents: ids.map((id) => ({ id, label: id, installed: true, signedIn: true })) });
    }
    if (url.pathname === "/turns") {
      turns.push(JSON.parse(String(init?.body)) as { agent?: string });
      return Response.json({ ok: false, problem: "error", message: "not this time" }, { status: 500 });
    }
    return Response.json({ ok: true });
  };
  return { fetch, turns, state };
}

function work(fetch: FetchLike): AgentWork {
  return new AgentWork({ url: CONNECTOR, token: "connector-token", callbackUrl: "http://127.0.0.1:8802", timeoutMs: 60_000 }, fetch, { pollMs: 5, settleMs: 0, sleep: async () => undefined });
}

function quizSettings(): QuizSettings {
  const parsed = createQuizDefinition().parseSettings({ questions: 2 });
  if (!parsed.ok) throw new Error("bad settings");
  return parsed.settings;
}

const view = (id: string) => ({ id, label: id, local: true as const, added: true, enabled: true, state: "ready" as const, headline: "Ready", pick: `agent:${id}`, models: [], efforts: [] });

describe("a maker's turn that names no agent", () => {
  it("is settled from the shape's default, the person's own agent, or the only provider that can", () => {
    const two = [view("claude"), view("codex")];
    expect(settleWorkPick("quiz", { agent: "codex", effort: "low" }, undefined, two)).toEqual({ agent: "codex", effort: "low" });
    expect(settleWorkPick("quiz", {}, { quiz: { agent: "codex", model: "gpt-6", effort: "high" } }, two)).toEqual({ agent: "codex", model: "gpt-6", effort: "high" });
    // The item's own effort wins over the default's.
    expect(settleWorkPick("quiz", { effort: "low" }, { quiz: { agent: "codex", effort: "high" } }, two)).toEqual({ agent: "codex", effort: "low" });
    expect(settleWorkPick("quiz", {}, { chat: { agent: "codex" } }, two, "claude")).toEqual({ agent: "claude" });
    expect(settleWorkPick("quiz", {}, { quiz: { effort: "low" } }, [view("claude")])).toEqual({ agent: "claude", effort: "low" });
    expect(() => settleWorkPick("quiz", {}, { chat: { agent: "codex" } }, two)).toThrow(PickNeededError);
    expect(settleWorkPick("quiz", {}, undefined, [])).toBeUndefined();
  });

  it("asks the job's settler only when the item names no agent", async () => {
    const asked: string[] = [];
    const ctx = (agent?: string) =>
      ({
        node: { type: "quiz", settings: agent ? { agent } : {} },
        services: { settlePick: async (scope: string) => (asked.push(scope), { agent: "codex" }) },
      }) as unknown as EngineContext<{ agent?: string }>;
    expect(await workPickFor(ctx("agent:claude:sonnet"))).toEqual({ agent: "claude", model: "sonnet" });
    expect(asked).toEqual([]);
    expect(await workPickFor(ctx())).toEqual({ agent: "codex" });
    expect(asked).toEqual(["quiz"]);
  });

  it("reaches the connector with the settled agent from a quick maker", async () => {
    forgetAgentStatus();
    const fake = connector(["claude", "codex"]);
    const maker = createAgentQuizMaker({ work: work(fake.fetch) });
    const ctx = {
      jobId: "job-1",
      node: { id: "node-1", type: "quiz", title: "Heat", prompt: "Ask about heat.", settings: quizSettings() },
      sources: [{ sourceId: "s1", title: "Heat", envelope: { originalText: "Heat flows.", kind: "text", title: "Heat", text: "Heat flows from warm to cool.", references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-22T09:00:00.000Z" }, chunks: [{ id: "c1", ord: 0, text: "Heat flows from warm to cool.", locator: { charStart: 0, charEnd: 29 } }] }],
      assumes: [],
      inputs: [],
      services: {
        provider: { name: "none", generateJSON: async () => { throw new Error("no model is called"); } },
        assets: createNullAssetStore(),
        usage: new InMemoryUsageSink(),
        fetch: async () => new Response(null),
        now: () => "2026-11-22T09:00:00.000Z",
        progress: () => undefined,
        settlePick: async () => ({ agent: "codex", model: "gpt-6" }),
      },
    } as unknown as EngineContext;
    const failed = await maker.engine.generate(ctx as never, { kinds: [] } as never).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(fake.turns.map((turn) => turn.agent)).toEqual(["codex"]);
  });

  it("is settled for a job's owner from Settings and the providers the connector reports", async () => {
    const engine = createTestEngine();
    const repos = engine.deps.repos;
    const one = connector(["claude"]);
    expect(await workPickSettler(repos, work(one.fetch))("owner-1", "quiz", {})).toEqual({ agent: "claude" });
    const two = connector(["claude", "codex"]);
    const settle = workPickSettler(repos, work(two.fetch));
    await expect(settle("owner-1", "video", {})).rejects.toThrow(PickNeededError);
    await repos.providerSettings.setPick("owner-1", "video", { agent: "codex", model: "gpt-6" });
    expect(await settle("owner-1", "video", { effort: "high" })).toEqual({ agent: "codex", model: "gpt-6", effort: "high" });
    // The connector's own agent, when the person named one there.
    expect(await workPickSettler(repos, work(connector(["claude", "codex"], "codex").fetch))("owner-1", "quiz", {})).toEqual({ agent: "codex" });
    expect(await workPickSettler(repos, work(connector([]).fetch))("owner-1", "quiz", {})).toBeUndefined();
    // Not reachable: sent as it is, and the turn says the connector is not running.
    two.state.reachable = false;
    expect(await settle("owner-1", "quiz", { effort: "low" })).toEqual({ effort: "low" });
  });
});

describe("Start and making one thing", () => {
  it("lists the formats of the items to make whose agent is open, for the makers that run it", () => {
    const agentWork = work(connector(["claude"]).fetch);
    const registry = createDefaultRegistry({ quiz: { api: true, makers: [createAgentQuizMaker({ work: agentWork })] } });
    const node = (id: string, type: string, settings: Record<string, unknown>, more: Partial<PlanNode> = {}) => ({ id, type, settings, enabled: true, status: "pending", ...more }) as PlanNode;
    expect(
      openAgentScopes(
        [
          node("a", "quiz", { maker: "agent" }),
          node("b", "quiz", { maker: "agent", agent: "agent:claude" }),
          node("c", "quiz", { maker: "agent" }, { status: "done" }),
          node("d", "quiz", { maker: "agent" }, { enabled: false }),
        ],
        registry,
      ),
    ).toEqual(["quiz"]);
    expect(openAgentScopes([node("e", "quiz", { maker: "api" }), node("f", "quiz", { maker: "agent", agent: "agent:codex" })], registry)).toEqual([]);
    expect(openAgentScopes([node("g", "quiz", { maker: "agent", agent: "auto" })], registry)).toEqual(["quiz"]);
  });

  it("answers 409 pick_needed and keeps nothing when several providers could make it and none is picked", async () => {
    forgetAgentStatus();
    const fake = connector(["claude", "codex"]);
    const agentWork = work(fake.fetch);
    const registry = createDefaultRegistry({ quiz: { api: false, makers: [createAgentQuizMaker({ work: agentWork })] } });
    const engine = createTestEngine({ registry });
    const queued: string[] = [];
    engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, checkPick: pickChecker(engine.deps.repos, agentWork), schedule: async (id) => void queued.push(id) });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    const project = (await call("/v1/projects", "POST", { title: "Heat" })).body.project;
    await call("/v1/sources", "POST", { text: "Heat flows from a warmer body to a cooler one until both are the same.", projectId: project.id });
    const refused = await call(`/v1/projects/${project.id}/make`, "POST", { format: "quiz" });
    expect(refused).toEqual({ status: 409, body: { error: "pick_needed", message: pickNeededWords(["quiz"]), scope: "quiz", scopes: ["quiz"] } });
    expect(queued).toEqual([]);
    expect((await call(`/v1/projects/${project.id}/plans`)).body.plans ?? []).toEqual([]);
    expect(fake.turns).toEqual([]);
    // With the shape's default set in Settings, it starts.
    const owner = (await engine.deps.repos.projects.get(project.id))!.ownerId;
    await engine.deps.repos.providerSettings.setPick(owner, "quiz", { agent: "codex" });
    const made = await call(`/v1/projects/${project.id}/make`, "POST", { format: "quiz" });
    expect(made.status).toBe(200);
    expect(queued).toHaveLength(1);
  });
});

describe("who answers a chat that picked nobody", () => {
  const chatWith = (ids: string[], own?: string) => {
    const fake = connector(ids, own);
    const engine = createTestEngine({ agent: { fetch: fake.fetch, config: { agent: undefined } } });
    return { chat: engine.deps.chat!, repos: engine.deps.repos };
  };

  it("is the only provider that can answer, or the person is asked", async () => {
    expect(await chatWith(["claude"]).chat.answering("owner-1", undefined)).toEqual({ agent: "claude" });
    await expect(chatWith(["claude", "codex"]).chat.answering("owner-1", undefined)).rejects.toThrow(PickNeededError);
    // "agent" alone, with no agent of the engine's own, is decided the same way.
    expect(await chatWith(["codex"]).chat.answering("owner-1", "agent")).toEqual({ agent: "codex" });
    await expect(chatWith([]).chat.answering("owner-1", undefined)).rejects.toThrow("None of your providers can answer.");
  });

  it("is the connector's own agent when the person named one there, and the chat's pick from Settings first", async () => {
    expect(await chatWith(["claude", "codex"], "codex").chat.answering("owner-1", undefined)).toEqual({ agent: "codex" });
    const { chat, repos } = chatWith(["claude", "codex"]);
    await repos.providerSettings.setPick("owner-1", "chat", { agent: "claude", model: "sonnet", effort: "high" });
    expect(await chat.answering("owner-1", undefined)).toEqual({ agent: "claude", model: "sonnet", effort: "high" });
    // The provider list marks the chat's pick as the default, and nothing else.
    const listed = await chat.providers("owner-1");
    expect(listed.providers.map((provider) => [provider.id, provider.default, provider.defaultModel, provider.defaultEffort])).toEqual([
      ["claude", true, "sonnet", "high"],
      ["codex", undefined, undefined, undefined],
    ]);
  });
});
