// The scenes service's side of the agent connector: with no model set for videos, a turn names none and is a piece of
// work, so the connector runs each agent on its own model for work, or its own default; never the connector's chat model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connector } from "../src/connector.ts";

function fakeFetch(status: unknown) {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/status")) return Response.json(status);
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, agent: "codex" }, { status: 202 });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const turn = { turnId: "t1", systemPrompt: "s", prompt: "p", tools: [], callback: { url: "http://127.0.0.1:1/turns/t1", token: "x" }, timeoutMs: 0 };

test("no model set: a video's turn names none, says it is a piece of work, and the status shows the agent's own model for work or none", async () => {
  // The connector's own agent is another one, with a chat model of its own: that model is never this agent's.
  const status = { agent: "claude", model: "haiku", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, defaultModels: { chat: "haiku", work: "sonnet" } }, { id: "codex", label: "Codex", installed: true, signedIn: true }] };
  const codex = fakeFetch(status);
  const c = new Connector({ url: "http://127.0.0.1:9", token: "t".repeat(16), agent: "codex" }, codex.fetchImpl);
  assert.deepEqual(await c.status(), { reachable: true, id: "codex", label: "Codex" });
  await c.start(turn);
  assert.equal(codex.sent[0].kind, "work");
  assert.equal(codex.sent[0].agent, "codex");
  assert.ok(!("model" in codex.sent[0]), JSON.stringify(codex.sent[0]));

  // The connector's own agent: its model for work, as its adapter says, not its chat model.
  const claude = fakeFetch(status);
  const own = new Connector({ url: "http://127.0.0.1:9", token: "t".repeat(16) }, claude.fetchImpl);
  assert.equal((await own.status()).model, "sonnet");
  await own.start(turn);
  assert.ok(!("model" in claude.sent[0]) && claude.sent[0].kind === "work");

  // A model set for videos is sent as it is, and target metadata passes through.
  const set = fakeFetch(status);
  const named = new Connector({ url: "http://127.0.0.1:9", token: "t".repeat(16), agent: "codex", model: "a-model" }, set.fetchImpl);
  assert.equal((await named.status()).model, "a-model");
  await named.start({ ...turn, target: { type: "video", id: "job-1" } });
  assert.equal(set.sent[0].model, "a-model");
  assert.deepEqual(set.sent[0].target, { type: "video", id: "job-1" });
});

test("per-agent status and per-turn overrides never leak configured model or effort across agents", async () => {
  const status = {
    agent: "claude",
    model: "haiku",
    agents: [
      { id: "claude", label: "Claude Code", installed: true, signedIn: true, defaultModels: { chat: "haiku", work: "sonnet" }, defaultEfforts: { work: "high" } },
      { id: "codex", label: "Codex", installed: true, signedIn: true, defaultEfforts: { work: "medium" } },
    ],
  };
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/status")) return Response.json(status);
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push(body);
    return Response.json({ ok: true, agent: body.agent ?? "claude", ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}), workspace: false }, { status: 202 });
  }) as typeof fetch;

  // SCENES_AGENT unset, SCENES_AGENT_MODEL/EFFORT set: applies only to connector default ("claude"), never to "codex".
  const c = new Connector({ url: "http://127.0.0.1:9", token: "t".repeat(16), model: "opus", effort: "max" }, fetchImpl);
  assert.deepEqual(await c.status(false, "claude"), { reachable: true, id: "claude", label: "Claude Code", model: "opus", effort: "max" });
  assert.deepEqual(await c.status(false, "codex"), { reachable: true, id: "codex", label: "Codex", effort: "medium" });

  // Starting on "codex" without explicit model/effort omits configured Claude overrides; naming them forwards them and returns resolved values.
  const withoutPick = await c.start({ ...turn, agent: "codex" });
  assert.deepEqual(withoutPick, { ok: true, agent: "codex", workspace: false });
  assert.equal(sent[0].agent, "codex");
  assert.ok(!("model" in sent[0]) && !("effort" in sent[0]));

  const withPick = await c.start({ ...turn, agent: "codex", model: "gpt-6", effort: "low" });
  assert.deepEqual(withPick, { ok: true, agent: "codex", model: "gpt-6", effort: "low", workspace: false });
  assert.deepEqual([sent[1].agent, sent[1].model, sent[1].effort], ["codex", "gpt-6", "low"]);

  // Naming the connector's default agent still honors configured model/effort when no per-turn pick was given.
  await c.start({ ...turn, agent: "claude" });
  assert.deepEqual([sent[2].agent, sent[2].model, sent[2].effort], ["claude", "opus", "max"]);
});
