/**
 * First-time setup (docs/api.md, "First-time setup"): `done` is kept per owner until changed, and the providers and
 * voice it reports are read fresh from what is set up now.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import type { FetchLike } from "../src/types";
import { authed, bodyOf, CLIENT_TOKEN, createTestEngine } from "./support/engine-harness";
import { voiceChosenFrom } from "../src/wiring";

const connector: FetchLike = async (input) => {
  if (new URL(String(input)).pathname !== "/status") return Response.json({ ok: true });
  return Response.json({
    agents: [
      { id: "codex", label: "Codex", installed: true, signedIn: true },
      { id: "claude", label: "Claude Code", installed: true, signedIn: false, signIn: "claude auth login" },
      { id: "cursor", label: "Cursor", installed: true, signedIn: true },
      { id: "pi", label: "Pi", installed: false },
    ],
  });
};

function setup(options: { agent?: boolean } = {}) {
  const engine = createTestEngine(options.agent === false ? {} : { agent: { fetch: connector } });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  return { engine, call };
}

describe("first-time setup", () => {
  it("counts the providers added and on, and of those the ready ones, and is not done at first", async () => {
    const t = setup();
    await t.call("/v1/providers/cursor", "PATCH", { enabled: false });
    expect(await t.call("/v1/setup")).toEqual({ status: 200, body: { done: false, providers: { connected: 2, ready: 1 }, voice: { set: false, skipped: false } } });
  });

  it("keeps done until it is changed back", async () => {
    const t = setup();
    expect((await t.call("/v1/setup", "PUT", { done: true })).body.done).toBe(true);
    expect((await t.call("/v1/setup")).body.done).toBe(true);
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    expect(await t.engine.deps.repos.ownerSettings.get(owner, "setup.done")).toBe(true);
    expect((await t.call("/v1/setup", "PUT", { done: false })).body.done).toBe(false);
    expect(await t.engine.deps.repos.ownerSettings.get(owner, "setup.done")).toBeUndefined();
  });

  it("refuses anything but done: true or false, and voice: { skipped: true or false }", async () => {
    const t = setup();
    for (const body of [{}, { done: "yes" }, { done: null }, { voice: true }, { voice: {} }, { voice: { skipped: "yes" } }, { done: true, voice: null }]) {
      expect((await t.call("/v1/setup", "PUT", body)).status).toBe(400);
    }
  });

  it("remembers that the voice step was skipped, so the person is not sent back to it", async () => {
    const t = setup();
    expect((await t.call("/v1/setup", "PUT", { voice: { skipped: true } })).body).toMatchObject({ done: false, voice: { set: false, skipped: true } });
    expect((await t.call("/v1/setup")).body.voice).toEqual({ set: false, skipped: true });
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    expect(await t.engine.deps.repos.ownerSettings.get(owner, "setup.voice.skipped")).toBe(true);
    // Both at once, and false clears it.
    expect((await t.call("/v1/setup", "PUT", { done: true, voice: { skipped: false } })).body).toMatchObject({ done: true, voice: { skipped: false } });
    expect(await t.engine.deps.repos.ownerSettings.get(owner, "setup.voice.skipped")).toBeUndefined();
  });

  it("says a voice is set when the scenes service has one chosen, and not when it can't be asked", async () => {
    const t = setup();
    t.engine.deps.voiceChosen = async () => true;
    expect((await t.call("/v1/setup")).body.voice).toEqual({ set: true, skipped: false });
    t.engine.deps.voiceChosen = async () => {
      throw new Error("gone");
    };
    expect((await t.call("/v1/setup")).body.voice).toEqual({ set: false, skipped: false });
  });

  it("reads whether a voice is chosen from the scenes service's voice setup, from the app or its environment", async () => {
    const setupOf = (service?: string) => ({ voiceSetup: async () => ({ ...(service ? { service } : {}), from: service ? ("app" as const) : ("none" as const), services: [] }) });
    expect(await voiceChosenFrom(setupOf("elevenlabs"))()).toBe(true);
    expect(await voiceChosenFrom(setupOf())()).toBe(false);
    const t = setup();
    t.engine.deps.voiceChosen = voiceChosenFrom(setupOf("kokoro"));
    expect((await t.call("/v1/setup")).body.voice).toEqual({ set: true, skipped: false });
  });

  it("counts no providers with no connector set up", async () => {
    const t = setup({ agent: false });
    expect((await t.call("/v1/setup")).body.providers).toEqual({ connected: 0, ready: 0 });
  });
});

describe("owner settings", () => {
  it("keeps one JSON value per owner and key, and null removes it", async () => {
    const { engine } = setup({ agent: false });
    const repo = engine.deps.repos.ownerSettings;
    await repo.set("a", "setup.done", true);
    await repo.set("a", "theme", { mode: "dark" });
    await repo.set("b", "setup.done", false);
    expect(await repo.list("a")).toEqual({ "setup.done": true, theme: { mode: "dark" } });
    expect(await repo.get("b", "setup.done")).toBe(false);
    await repo.set("a", "theme", null);
    expect(await repo.list("a")).toEqual({ "setup.done": true });
    expect(await repo.get("a", "bad key")).toBeUndefined();
    await expect(repo.set("a", "bad key", 1)).rejects.toThrow();
  });
});
