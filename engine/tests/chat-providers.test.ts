/**
 * The person's providers and who answers a chat (docs/api.md, "Providers";
 * DECISIONS #62), over the real routes and repositories with a fake
 * connector: the engine lists the agents the connector reports with what to
 * do for each that can't answer, keeps which are in the list and on, which
 * models show and which are starred, hands each turn to the chat's pick and
 * effort, and never falls back to Open Sourcebook's own model while a connector is set up.
 */
import { describe, expect, it } from "vitest";
import { parsePick, pickId } from "../src/chat/providers";
import { ChatService } from "../src/chat/service";
import { handleRequest } from "../src/index";
import { createDefaultConditions } from "../src/studio/conditions";
import { FormatRegistry } from "../src/studio/registry";
import { agentField, reviewerField } from "../src/engines/agent-fields";
import type { FetchLike } from "../src/types";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const CODEX_UNAVAILABLE = "Open Sourcebook can't run Codex yet: it can't be started with its own shell turned off.";

/** A connector with Claude Code, Codex and an agent that isn't installed; records the turns it is handed and how often it was asked fresh. */
function fakeConnector(claude: { signedIn?: boolean; apiKey?: boolean; note?: string } = {}) {
  const started: Array<{ agent?: string; model?: string; effort?: string }> = [];
  const asked = { fresh: 0 };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/status") {
      if (url.searchParams.get("fresh") === "1") asked.fresh++;
      return Response.json({
        agent: "claude",
        model: "haiku",
        agents: [
          {
            id: "claude",
            label: "Claude Code",
            installed: true,
            signedIn: claude.signedIn ?? true,
            ...(claude.apiKey ? { apiKey: true } : {}),
            ...(claude.note ? { note: claude.note } : {}),
            version: "2.1.0",
            signIn: "claude auth login",
            models: [{ id: "haiku", label: "Haiku" }, { id: "opus", label: "Opus" }, { id: "bad id", label: "x" }],
            efforts: [{ id: "low", label: "Low" }, { id: "max", label: "Max" }],
          },
          { id: "codex", label: "Codex", installed: true, signedIn: true, unavailable: CODEX_UNAVAILABLE, signIn: "codex login" },
          { id: "pi", label: "Pi", installed: false },
        ],
      });
    }
    if (url.pathname === "/turns") {
      started.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true }, { status: 202 });
    }
    return Response.json({ ok: true });
  };
  return { fetch, started, asked };
}

async function setup(options: { connector?: ReturnType<typeof fakeConnector> | false } = {}) {
  const connector = options.connector === false ? undefined : (options.connector ?? fakeConnector());
  const engine = createTestEngine({ answer: () => ({ parts: [{ text: "an answer" }] }), ...(connector ? { agent: { fetch: connector.fetch, config: { model: "haiku" } } } : {}) });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  await call("/v1/sources", "POST", { text: "A limit exists only when both one-sided limits agree.", projectId: project.id });
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  return { engine, call, chat, started: connector?.started ?? [], asked: connector?.asked ?? { fresh: 0 } };
}

describe("provider picks", () => {
  it("reads every kind of pick and writes it back the same", () => {
    for (const id of ["agent", "agent:claude", "agent:claude:opus", "agent:claude:claude-sonnet-4.5"]) expect(pickId(parsePick(id)!)).toBe(id);
    expect(parsePick("agent:claude:opus")).toEqual({ agent: "claude", model: "opus" });
    for (const bad of ["", "re", "re:deepseek", "agent::opus", "agent:claude:opus:x", "agent:has space"]) expect(parsePick(bad)).toBeUndefined();
  });
});

describe("providers", () => {
  it("lists the connector's agents, what each needs, and the models each shows", async () => {
    const t = await setup();
    const listed = await t.call("/v1/providers");
    expect(listed.body).toEqual({
      connector: { configured: true, reachable: true, checkedAt: expect.any(String) },
      providers: [
        {
          id: "claude",
          label: "Claude Code",
          local: true,
          added: true,
          enabled: true,
          state: "ready",
          headline: "Ready",
          signIn: "claude auth login",
          version: "2.1.0",
          pick: "agent:claude",
          models: [
            { id: "haiku", pick: "agent:claude:haiku", label: "Haiku", shown: true, favorite: false },
            { id: "opus", pick: "agent:claude:opus", label: "Opus", shown: true, favorite: false },
          ],
          efforts: [
            { id: "low", label: "Low" },
            { id: "max", label: "Max" },
          ],
        },
        { id: "codex", label: "Codex", local: true, added: true, enabled: true, state: "unavailable", headline: "Can't run yet", detail: CODEX_UNAVAILABLE, signIn: "codex login", pick: "agent:codex", models: [], efforts: [] },
        {
          id: "pi",
          label: "Pi",
          local: true,
          added: false,
          enabled: true,
          state: "missing",
          headline: "Not installed",
          detail: "Install Pi on your computer, then check again.",
          pick: "agent:pi",
          models: [],
          efforts: [],
        },
      ],
    });
    expect(t.asked.fresh).toBe(0);
    await t.call("/v1/providers?fresh=1");
    expect(t.asked.fresh).toBe(1);
  });

  it("passes on each provider's logo and its models' makers' logos, and drops any that is not plain drawing", async () => {
    const mark = { path: "M0 0h24v24H0z", color: "#D97757" };
    const connector = fakeConnector();
    const fetch: FetchLike = async (input, init) => {
      if (new URL(String(input)).pathname !== "/status") return connector.fetch(input, init);
      return Response.json({
        agent: "claude",
        agents: [
          {
            id: "claude",
            label: "Claude Code",
            installed: true,
            mark,
            models: [{ id: "haiku", label: "Haiku", maker: "anthropic" }, { id: "own", label: "Own", maker: "nobody" }, { id: "free", label: "Free" }],
            makers: { anthropic: { label: "Anthropic", mark: { path: "M1 1L2 2z" } }, unused: { label: "Unused", mark }, nobody: { label: "Nobody", mark: { path: "<script>" } } },
          },
          { id: "odd", label: "Odd", installed: true, mark: { path: "M0 0\"/><script>", color: "red" } },
          { id: "tinted", label: "Tinted", installed: true, mark: { path: "M0 0z", color: "url(#x)" } },
        ],
      });
    };
    const t = await setup({ connector: { ...connector, fetch } });
    const [claude, odd, tinted] = (await t.call("/v1/providers")).body.providers;
    expect(claude.mark).toEqual(mark);
    expect(claude.models.map((model: { maker?: string }) => model.maker)).toEqual(["anthropic", undefined, undefined]);
    expect(claude.makers).toEqual({ anthropic: { label: "Anthropic", mark: { path: "M1 1L2 2z" } } });
    expect(odd.mark).toBeUndefined();
    expect(odd.makers).toBeUndefined();
    expect(tinted.mark).toEqual({ path: "M0 0z" });
  });

  it("says how to sign in to one that is signed out", async () => {
    const t = await setup({ connector: fakeConnector({ signedIn: false }) });
    const [claude] = (await t.call("/v1/providers")).body.providers;
    expect(claude).toMatchObject({ state: "signedOut", headline: "Not signed in", detail: "Run this on your computer, then check again.", signIn: "claude auth login" });
  });

  it("calls one that is not signed in but answers with the person's API key ready, and says how it answers", async () => {
    const note = "Answers with the Anthropic API key in Open Sourcebook's connector settings, billed to that key, as Claude Code is not signed in.";
    const t = await setup({ connector: fakeConnector({ signedIn: false, apiKey: true, note }) });
    const [claude] = (await t.call("/v1/providers")).body.providers;
    expect(claude).toMatchObject({ state: "ready", headline: "Ready", detail: note });
    // Served whatever the state, so "How to connect" can show it.
    expect(claude.signIn).toBe("claude auth login");
    const plain = await setup();
    expect((await plain.call("/v1/providers")).body.providers[0].detail).toBeUndefined();
  });

  it("keeps which providers are on and which models show", async () => {
    const t = await setup();
    const hidden = await t.call("/v1/providers/claude", "PATCH", { hiddenModels: ["opus"] });
    expect(hidden.body.providers[0].models.map((model: { id: string; shown: boolean }) => [model.id, model.shown])).toEqual([
      ["haiku", true],
      ["opus", false],
    ]);
    const off = await t.call("/v1/providers/codex", "PATCH", { enabled: false });
    expect(off.body.providers.map((provider: { id: string; enabled: boolean }) => [provider.id, provider.enabled])).toEqual([
      ["claude", true],
      ["codex", false],
      ["pi", true],
    ]);
    const starred = await t.call("/v1/providers/claude", "PATCH", { favoriteModels: ["opus"] });
    expect(starred.body.providers[0].models.map((model: { id: string; favorite: boolean }) => [model.id, model.favorite])).toEqual([
      ["haiku", false],
      ["opus", true],
    ]);
    // One not installed joins the list when added, and one installed leaves it when removed.
    const added = await t.call("/v1/providers/pi", "PATCH", { added: true });
    const removed = await t.call("/v1/providers/codex", "PATCH", { added: false });
    expect(added.body.providers.find((provider: { id: string }) => provider.id === "pi").added).toBe(true);
    expect(removed.body.providers.find((provider: { id: string }) => provider.id === "codex").added).toBe(false);
    expect((await t.call("/v1/providers/claude", "PATCH", {})).status).toBe(400);
    expect((await t.call("/v1/providers/claude", "PATCH", { added: "yes" })).status).toBe(400);
    expect((await t.call("/v1/providers/claude", "PATCH", { favoriteModels: ["bad id"] })).status).toBe(400);
    expect((await t.call("/v1/providers/claude", "PATCH", { enabled: "yes" })).status).toBe(400);
  });

  it("is empty, and says so, with no connector", async () => {
    const t = await setup({ connector: false });
    expect((await t.call("/v1/providers")).body).toEqual({ connector: { configured: false, reachable: false }, providers: [] });
    expect((await t.call("/v1/providers/claude", "PATCH", { enabled: false })).status).toBe(503);
  });
});

describe("who answers a chat", () => {
  it("hands a turn to the picked provider and model, and keeps the pick on the chat", async () => {
    const t = await setup();
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?", answerer: "agent:claude:opus" });
    expect(sent.status).toBe(200);
    expect(sent.body.chat.answerer).toBe("agent:claude:opus");
    expect(sent.body.messages[1]).toMatchObject({ state: "running", agent: "claude" });
    expect(t.started).toEqual([expect.objectContaining({ agent: "claude", model: "opus" })]);
  });

  it("hands the chat's effort to whoever answers, and keeps it on the chat", async () => {
    const t = await setup();
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", answerer: "agent:claude:opus", effort: "max" });
    expect(sent.body.chat).toMatchObject({ answerer: "agent:claude:opus", effort: "max" });
    expect(t.started[0]).toMatchObject({ agent: "claude", model: "opus", effort: "max" });
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { effort: "low" })).body.chat.effort).toBe("low");
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { effort: "not an effort" })).status).toBe(400);
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { effort: null })).body.chat.effort).toBeUndefined();
  });

  it("refuses a provider removed from the list", async () => {
    const t = await setup();
    await t.call("/v1/providers/claude", "PATCH", { added: false });
    const picked = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", answerer: "agent:claude" });
    expect(picked).toMatchObject({ status: 409, body: { error: "answerer_unavailable" } });
    expect(t.started).toEqual([]);
  });

  it("keeps a pick set on its own, refuses one that is not a pick, and clears it", async () => {
    const t = await setup();
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { answerer: "agent:claude" })).body.chat.answerer).toBe("agent:claude");
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { answerer: "re" })).status).toBe(400);
    expect((await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { answerer: null })).body.chat.answerer).toBeUndefined();
  });

  it("refuses a provider that is turned off, and a chat with nothing on that can answer, storing nothing", async () => {
    const t = await setup();
    await t.call("/v1/providers/claude", "PATCH", { enabled: false });
    const picked = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", answerer: "agent:claude:opus" });
    expect(picked).toMatchObject({ status: 409, body: { error: "answerer_unavailable" } });
    // Codex is on but can't run, so nothing can answer: no turn, and never Open Sourcebook's own model.
    const none = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    expect(none).toMatchObject({ status: 409, body: { error: "answerer_unavailable" } });
    expect(t.started).toEqual([]);
    expect(t.engine.provider.calls).toEqual([]);
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages).toEqual([]);
  });

  it("answers a chat that never picked with the chat's default from Settings, and its effort only with its agent", async () => {
    const t = await setup();
    await t.call("/v1/providers/picks/chat", "PUT", { agent: "claude", model: "opus", effort: "max" });
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    expect(t.started[0]).toMatchObject({ agent: "claude", model: "opus", effort: "max" });
    // Nothing was copied onto the chat: it reads the default each turn.
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.chat.answerer).toBeUndefined();
    // A chat that picked another agent keeps it, and the default's effort is not given to it.
    await t.call("/v1/providers/picks/chat", "PUT", { agent: "claude", model: null, effort: "low" });
    const project = (await t.call(`/v1/chats/${t.chat.id}`)).body.chat.projectId;
    const other = (await t.call(`/v1/projects/${project}/chats`, "POST", {})).body.chat;
    await t.call(`/v1/chats/${other.id}/messages`, "POST", { text: "again", answerer: "agent:codex" });
    expect(t.started.at(-1)).toMatchObject({ agent: "codex" });
    expect(t.started.at(-1)!.effort).toBeUndefined();
  });

  it("drops the engine's model when another provider is picked without one", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", answerer: "agent:codex" });
    expect(t.started[0]).toMatchObject({ agent: "codex" });
    expect(t.started[0].model).toBeUndefined();
  });

  it("with no connector, refuses a pick of an agent", async () => {
    const t = await setup({ connector: false });
    expect((await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi", answerer: "agent:claude" })).body.error).toBe("answerer_unavailable");
  });

  it("exposes model tiers, effort weights, work defaults, and persists PUT /v1/providers/picks/:scope", async () => {
    const connectorFetch: FetchLike = async (input) => {
      if (new URL(String(input)).pathname === "/status") {
        return Response.json({
          agent: "claude",
          model: "haiku",
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: true,
              defaultModels: { chat: "haiku", work: "sonnet" },
              defaultEfforts: { work: "high" },
              models: [
                { id: "haiku", label: "Haiku", tier: "fast" },
                { id: "sonnet", label: "Sonnet", tier: "balanced" },
                { id: "opus", label: "Opus", tier: "strong" },
              ],
              efforts: [
                { id: "low", label: "Low", weight: "light" },
                { id: "high", label: "High", weight: "high" },
              ],
            },
            {
              id: "codex",
              label: "Codex",
              installed: true,
              signedIn: true,
              defaultEfforts: { work: "high" },
              models: [{ id: "gpt-6", label: "GPT-6", tier: "strong" }],
              efforts: [{ id: "high", label: "High", weight: "high" }],
            },
          ],
        });
      }
      return Response.json({ ok: true });
    };
    const engine = createTestEngine({ agent: { fetch: connectorFetch, config: { model: "haiku" } }, registry: pickRegistry() });
    engine.deps.chat = new ChatService({
      repos: engine.deps.repos,
      registry: engine.deps.registry,
      skills: engine.deps.chat!.skills,
      conditions: createDefaultConditions(),
      plans: engine.deps.plans,
      provider: engine.deps.provider,
      agent: engine.deps.chat!.agent,
      workDefault: async () => ({ agent: "claude", model: "sonnet", effort: "high" }),
    });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };

    const initial = await call("/v1/providers");
    expect(initial.body.picks).toBeUndefined();
    expect(initial.body.providers[0].default).toBeUndefined();
    expect(initial.body.providers[0]).toMatchObject({
      id: "claude",
      workDefault: true,
      workDefaultModel: "sonnet",
      workDefaultEffort: "high",
      models: [
        expect.objectContaining({ id: "haiku", tier: "fast" }),
        expect.objectContaining({ id: "sonnet", tier: "balanced" }),
        expect.objectContaining({ id: "opus", tier: "strong" }),
      ],
      efforts: [
        { id: "low", label: "Low", weight: "light" },
        { id: "high", label: "High", weight: "high" },
      ],
    });
    expect(initial.body.providers[1]).toMatchObject({ id: "codex", workDefaultEffort: "high" });
    expect(initial.body.providers[1].workDefault).toBeUndefined();

    expect((await call("/v1/providers/picks/bad scope", "PUT", { agent: "claude" })).status).toBe(404);
    expect((await call("/v1/providers/picks/video", "PUT", {})).status).toBe(400);

    const saved = await call("/v1/providers/picks/video", "PUT", { agent: "codex", model: "gpt-6", effort: "high" });
    expect(saved.status).toBe(200);
    expect(saved.body.pick).toMatchObject({ scope: "video", agent: "codex", model: "gpt-6", effort: "high" });

    const withPick = await call("/v1/providers");
    expect(withPick.body.picks).toEqual({ video: { agent: "codex", model: "gpt-6", effort: "high" } });

    const cleared = await call("/v1/providers/picks/video", "PUT", { agent: null, model: null, effort: null });
    expect(cleared.body.pick).toBeNull();
    expect((await call("/v1/providers")).body.picks).toBeUndefined();
  });

  it("keeps picks only for scopes the formats derive, sets several at once, and lets only a reviewer be off", async () => {
    const engine = createTestEngine({ registry: pickRegistry() });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    // A format without an agent field, and a review scope of a format without a reviewer, keep nothing.
    expect((await call("/v1/providers/picks/plain", "PUT", { agent: "claude" })).body.error).toBe("unknown_scope");
    expect((await call("/v1/providers/picks/quiz.review", "PUT", { off: true })).body.error).toBe("unknown_scope");
    expect((await call("/v1/providers/picks/quiz", "PUT", { off: true })).status).toBe(400);

    const off = await call("/v1/providers/picks/video.review", "PUT", { off: true });
    expect(off.body).toMatchObject({ ok: true, scope: "video.review", pick: { scope: "video.review", off: true } });

    // "Use one for all": every make scope in one write; the review scope is left as it was.
    const all = await call("/v1/providers/picks", "PUT", { picks: { chat: { agent: "codex", model: "gpt-6" }, video: { agent: "codex", model: "gpt-6" }, quiz: { agent: "codex", model: "gpt-6" } } });
    expect(all.status).toBe(200);
    expect(all.body.picks).toEqual({
      chat: { agent: "codex", model: "gpt-6" },
      quiz: { agent: "codex", model: "gpt-6" },
      video: { agent: "codex", model: "gpt-6" },
      "video.review": { off: true },
    });
    // One unknown scope refuses the whole write.
    const refused = await call("/v1/providers/picks", "PUT", { picks: { chat: { agent: "claude" }, plain: { agent: "claude" } } });
    expect(refused.body.error).toBe("unknown_scope");
    expect((await call("/v1/providers")).body.picks.chat).toEqual({ agent: "codex", model: "gpt-6" });
    expect((await call("/v1/providers/picks", "PUT", { picks: {} })).status).toBe(400);
  });
});

/** Formats as the registry has them: video with a maker and a reviewer, quiz with a maker, one with neither. */
function pickRegistry(): FormatRegistry {
  const base = { colorSlot: 1, icon: "play", defaults: {} };
  return new FormatRegistry()
    .declare({ ...base, id: "video", label: "video", settings: [agentField("work"), reviewerField()] })
    .declare({ ...base, id: "quiz", label: "quiz", colorSlot: 2, settings: [agentField("chat")] })
    .declare({ ...base, id: "plain", label: "plain", colorSlot: 3, settings: [] });
}
