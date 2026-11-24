import assert from "node:assert/strict";
import { test } from "node:test";
import { pickNeededLine } from "../commands/picks.ts";
import { fakeEngine, type Call } from "./fake-engine.ts";

const agent = { kind: "agent", role: "make" };
const reviewer = { kind: "agent", role: "review" };
const FORMATS = {
  formats: [
    { id: "video", label: "Video", settings: [agent, reviewer] },
    { id: "flashcards", label: "Flashcards", settings: [agent, { kind: "number" }] },
    { id: "guide", label: "Guide", settings: [{ kind: "number" }] },
  ],
};
const provider = (id: string, label: string) => ({ id, label, state: "ready", added: true, enabled: true, models: [{ id: "sonnet" }, { id: "haiku" }], efforts: [{ id: "low" }, { id: "medium" }] });

function engine(picks: Record<string, unknown> = {}) {
  return fakeEngine({
    "GET /v1/formats": () => FORMATS,
    "GET /v1/providers": () => ({ connector: { configured: true, reachable: true }, providers: [provider("claude", "Claude Code"), provider("codex", "Codex")], picks }),
    "PUT /v1/providers/picks/:scope": (c: Call) => ({ ok: true, scope: c.path.split("/").pop(), pick: c.body }),
    "PUT /v1/providers/picks": (c: Call) => ({ picks: (c.body as { picks: unknown }).picks }),
  });
}

test("opensourcebook makers lists the chat and each shape with who makes it, and who reviews it where a shape offers that", async () => {
  const fake = await engine({ chat: { agent: "claude", model: "sonnet", effort: "medium" }, "video.review": { off: true } });
  try {
    const shown = await fake.command(["makers"]);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /^chat\s+claude · sonnet · medium$/m);
    assert.match(shown.out, /^video\s+not picked; several agents are ready, so Open Sourcebook asks first\s+review: off$/m);
    assert.match(shown.out, /^flashcards\s+not picked; several agents are ready, so Open Sourcebook asks first$/m);
    // A shape no agent makes has no row.
    assert.doesNotMatch(shown.out, /^guide/m);
    assert.match(shown.out, /opensourcebook makers set <chat\|shape> <agent>/);
    const json = (await fake.command(["makers", "list", "--json"])).json();
    assert.deepEqual(json.makers, [
      { scope: "chat", label: "the chat", pick: { agent: "claude", model: "sonnet", effort: "medium" }, settled: "picked" },
      { scope: "video", label: "Video", settled: "ask", review: { scope: "video.review", off: true } },
      { scope: "flashcards", label: "Flashcards", settled: "ask" },
    ]);
    // Help lists the commands with the rest.
    assert.match((await fake.command(["help"])).out, /opensourcebook makers set-all <agent>/);
  } finally {
    await fake.close();
  }
});

test("opensourcebook makers set, set-all and review save the picks through the engine, checked against what the agent offers", async () => {
  const fake = await engine();
  try {
    const set = await fake.command(["makers", "set", "flashcards", "codex", "--model", "haiku", "--effort", "low"]);
    assert.equal(set.code, 0, set.err);
    assert.equal(set.out.trim(), "flashcards is made by codex · haiku · low from now on.");
    const put = fake.calls.at(-1)!;
    assert.deepEqual([put.method, put.path, put.body], ["PUT", "/v1/providers/picks/flashcards", { agent: "codex", model: "haiku", effort: "low" }]);

    const all = await fake.command(["makers", "set-all", "claude", "--json"]);
    assert.deepEqual(all.json().scopes, ["chat", "video", "flashcards"]);
    assert.deepEqual(fake.calls.at(-1)!.body, { picks: { chat: { agent: "claude", model: null, effort: null }, video: { agent: "claude", model: null, effort: null }, flashcards: { agent: "claude", model: null, effort: null } } });

    assert.equal((await fake.command(["makers", "review", "video", "off"])).out.trim(), "video is not reviewed from now on.");
    assert.deepEqual(fake.calls.at(-1)!.body, { agent: null, model: null, effort: null, off: true });
    await fake.command(["makers", "review", "video", "codex", "--effort", "low"]);
    assert.deepEqual([fake.calls.at(-1)!.path, fake.calls.at(-1)!.body], ["/v1/providers/picks/video.review", { agent: "codex", model: null, effort: "low", off: null }]);

    const writes = fake.calls.filter((c) => c.method === "PUT").length;
    const refused = [
      await fake.command(["makers", "set", "guide", "claude", "--json"]),
      await fake.command(["makers", "set", "chat", "antigravity", "--json"]),
      await fake.command(["makers", "set", "chat", "claude", "--model", "opus", "--json"]),
      await fake.command(["makers", "set", "chat", "claude", "--effort", "max", "--json"]),
      await fake.command(["makers", "review", "flashcards", "claude", "--json"]),
    ].map((r) => (r.json().error as { code: string; message: string }));
    assert.deepEqual(refused.map((e) => e.code), ["unknown_scope", "unknown_agent", "unknown_model", "unknown_effort", "unknown_scope"]);
    assert.match(refused[0]!.message, /It can be: chat, video, flashcards\./);
    assert.match(refused[4]!.message, /The shapes with a reviewer are: video\./);
    // Nothing was written for a refused pick.
    assert.equal(fake.calls.filter((c) => c.method === "PUT").length, writes);
  } finally {
    await fake.close();
  }
});

test("a pick_needed answer becomes one line naming what needs a pick and the command that sets it", async () => {
  assert.equal(pickNeededLine(["flashcards"]), 'Several of your agents could do it and none is picked for flashcards. Set it with "opensourcebook makers set flashcards <agent>" ("opensourcebook makers" lists the agents).');
  assert.equal(
    pickNeededLine(["flashcards", "chat"]),
    'Several of your agents could do it and none is picked for flashcards and the chat. Set them with "opensourcebook makers set flashcards <agent>" and "opensourcebook makers set chat <agent>", or all at once with "opensourcebook makers set-all <agent>" ("opensourcebook makers" lists the agents).',
  );
  assert.match(pickNeededLine(["video.review"]), /none is picked for reviewing video\. Set it with "opensourcebook makers review video <agent\|off>"/);
  assert.match(pickNeededLine([]), /"opensourcebook makers set <chat\|shape> <agent>"/);

  const fake = await fakeEngine({
    "GET /v1/skills": () => ({ skills: [], commands: [{ command: "flashcards", label: "flashcards", about: "cards", skill: "make", format: "flashcards" }] }),
    "GET /v1/projects/:id/sources": () => ({ sources: [{ id: "s1", projectId: "p1", kind: "text", title: "Notes", status: "ready" }] }),
    "POST /v1/projects/:id/chats": () => [201, { chat: { id: "c1", projectId: "p1" } }],
    "POST /v1/chats/:id/messages": () => [409, { error: "pick_needed", message: "Several of your agents could do it.", scope: "flashcards", scopes: ["flashcards", "chat"] }],
    "GET /v1/plans/:id": () => ({ plan: { id: "pl1", status: "approved" }, items: [] }),
    "POST /v1/plans/:id/start": () => [409, { error: "pick_needed", message: "Pick who makes it in Settings, What makes what." }],
  });
  try {
    const made = await fake.command(["make", "flashcards", "ten cards", "--project", "p1"]);
    assert.equal(made.code, 1);
    assert.equal(made.err.trim(), pickNeededLine(["flashcards", "chat"]));
    const json = (await fake.command(["make", "flashcards", "ten cards", "--project", "p1", "--json"])).json();
    assert.deepEqual(json, { ok: false, error: { code: "pick_needed", message: pickNeededLine(["flashcards", "chat"]) } });
    // An engine that names no scope still gets a command to run.
    assert.equal((await fake.command(["plan", "start", "pl1"])).err.trim(), pickNeededLine([]));
  } finally {
    await fake.close();
  }
});
