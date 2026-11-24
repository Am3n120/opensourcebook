/**
 * No provider is preferred (engine/docs/api.md, "Providers"): providers are listed A to Z whatever order the connector
 * reports them in, each with how to install it and sign in to it, `default` is only the chat's remembered pick, and
 * with nothing picked the only provider that can answer is used, while with several the person is asked.
 */
import { describe, expect, it } from "vitest";
import { ConnectorClient, type AgentStatus, type ConnectorAgent } from "../src/chat/agent/connector";
import { PickNeededError, pickNeededWords, providerViews, resolvePick, type ProviderView } from "../src/chat/providers";
import { handleRequest } from "../src/index";
import type { ProviderSetting } from "../src/studio/repositories";
import type { FetchLike } from "../src/types";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const ready = (id: string, label: string, more: Partial<ConnectorAgent> = {}): ConnectorAgent => ({ id, label, installed: true, signedIn: true, ...more });
const status = (agents: ConnectorAgent[]): AgentStatus => ({ reachable: true, agents });
const setting = (providerId: string, patch: Partial<ProviderSetting>): ProviderSetting => ({ providerId, enabled: true, hiddenModels: [], favoriteModels: [], updatedAt: "2026-11-22T00:00:00.000Z", ...patch });

describe("providers A to Z", () => {
  it("lists providers by name, case aside, whatever order the connector reports them in", () => {
    const views = providerViews(status([ready("opencode", "OpenCode"), ready("claude", "Claude Code"), ready("zed", "zed agent"), ready("codex", "Codex"), ready("cursor", "Cursor")]), []);
    expect(views.map((view) => view.label)).toEqual(["Claude Code", "Codex", "Cursor", "OpenCode", "zed agent"]);
    expect(views.some((view) => view.default)).toBe(false);
  });

  it("serves how to install and sign in to each, whatever its state", () => {
    const install = { command: "curl -fsSL https://example.com/install | bash", url: "https://example.com/install" };
    const [missing] = providerViews(status([{ id: "pi", label: "Pi", installed: false, signIn: "pi login", install }]), []);
    expect(missing).toMatchObject({ state: "missing", signIn: "pi login", install });
    const [signedIn] = providerViews(status([ready("pi", "Pi", { signIn: "pi login", install })]), []);
    expect(signedIn).toMatchObject({ state: "ready", signIn: "pi login", install });
  });

  it("marks only the chat's remembered pick as the default, with the model and effort it names", () => {
    const views = providerViews(status([ready("codex", "Codex"), ready("claude", "Claude Code")]), [], undefined, { agent: "codex", model: "gpt-6", effort: "high" });
    expect(views.map((view) => [view.id, view.default, view.defaultModel, view.defaultEffort])).toEqual([
      ["claude", undefined, undefined, undefined],
      ["codex", true, "gpt-6", "high"],
    ]);
  });
});

describe("the connector's status", () => {
  const client = (body: unknown, agent?: string) =>
    new ConnectorClient({ url: "http://127.0.0.1:8650", token: "t", timeoutMs: 10_000, ...(agent ? { agent } : {}) }, (async () => Response.json(body)) as FetchLike);

  it("names no agent of its own when the connector names none, not even the first it lists", async () => {
    const found = await client({ agents: [ready("claude", "Claude Code"), ready("codex", "Codex")] }).status();
    expect(found.agent).toBeUndefined();
    expect(found.agents?.map((agent) => agent.id)).toEqual(["claude", "codex"]);
    expect((await client({ agent: "codex", agents: [ready("claude", "Claude Code"), ready("codex", "Codex")] }).status()).agent?.id).toBe("codex");
  });

  it("keeps an agent's install page only over https, and its command only as one plain line", async () => {
    const found = await client({
      agents: [
        { ...ready("a", "A"), install: { command: "get a", url: "https://a.example/install" } },
        { ...ready("b", "B"), install: { command: "get b\nrm -rf ~", url: "https://b.example/install" } },
        { ...ready("c", "C"), install: { command: "get c", url: "http://c.example/install" } },
        { ...ready("d", "D"), install: { url: "javascript:alert(1)" } },
        { ...ready("e", "E"), install: { url: "https://e.example/" } },
      ],
    }).status();
    expect(found.agents?.map((agent) => agent.install)).toEqual([
      { command: "get a", url: "https://a.example/install" },
      { url: "https://b.example/install" },
      undefined,
      undefined,
      { url: "https://e.example/" },
    ]);
  });
});

describe("who does it when nothing is picked", () => {
  const view = (id: string, more: Partial<ProviderView> = {}): ProviderView =>
    ({ id, label: id, local: true, added: true, enabled: true, state: "ready", headline: "Ready", pick: `agent:${id}`, models: [], efforts: [], ...more }) as ProviderView;

  it("uses the scope's remembered pick, with its model and effort, even with several ready", () => {
    const providers = [view("claude"), view("codex")];
    expect(resolvePick("chat", { chat: { agent: "codex", model: "gpt-6", effort: "high" } }, providers)).toEqual({ agent: "codex", model: "gpt-6", effort: "high" });
    expect(resolvePick("video", { video: { agent: "claude" }, chat: { agent: "codex" } }, providers)).toEqual({ agent: "claude" });
  });

  it("uses the one provider that is added, on and ready", () => {
    const providers = [view("claude"), view("codex", { enabled: false }), view("cursor", { added: false }), view("antigravity", { state: "signedOut" }), view("pi", { state: "missing" })];
    expect(resolvePick("chat", undefined, providers)).toEqual({ agent: "claude" });
    // A pick with no agent picks nobody.
    expect(resolvePick("quiz", { quiz: { effort: "low" } }, providers)).toEqual({ agent: "claude" });
  });

  it("asks when several could, in the words of where the person picks, and says none when none can", () => {
    const providers = [view("claude"), view("codex")];
    expect(() => resolvePick("chat", {}, providers)).toThrow(PickNeededError);
    expect(() => resolvePick("chat", {}, providers)).toThrow("pick who answers in the chat's picker");
    expect(() => resolvePick("video", { chat: { agent: "claude" } }, providers)).toThrow("pick who makes video in Settings, What makes what.");
    expect(resolvePick("chat", undefined, [view("claude", { enabled: false })])).toBeUndefined();
    expect(resolvePick("chat", undefined, [])).toBeUndefined();
  });

  it("is answered 409 pick_needed by any route, storing nothing", async () => {
    const engine = createTestEngine({ answer: () => ({ parts: [{ text: "an answer" }] }) });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
    const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
    engine.deps.chat!.answering = async () => {
      throw new PickNeededError("chat");
    };
    const sent = await call(`/v1/chats/${chat.id}/messages`, "POST", { text: "hi" });
    expect(sent).toEqual({ status: 409, body: { error: "pick_needed", message: pickNeededWords(["chat"]), scope: "chat", scopes: ["chat"] } });
    expect((await call(`/v1/chats/${chat.id}`)).body.messages).toEqual([]);
  });
});
