/**
 * A chat turn answered by the person's own agent (docs/api.md, "Your
 * agent"), over the real routes, repositories and migrations, with a fake
 * connector: the reply is stored running and answered at once, each tool
 * call comes back with the turn's token and is recorded as a step, the
 * reply's cites are checked word for word, a plan the agent makes is a plan
 * card, and the failures (connector down, agent missing, stopped, timed
 * out) are plain replies that release the chat.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSkills } from "../src/chat/default-skills";
import { handleRequest } from "../src/index";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { AgentConfig } from "../src/chat/agent/connector";
import type { FetchLike } from "../src/types";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const LIMITS = "A limit exists only when both one-sided limits agree.\n\nIf the left and right values differ, there is no limit at that point.";
const SERIES = "A geometric series converges when the ratio is smaller than one in absolute value.";
const PRICE = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

interface Started {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  callback: { url: string; token: string };
  target?: { type: string; id: string };
  drafts?: string[];
  model?: string;
  timeoutMs: number;
}

/** A connector that records what it is handed; `down` makes it unreachable, `answer` replaces its reply to POST /turns. */
function fakeConnector(options: { down?: boolean; answer?: () => Response; status?: unknown } = {}) {
  const started: Started[] = [];
  const stopped: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (options.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    if (url.pathname === "/status") {
      return Response.json(options.status ?? { agent: "claude", model: "haiku", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, version: "2.1.0" }] });
    }
    if (url.pathname === "/turns") {
      started.push(JSON.parse(String(init?.body)) as Started);
      return options.answer?.() ?? Response.json({ turnId: started.at(-1)!.turnId }, { status: 202 });
    }
    const stop = /^\/turns\/([^/]+)\/stop$/.exec(url.pathname);
    if (stop) {
      stopped.push(stop[1]);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, started, stopped };
}

async function setup(connector = fakeConnector(), config: Partial<AgentConfig> = {}) {
  const engine = createTestEngine({ agent: { fetch: connector.fetch, config }, skills: createDefaultSkills(), registry: createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } }) });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  const limits = (await call("/v1/sources", "POST", { text: LIMITS, projectId: project.id })).body.source;
  const series = (await call("/v1/sources", "POST", { text: SERIES, projectId: project.id })).body.source;
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  /** What the connector does: a tool call or the end of the turn, with a token. */
  const back = async (turn: Started, what: "tools" | "draft" | "finish", body: unknown, token = turn.callback.token) => {
    const response = await handleRequest(
      new Request(`${turn.callback.url}/${what}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      engine.deps,
    );
    return { status: response.status, body: await bodyOf(response) };
  };
  const tool = (turn: Started, name: string, args: unknown = {}) => back(turn, "tools", { name, arguments: args });
  return { engine, call, project, limits, series, chat, connector, back, tool };
}

describe("a turn answered by the person's own agent", () => {
  it("answers at once with a running reply, records steps, and ends with checked cites", async () => {
    const t = await setup();
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    expect(sent.status).toBe(200);
    const [, running] = sent.body.messages;
    expect(running).toMatchObject({ role: "assistant", state: "running", agent: "claude", pieces: [], steps: [] });
    expect(sent.body.chat.busySince).toBeDefined();

    const [turn] = t.connector.started;
    expect(turn.callback.url).toBe(`https://engine.test/v1/agent-turns/${turn.turnId}`);
    expect(turn.target).toEqual({ type: "chat", id: t.chat.id });
    expect(turn.tools.map((listed) => listed.name)).toEqual([
      "list_sources",
      "outline_sources",
      "search_passages",
      "read_passages",
      "tick_source",
      "read_plan",
      "make_plan",
      "change_plan",
      "start_plan",
      "plan_progress",
      "make_item",
      "remake_item",
      "stop_making",
      "read_skill",
      "ask",
      "reply",
    ]);
    expect(turn.prompt).toContain("When does a limit exist?");
    expect(turn.systemPrompt).toContain("Formats that can be made now");

    // A wrong token is refused and leaves no step.
    expect((await t.back(turn, "tools", { name: "list_sources" }, "nope")).status).toBe(404);

    const listed = await t.tool(turn, "list_sources");
    expect(listed.body.text.split("\n")).toHaveLength(2);
    expect(listed.body.text).toMatch(/^S1 ".*" \(text, 1 passages\), ticked$/m);
    const found = await t.tool(turn, "search_passages", { query: "one-sided limits agree" });
    expect(found.body.isError).toBe(false);
    const label = /^\[(S\d)#1/.exec(found.body.text)![1];
    expect(found.body.text).toContain(LIMITS.split("\n")[0]);

    const live = await t.call(`/v1/chats/${t.chat.id}`);
    expect(live.body.messages[1].steps.map((step: { label: string; state: string }) => [step.label, step.state])).toEqual([
      ["Looking at your sources", "done"],
      ["Searching your sources for “one-sided limits agree”", "done"],
    ]);

    const bad = await t.tool(turn, "reply", { parts: [{ text: "Both sides must agree.", cites: [{ passage: `${label}#1`, quote: "both sides agree" }] }], covered: true });
    expect(bad.body).toMatchObject({ isError: true });
    expect(bad.body.text).toContain("not word for word");
    const good = await t.tool(turn, "reply", { parts: [{ text: "A limit exists only when both one-sided limits agree.", cites: [{ passage: `${label}#1`, quote: "both one-sided limits agree" }] }], covered: true });
    expect(good.body.isError).toBe(false);
    expect((await t.back(turn, "finish", { outcome: "done", model: "claude-haiku", tokensIn: 1200, tokensOut: 80, durationMs: 4200 })).status).toBe(200);

    const done = (await t.call(`/v1/chats/${t.chat.id}`)).body;
    const reply = done.messages[1];
    expect(reply.state).toBeUndefined();
    expect(reply.pieces).toEqual([{ kind: "text", text: "A limit exists only when both one-sided limits agree.", cites: [0] }]);
    expect(reply.cites).toEqual([expect.objectContaining({ sourceId: t.limits.id, quote: "A limit exists only when both one-sided limits agree.", spot: "passage" })]);
    expect(reply.covered).toBe(true);
    expect(reply.text).toBe("A limit exists only when both one-sided limits agree.");
    expect(reply.steps.map((step: { tool: string; state: string }) => [step.tool, step.state])).toEqual([
      ["list_sources", "done"],
      ["search_passages", "done"],
      ["reply", "failed"],
      ["reply", "done"],
    ]);
    expect(done.chat.busySince).toBeUndefined();

    const usage = t.engine.db.raw.prepare("SELECT provider, model, usd, tokens_in, ok FROM usage WHERE session_id = ?").all(t.chat.id);
    expect(usage).toEqual([{ provider: "agent:claude", model: "claude-haiku", usd: 0, tokens_in: 1200, ok: 1 }]);
    // The turn is over: a late tool call does nothing.
    expect((await t.tool(turn, "list_sources")).status).toBe(409);
  });

  it("keeps how long a finished reply took, once, under the pick it was answered on", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    const [turn] = t.connector.started;
    await t.back(turn, "finish", { outcome: "done", model: "claude-haiku", durationMs: 4200 });
    await t.back(turn, "finish", { outcome: "done", model: "claude-haiku", durationMs: 9000 });
    const times = await t.call("/v1/make-times?scope=chat");
    expect(times.body.times).toEqual([{ scope: "chat", agent: "claude", model: "claude-haiku", runs: 1, seconds: 4.2, lastAt: expect.any(String) }]);
  });

  it("keeps the chat's own effort and picked model in a reply's key, not the model the connector reported", async () => {
    const t = await setup();
    await t.engine.deps.repos.sessions.update(t.chat.id, { settings: { answerer: "agent:claude:opus", effort: "high" } });
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    await t.back(t.connector.started[0], "finish", { outcome: "done", model: "claude-opus-4", durationMs: 20000 });
    expect((await t.call("/v1/make-times")).body.times).toEqual([
      { scope: "chat", agent: "claude", model: "opus", effort: "high", runs: 1, seconds: 20, lastAt: expect.any(String) },
    ]);
  });

  it("keeps a reply's time under the model and effort the turn was sent with, and the providers list names that same key", async () => {
    const status = {
      agent: "claude",
      agents: [
        {
          id: "claude",
          label: "Claude Code",
          installed: true,
          signedIn: true,
          models: [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }],
          efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }],
          defaultModels: { chat: "haiku" },
        },
      ],
    };
    const t = await setup(fakeConnector({ status }), { model: "sonnet", effort: "medium" });
    await t.engine.deps.repos.providerSettings.setPick((await t.engine.deps.repos.projects.get(t.project.id))!.ownerId, "chat", { agent: "claude" });
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    expect(t.connector.started[0]).toMatchObject({ model: "sonnet", effort: "medium" });
    await t.back(t.connector.started[0], "finish", { outcome: "done", model: "claude-sonnet-4", durationMs: 6000 });
    // The key the web asks for (web/src/make/makerKey.ts, timeKey): the chat's provider, its model and effort as listed.
    const claude = (await t.call("/v1/providers")).body.providers.find((p: { id: string }) => p.id === "claude");
    const asked = { scope: "chat", agent: claude.id, model: claude.defaultModel, effort: claude.defaultEffort };
    expect(asked).toEqual({ scope: "chat", agent: "claude", model: "sonnet", effort: "medium" });
    const times = (await t.call("/v1/make-times?scope=chat")).body.times;
    expect(times).toEqual([{ ...asked, runs: 1, seconds: 6, lastAt: expect.any(String) }]);
  });

  it("keeps no reply time for a turn that failed, was stopped or has no measured duration", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "First" });
    await t.back(t.connector.started[0], "finish", { outcome: "failed", problem: "error", durationMs: 3000 });
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Second" });
    await t.back(t.connector.started[1], "finish", { outcome: "done", model: "claude-haiku" });
    expect((await t.call("/v1/make-times")).body.times).toEqual([]);
  });

  it("keeps a reply whose cites keep failing, with those cites dropped and the part marked", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "What about series?" });
    const [turn] = t.connector.started;
    const wrong = { parts: [{ text: "Series always converge.", cites: [{ passage: "S2#1", quote: "always converge" }] }, { text: "Hope that helps." }] };
    expect((await t.tool(turn, "reply", wrong)).body.isError).toBe(true);
    expect((await t.tool(turn, "reply", wrong)).body.isError).toBe(true);
    expect((await t.tool(turn, "reply", wrong)).body.isError).toBe(false);
    await t.back(turn, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Series always converge.", cites: [], unchecked: true },
      { kind: "text", text: "Hope that helps.", cites: [] },
    ]);
    expect(reply.cites).toBeUndefined();
  });

  it("sends back a reply that read the sources but cites none, then marks it", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    const [turn] = t.connector.started;
    await t.tool(turn, "search_passages", { query: "limit" });
    const bare = { parts: [{ text: "When both one-sided limits agree." }] };
    const first = await t.tool(turn, "reply", bare);
    expect(first.body).toMatchObject({ isError: true, text: expect.stringContaining("cites none") });
    await t.tool(turn, "reply", bare);
    expect((await t.tool(turn, "reply", bare)).body.isError).toBe(false);
    await t.back(turn, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toEqual([{ kind: "text", text: "When both one-sided limits agree.", cites: [], unchecked: true }]);
  });

  it("does not ask for cites on a reply about a plan made from what it read", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [turn] = t.connector.started;
    await t.tool(turn, "read_passages", { source: "S1" });
    await t.tool(turn, "make_plan", { title: "Limits", stages: [{ items: [{ key: "a", format: "flashcards", title: "Limits", brief: "Explains limits.", sources: [{ source: "S1" }] }] }] });
    expect((await t.tool(turn, "reply", { parts: [{ text: "Here is a plan." }] })).body.isError).toBe(false);
  });

  it("tells the agent the person's day, and gives stages the days it works out from it", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan quiz me on limits by Monday, then series by Thursday", today: "2026-11-20" });
    const [turn] = t.connector.started;
    expect(turn.prompt).toContain("Today is Friday 2026-11-20 where the person is.");
    const wrong = await t.tool(turn, "make_plan", { title: "Limits", stages: [{ dueOn: "Monday", items: [{ key: "a", format: "quiz", title: "x", brief: "y", sources: [{ source: "S1" }] }] }] });
    expect(wrong.body.isError).toBe(true);
    expect(wrong.body.text).toContain('"dueOn" must be a day written YYYY-MM-DD');
    const made = await t.tool(turn, "make_plan", {
      title: "Limits and series",
      stages: [
        { label: "Limits", dueOn: "2026-11-23", items: [{ key: "limits", format: "quiz", title: "Limits check", brief: "Checks one-sided limits.", sources: [{ source: "S1" }] }] },
        { dueOn: "2026-11-26", items: [{ key: "series", format: "quiz", title: "Series check", brief: "Checks the ratio rule.", sources: [{ source: "S2" }] }] },
      ],
    });
    expect(made.body.isError).toBe(false);
    expect(made.body.text).toContain('Stage 1 "Limits", for 2026-11-23:');
    const plan = (await t.engine.deps.repos.plans.listBySession(t.chat.id))[0]!;
    expect((await t.call(`/v1/plans/${plan.id}`)).body.stages).toEqual([
      { level: 1, label: "Limits", dueOn: "2026-11-23" },
      { level: 2, dueOn: "2026-11-26" },
    ]);
    const moved = await t.tool(turn, "change_plan", { plan: plan.id, ops: [{ op: "date", stage: 2, dueOn: "2026-11-27" }, { op: "date", stage: 1, dueOn: null }] });
    expect(moved.body.isError).toBe(false);
    expect((await t.call(`/v1/plans/${plan.id}`)).body.stages).toEqual([
      { level: 1, label: "Limits" },
      { level: 2, dueOn: "2026-11-27" },
    ]);
    // A stage put in between takes its own day; the ones after it keep theirs as they move.
    const between = await t.tool(turn, "change_plan", {
      plan: plan.id,
      ops: [
        { op: "addStage", key: "mid", after: 1, dueOn: "2026-11-24" },
        { op: "add", key: "cards", stage: "mid", format: "flashcards", title: "Limit cards", brief: "Terms.", sources: [{ source: "S1" }] },
      ],
    });
    expect(between.body.isError).toBe(false);
    expect((await t.call(`/v1/plans/${plan.id}`)).body.stages).toEqual([
      { level: 1, label: "Limits" },
      { level: 2, dueOn: "2026-11-24" },
      { level: 3, dueOn: "2026-11-27" },
    ]);
  });

  it("leaves out a day the app sent that is not one", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hello", today: "Friday" });
    expect(t.connector.started[0]!.prompt).not.toContain("Today is");
  });

  it("makes a plan with the planner's own checks and shows it as a plan card", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [turn] = t.connector.started;
    expect(turn.prompt).toContain("The person typed /plan");
    const outline = await t.tool(turn, "outline_sources");
    expect(outline.body.text).toMatch(/^S1: .*1 passages/m);

    const wrong = await t.tool(turn, "make_plan", { title: "Limits", stages: [{ items: [{ key: "a", format: "nope", title: "x", brief: "y", sources: [{ source: "S1" }] }] }] });
    expect(wrong.body.isError).toBe(true);
    expect(wrong.body.text).toContain("Nothing was saved");

    const made = await t.tool(turn, "make_plan", {
      title: "Limits and series",
      stages: [
        { items: [{ key: "limits", format: "flashcards", title: "When a limit exists", brief: "Explains one-sided limits.", sources: [{ source: "S1" }] }] },
        { items: [{ key: "series", format: "quiz", title: "Series check", brief: "Checks the ratio rule.", sources: [{ source: "S2" }] }] },
      ],
    });
    expect(made.body.isError).toBe(false);
    expect(made.body.text).toContain("I1 [flashcards]");
    expect(made.body.text).not.toContain("your reply must say why");
    const changed = await t.tool(turn, "change_plan", { ops: [{ op: "change", item: "I2", title: "Ratio rule quiz" }] });
    expect(changed.body.isError).toBe(false);
    await t.tool(turn, "reply", { parts: [{ text: "Here is a plan in two stages." }] });
    await t.back(turn, "finish", { outcome: "done" });

    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Here is a plan in two stages.", cites: [] },
      { kind: "plan", planId: expect.any(String), action: "created" },
    ]);
    const plan = (await t.call(`/v1/plans/${reply.pieces[1].planId}`)).body;
    expect(plan.plan.chatId).toBe(t.chat.id);
    expect(plan.items.map((item: { title: string; type: string }) => [item.title, item.type])).toEqual([
      ["When a limit exists", "flashcards"],
      ["Ratio rule quiz", "quiz"],
    ]);
  });

  it("tells the agent its reply must say why when every item of a plan is one format", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [turn] = t.connector.started;
    const same = await t.tool(turn, "make_plan", {
      title: "Two bytes",
      stages: [
        { items: [{ key: "a", format: "flashcards", title: "One-sided limits", brief: "Explains one-sided limits.", sources: [{ source: "S1" }] }] },
        { items: [{ key: "b", format: "flashcards", title: "Ratio rule", brief: "Explains the ratio rule.", sources: [{ source: "S2" }] }] },
      ],
    });
    expect(same.body.isError).toBe(false);
    expect(same.body.text).toContain("Every item is a set of flashcards: your reply must say why in a sentence");
  });

  it("changes in a later turn the plan an earlier turn made, which is not the person's by hand", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [first] = t.connector.started;
    t.engine.clock.advance(1_000);
    await t.tool(first, "make_plan", { title: "Limits", stages: [{ items: [{ key: "a", format: "flashcards", title: "Limits", brief: "Explains limits.", sources: [{ source: "S1" }] }] }] });
    t.engine.clock.advance(1_000);
    await t.tool(first, "reply", { parts: [{ text: "Here it is." }] });
    t.engine.clock.advance(5_000);
    await t.back(first, "finish", { outcome: "done" });

    t.engine.clock.advance(60_000);
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Call it One-sided limits" });
    const second = t.connector.started[1];
    t.engine.clock.advance(1_000);
    const changed = await t.tool(second, "change_plan", { ops: [{ op: "change", item: "I1", title: "One-sided limits" }] });
    expect(changed.body.text).not.toContain("by hand");
    await t.tool(second, "reply", { parts: [{ text: "Renamed." }] });
    await t.back(second, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[3];
    expect(reply.pieces[1]).toMatchObject({ kind: "plan", action: "edited", changes: [expect.stringContaining("One-sided limits")] });
  });

  it("asks a question, and refuses sources that are not ticked", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}`, "PATCH", { sources: [t.limits.id] });
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "make me something" });
    const [turn] = t.connector.started;
    const off = /^(S\d) .*not ticked$/m.exec((await t.tool(turn, "list_sources")).body.text)![1];
    expect((await t.tool(turn, "read_passages", { source: off })).body).toMatchObject({ isError: true, text: expect.stringContaining("not ticked") });
    await t.tool(turn, "ask", { questions: [{ text: "What is it for?", options: ["An exam", "Just to understand"] }] });
    await t.tool(turn, "reply", { parts: [{ text: "Before I plan:" }] });
    await t.back(turn, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Before I plan:", cites: [] },
      { kind: "question", id: "q1", text: "What is it for?", options: [{ id: "o1", label: "An exam" }, { id: "o2", label: "Just to understand" }], multiple: false },
    ]);
    // Picking an option is the next message, and it goes to the agent too.
    const picked = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "An exam", answer: { messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o1"] }] } });
    expect(picked.status).toBe(200);
    expect(t.connector.started[1].prompt).toContain("picks options");
  });

  it("says plainly when the connector is not running, and leaves the chat free", async () => {
    const t = await setup(fakeConnector({ down: true }));
    const sent = await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    const reply = sent.body.messages[1];
    expect(reply.state).toBeUndefined();
    expect(reply.failed).toEqual({ reason: "agentUnreachable" });
    expect(reply.agent).toBe("claude");
    expect(reply.text).toContain("connector");
    expect(sent.body.chat.busySince).toBeUndefined();
    expect((await t.call("/v1/agent")).body.agent).toEqual({ configured: true, reachable: false });
  });

  it("passes on what the connector says when it cannot start the agent", async () => {
    const t = await setup(fakeConnector({ answer: () => Response.json({ problem: "agentMissing", message: "claude is not installed" }, { status: 424 }) }));
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" })).body.messages[1];
    expect(reply.failed).toEqual({ reason: "agentMissing" });
  });

  it("stops a running turn, keeping a plan it already made, and tells the connector", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [turn] = t.connector.started;
    await t.tool(turn, "make_plan", { title: "Limits", stages: [{ items: [{ key: "a", format: "flashcards", title: "Limits", brief: "Explains limits.", sources: [{ source: "S1" }] }] }] });
    const stopped = await t.call(`/v1/chats/${t.chat.id}/stop`, "POST", {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.messages[0].failed).toEqual({ reason: "stopped" });
    expect(stopped.body.messages[0].pieces.map((piece: { kind: string }) => piece.kind)).toEqual(["text", "plan"]);
    expect(stopped.body.chat.busySince).toBeUndefined();
    expect(t.connector.stopped).toEqual([turn.turnId]);
    // What the connector reports after the stop changes nothing.
    await t.back(turn, "finish", { outcome: "failed", problem: "stopped" });
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1].failed).toEqual({ reason: "stopped" });
    expect((await t.call(`/v1/chats/${t.chat.id}/stop`, "POST", {})).status).toBe(409);
  });

  it("ends a turn the connector never finished once its time is up", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    t.engine.clock.advance(60_000 + 31_000);
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.failed).toEqual({ reason: "timedOut" });
    expect(t.connector.stopped).toHaveLength(1);
  });

  it("reports the failure the connector names, and the agent's own words when it never called reply", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hi" });
    await t.back(t.connector.started[0], "finish", { outcome: "failed", problem: "agentLimit" });
    expect((await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1].failed).toEqual({ reason: "agentLimit" });

    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "hello" });
    await t.back(t.connector.started[1], "finish", { outcome: "done", text: "Hello there." });
    const words = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[3];
    expect(words.pieces).toEqual([{ kind: "text", text: "Hello there.", cites: [], unchecked: true }]);
  });

  it("shows a reply written over several calls as each call lands, its cites keeping their numbers", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist, and what about series?" });
    const [turn] = t.connector.started;
    // Sources made in the same instant may come in either order: find the one about limits.
    const found = await t.tool(turn, "search_passages", { query: "one-sided limits agree" });
    const s = /^\[(S\d)#1/.exec(found.body.text)![1];
    await t.tool(turn, "read_passages", { source: s });
    await t.tool(turn, "read_passages", { source: s });
    const first = await t.tool(turn, "reply", {
      blocks: [{ kind: "paragraph", text: "Only when **both** sides agree.", cites: [{ passage: `${s}#1`, quote: "both one-sided limits agree" }] }],
      more: true,
    });
    expect(first.body).toMatchObject({ isError: false, text: expect.stringContaining("next blocks") });

    const live = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(live.state).toBe("running");
    expect(live.pieces).toEqual([{ kind: "text", text: "Only when **both** sides agree.", cites: [0] }]);
    expect(live.cites).toHaveLength(1);

    // The second call cites the same spot again and a new one; the first block is not sent twice.
    await t.tool(turn, "reply", {
      blocks: [
        { kind: "paragraph", text: "Only when **both** sides agree." },
        { kind: "bullets", items: [{ text: "Same values: a limit.", cites: [{ passage: `${s}#1`, quote: "both one-sided limits agree" }] }, { text: `Different values: [no limit](${s}#1).` }] },
      ],
    });
    await t.back(turn, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Only when **both** sides agree.", cites: [0] },
      { kind: "list", ordered: false, items: [{ text: "Same values: a limit.", cites: [0] }, { text: "Different values: [no limit](cite:1).", cites: [] }], text: "- Same values: a limit.\n- Different values: no limit.", cites: [] },
    ]);
    expect(reply.cites).toHaveLength(2);
    expect(reply.text).toBe("Only when **both** sides agree.\n\n- Same values: a limit.\n- Different values: no limit.");
    // Steps in a row that did the same thing read as one line, in the past.
    expect(reply.stepLines).toEqual([
      { text: "Searched your sources for “one-sided limits agree”", steps: 1, state: "done" },
      { text: `Read 1 passage of ${t.limits.title}`, steps: 2, state: "done" },
      { text: "Wrote the reply", steps: 2, state: "done" },
    ]);
  });

  it("shows the reply while the agent still writes it, from the input the connector passes on, until the call lands", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "When does a limit exist?" });
    const [turn] = t.connector.started;
    expect(turn.drafts).toEqual(["reply"]);
    const s = /^\[(S\d)#1/.exec((await t.tool(turn, "search_passages", { query: "one-sided limits agree" })).body.text)![1];
    const written = `{"blocks": [{"kind": "paragraph", "text": "Only when both sides agree.", "cites": [{"passage": "${s}#1", "quote": "both one-sided limits agree"}]}, {"kind": "bullets", "items": [{"text": "Same values: a lim`;
    expect((await t.back(turn, "draft", { tool: "reply", input: written, calls: 1 })).status).toBe(200);
    const live = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(live.pieces).toEqual([
      { kind: "text", text: "Only when both sides agree.", cites: [0] },
      { kind: "list", ordered: false, items: [{ text: "Same values: a lim", cites: [] }], text: "- Same values: a lim", cites: [] },
    ]);
    expect(live.steps.at(-1)).toMatchObject({ tool: "reply", label: "Writing the reply", state: "running" });

    // A draft from before a call that has landed is old: it is not shown.
    await t.tool(turn, "reply", { blocks: [{ kind: "paragraph", text: "Only when both sides agree.", cites: [{ passage: `${s}#1`, quote: "both one-sided limits agree" }] }] });
    await t.back(turn, "draft", { tool: "reply", input: written, calls: 1 });
    const landed = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(landed.pieces).toEqual([{ kind: "text", text: "Only when both sides agree.", cites: [0] }]);
    expect(landed.steps.map((step: { tool: string }) => step.tool)).toEqual(["search_passages", "reply"]);
    // The reply was shown whole: the same reply sent again is sent back, and nothing repeats.
    const again = await t.tool(turn, "reply", { blocks: [{ kind: "paragraph", text: "Only when both one-sided limits agree, as the notes say." }] });
    expect(again.body).toMatchObject({ isError: true, text: expect.stringContaining("already shown") });
    await t.back(turn, "finish", { outcome: "done" });
    const reply = (await t.call(`/v1/chats/${t.chat.id}`)).body.messages[1];
    expect(reply.pieces).toHaveLength(1);
    expect(reply.stepLines.at(-1)).toEqual({ text: "Wrote the reply", steps: 2, state: "done" });
  });

  it("sends back a block it can't show, and keeps what was shown when the turn is stopped, cut short", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Compare them" });
    const [turn] = t.connector.started;
    const s = /^\[(S\d)#1/.exec((await t.tool(turn, "search_passages", { query: "one-sided limits agree" })).body.text)![1];
    const wide = await t.tool(turn, "reply", { blocks: [{ kind: "table", header: ["Idea", "Rule"], rows: [{ cells: ["Limit", "Sides agree", "extra"] }] }], more: true });
    expect(wide.body).toMatchObject({ isError: true, text: expect.stringContaining("header has 2 columns") });
    await t.tool(turn, "reply", { blocks: [{ kind: "table", header: ["Idea", "Rule"], rows: [{ cells: ["Limit", "Both sides agree"], cites: [{ passage: `${s}#1`, quote: "both one-sided limits agree" }] }] }], more: true });
    const stopped = await t.call(`/v1/chats/${t.chat.id}/stop`, "POST", {});
    const reply = stopped.body.messages[0];
    expect(reply.failed).toEqual({ reason: "stopped", cutShort: true });
    expect(reply.pieces.map((piece: { kind: string }) => piece.kind)).toEqual(["table", "text"]);
    expect(reply.pieces[0].rows).toEqual([{ cells: ["Limit", "Both sides agree"], cites: [0] }]);
    expect(reply.pieces[1]).toMatchObject({ failure: true, text: expect.stringContaining("cut short") });
    expect(reply.stepLines.at(-1)).toEqual({ text: "Wrote the reply, after fixing its layout", steps: 2, state: "done" });
  });

  it("shows which agent answers the chat", async () => {
    const t = await setup();
    expect((await t.call("/v1/agent")).body.agent).toEqual({ configured: true, reachable: true, id: "claude", label: "Claude Code", installed: true, signedIn: true, version: "2.1.0", model: "haiku" });
  });
});
