import { ApiClient } from "./client";
import { ApiError } from "./errors";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(...responses: Array<[number, unknown] | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const next = queue.shift() ?? [200, {}];
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return { calls, client: new ApiClient({ fetch: fetchImpl as unknown as typeof fetch }) };
}

const plan = { id: "p1", projectId: "pr1", version: 1, status: "draft", createdAt: "t", updatedAt: "t" };
const view = { plan, stages: [], items: [], edges: [], counts: { total: 0, done: 0 }, estimateUsd: 0, issues: [] };

test("calls its own origin under /api, never the engine", async () => {
  const { calls, client } = mockFetch([200, { formats: [] }]);
  await client.formats();
  expect(calls[0]?.url).toBe("/api/v1/formats");
  expect(calls[0]?.headers["x-client-token"]).toBeUndefined();
});

test("sends JSON bodies and unwraps the response key", async () => {
  const { calls, client } = mockFetch([201, { project: { id: "pr1", title: "Calculus" } }]);
  const project = await client.createProject({ title: "Calculus" });
  expect(project.id).toBe("pr1");
  expect(calls[0]).toMatchObject({ method: "POST", url: "/api/v1/projects", body: { title: "Calculus" } });
  expect(calls[0]?.headers["content-type"]).toBe("application/json");
});

test("pages with limit and cursor and returns nextCursor", async () => {
  const { calls, client } = mockFetch([200, { sources: [{ id: "s1" }], nextCursor: "abc" }]);
  const page = await client.inbox({ limit: 10, cursor: "xyz" });
  expect(calls[0]?.url).toBe("/api/v1/inbox?limit=10&cursor=xyz");
  expect(page).toEqual({ rows: [{ id: "s1" }], nextCursor: "abc" });
});

test("all() follows cursors until the list ends", async () => {
  const { calls, client } = mockFetch(
    [200, { projects: [{ id: "a" }], nextCursor: "c1" }],
    [200, { projects: [{ id: "b" }] }],
  );
  const rows = await client.all((q) => client.listProjects(q));
  expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(calls[1]?.url).toBe("/api/v1/projects?limit=200&cursor=c1");
});

test("an error body becomes an ApiError with code and issues", async () => {
  const { client } = mockFetch([422, { error: "plan_invalid", message: "Plan cannot start", issues: ["Item x has no parent"] }]);
  const error = await client.approve("p1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 422, code: "plan_invalid", message: "Plan cannot start" });
  expect((error as ApiError).issueLines).toEqual(["Item x has no parent"]);
});

test("settings issues read as lines too", async () => {
  const { client } = mockFetch([
    400,
    { error: "invalid_settings", message: "Bad settings", issues: [{ path: "questions", code: "range", message: "too many" }] },
  ]);
  const error = (await client.addItem("p1", { type: "x", title: "t", level: 0 }).catch((e: unknown) => e)) as ApiError;
  expect(error.issueLines).toEqual(["questions: too many"]);
});

test("a body that is not JSON and a dropped connection are ApiErrors", async () => {
  const { client } = mockFetch([502, "<html>Bad gateway</html>"], new TypeError("Failed to fetch"));
  await expect(client.getPlan("p1")).rejects.toMatchObject({ status: 502, code: "http_502" });
  await expect(client.getPlan("p1")).rejects.toMatchObject({ status: 0, code: "network" });
});

test("item edits use the contract's routes and methods", async () => {
  const { calls, client } = mockFetch([200, view], [200, view], [200, view], [200, view], [200, view]);
  await client.updateItem("p1", "i1", { enabled: false, parentId: null });
  await client.deleteItem("p1", "i1");
  await client.reorder("p1", [{ id: "i1", level: 1, ord: 0 }]);
  await client.deleteEdge("p1", { from: "a", to: "b", kind: "fix_of" });
  await client.setStageLabel("p1", 2, "Practice");
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "PATCH /api/v1/plans/p1/items/i1",
    "DELETE /api/v1/plans/p1/items/i1",
    "POST /api/v1/plans/p1/reorder",
    "DELETE /api/v1/plans/p1/edges?from=a&to=b&kind=fix_of",
    "PUT /api/v1/plans/p1/stages/2",
  ]);
  expect(calls[0]?.body).toEqual({ enabled: false, parentId: null });
  expect(calls[2]?.body).toEqual({ items: [{ id: "i1", level: 1, ord: 0 }] });
});

test("uploads send the raw file with its type and name", async () => {
  const { calls, client } = mockFetch([201, { upload: { id: "u1" } }]);
  const file = new Blob(["%PDF"], { type: "application/pdf" });
  const upload = await client.upload(file, "notes.pdf");
  expect(upload.id).toBe("u1");
  expect(calls[0]?.headers).toMatchObject({ "content-type": "application/pdf", "x-upload-filename": "notes.pdf" });
  expect(calls[0]?.body).toBe(file);
});

test("the Library asks for things outside a project with project=none", async () => {
  const { calls, client } = mockFetch([200, { outputs: [] }]);
  await client.listOutputs({ project: "none", type: "read" });
  expect(calls[0]?.url).toBe("/api/v1/outputs?project=none&type=read");
});

test("ids are escaped in paths", async () => {
  const { calls, client } = mockFetch([200, { output: { id: "a/b" } }]);
  await client.getOutput("a/b");
  expect(calls[0]?.url).toBe("/api/v1/outputs/a%2Fb");
});

test("makers, reviewers and times use the contract's routes", async () => {
  const { calls, client } = mockFetch(
    [200, { picks: { chat: { agent: "a" }, video: { agent: "a" } } }],
    [200, { times: [{ scope: "video", agent: "a", runs: 3, seconds: 240, lastAt: "t" }] }],
    [200, { times: [] }],
    [200, { ...view, changed: ["i1"], unchanged: [{ itemId: "i2", why: "Made without your agent" }] }],
  );
  const picks = await client.putProviderPicks({ chat: { agent: "a" }, video: { agent: "a", model: null } });
  const times = await client.makeTimes("video");
  await client.makeTimes();
  const changed = await client.changePlanMaker("p1", { agent: "agent:a:m", effort: null, reviewer: "off" });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "PUT /api/v1/providers/picks",
    "GET /api/v1/make-times?scope=video",
    "GET /api/v1/make-times",
    "POST /api/v1/plans/p1/maker",
  ]);
  expect(calls[0]?.body).toEqual({ picks: { chat: { agent: "a" }, video: { agent: "a", model: null } } });
  expect(calls[3]?.body).toEqual({ agent: "agent:a:m", effort: null, reviewer: "off" });
  expect(picks.picks.video).toEqual({ agent: "a" });
  expect(times[0]?.seconds).toBe(240);
  expect(changed.unchanged[0]?.why).toBe("Made without your agent");
});

test("the voice routes never carry a key back and the sample plays through the proxy", async () => {
  const setup = { from: "none", services: [] };
  const { calls, client } = mockFetch([200, setup], [200, setup], [200, { service: { id: "v", keySet: true, keyHint: "a1b2" } }], [200, setup], [200, { voices: [{ id: "x", label: "X", sample: true }] }]);
  await client.voice();
  await client.setVoice({ service: "v", voice: null });
  const service = await client.setVoiceKey("v", "secret");
  await client.clearVoiceKey("v");
  const voices = await client.voiceOptions("v");
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET /api/v1/voice",
    "PUT /api/v1/voice",
    "PUT /api/v1/voice/services/v/key",
    "DELETE /api/v1/voice/services/v/key",
    "GET /api/v1/voice/services/v/voices",
  ]);
  expect(calls[1]?.body).toEqual({ service: "v", voice: null });
  expect(calls[2]?.body).toEqual({ key: "secret" });
  expect(service).toEqual({ id: "v", keySet: true, keyHint: "a1b2" });
  expect(voices[0]?.id).toBe("x");
  expect(client.voiceSampleUrl("v", "a/b")).toBe("/api/v1/voice/services/v/voices/a%2Fb/sample");
});

test("setup, upload types and closing a make piece use the contract's routes", async () => {
  const state = { done: false, providers: { connected: 1, ready: 1 }, voice: { set: false, skipped: false } };
  const { calls, client } = mockFetch([200, state], [200, { ...state, done: true }], [200, { ...state, voice: { set: false, skipped: true } }], [200, { maxBytes: 10, types: [] }], [200, { message: { id: "m1" } }]);
  await client.setup();
  expect((await client.setSetup(true)).done).toBe(true);
  expect((await client.skipVoice()).voice.skipped).toBe(true);
  expect((await client.uploadTypes()).maxBytes).toBe(10);
  await client.closeProposal("c1", "m1", 2);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/v1/setup", "PUT /api/v1/setup", "PUT /api/v1/setup", "GET /api/v1/uploads/types", "POST /api/v1/chats/c1/messages/m1/pieces/2/close"]);
  expect(calls[1]?.body).toEqual({ done: true });
  expect(calls[2]?.body).toEqual({ voice: { skipped: true } });
});

test("making from a chat's piece sends the proposal and the remake", async () => {
  const { calls, client } = mockFetch([200, view]);
  await client.make("pr1", { format: "quiz", remakes: { planId: "p0", itemId: "i0" }, proposal: { messageId: "m1", piece: 0 } });
  expect(calls[0]?.body).toEqual({ format: "quiz", remakes: { planId: "p0", itemId: "i0" }, proposal: { messageId: "m1", piece: 0 } });
});

test("commands carry one title and a group, from an older engine too", async () => {
  const { client } = mockFetch(
    [200, { skills: [], commands: [{ command: "mindmap", title: "Map the ideas", group: "chat", label: "mind map", about: "a", skill: "m" }] }],
    [200, { skills: [], commands: [{ command: "quiz", label: "quiz", about: "a", skill: "make", format: "quiz" }, { command: "teachback", label: "teach-back", action: "Explain it back", chatOnly: true, about: "a", skill: "t" }] }],
  );
  expect((await client.commands()).map((c) => [c.title, c.group])).toEqual([["Map the ideas", "chat"]]);
  expect((await client.commands()).map((c) => [c.title, c.group])).toEqual([
    ["quiz", "make"],
    ["Explain it back", "chat"],
  ]);
});

test("making one scene again sends the note and the pick to that output's scene, and Stop goes to its job", async () => {
  const started = { job: { id: "j2", status: "queued", stage: "queued", progress: 0 }, remakeOf: { outputId: "o1", scene: "s3" } };
  const { calls, client } = mockFetch([202, started], [200, { job: { id: "j2", status: "failed" } }]);
  expect(await client.remakeScene("o1", "s3", { note: "Say both sides", agent: "zeta", model: "z-big" })).toEqual(started);
  await client.cancelJob("j2");
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/v1/outputs/o1/scenes/s3/remake", "POST /api/v1/jobs/j2/cancel"]);
  expect(calls[0]?.body).toEqual({ note: "Say both sides", agent: "zeta", model: "z-big" });
});
