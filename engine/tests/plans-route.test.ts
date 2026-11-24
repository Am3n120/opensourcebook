/**
 * /v1/plans: progress and done ticks over the real runner, queue consumer
 * and SQL.
 */
import { describe, expect, it } from "vitest";
import { WITHOUT_SOUND } from "../src/engines/video/scenes/maker";
import { ownerIdForToken } from "../src/http";
import { JobWait } from "../src/jobs/waits";
import { handleRequest } from "../src/index";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { agentField } from "../src/engines/agent-fields";
import type { NewPlanNode, PlanNode } from "../src/studio/repositories";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";
import { gate, until } from "./support/job-harness";

async function setup(ownerToken = CLIENT_TOKEN) {
  const log = emptyLog();
  const agentic = fakeDefinition("quiz", log, () => ({}));
  // Quiz is made by the person's agent here (agent-fields.ts); byte is not.
  const registry = new FormatRegistry().register(fakeDefinition("byte", log, () => ({}))).register({ ...agentic, descriptor: { ...agentic.descriptor, settings: [agentField("chat")] } });
  const engine = createTestEngine({ registry });
  const { repos } = engine.deps;
  const ownerId = await ownerIdForToken(ownerToken);
  const project = await repos.projects.create({ ownerId, title: "Calculus" });
  const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, text: "Limits and continuity." });
  const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Unit 1" });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const add = async (title: string, fields: Partial<NewPlanNode> & { level: number }): Promise<PlanNode> => {
    const node = await repos.plans.addNode({ planId: plan.id, ord: 0, type: "byte", title, ...fields });
    await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    return node;
  };
  const start = async () => {
    await repos.plans.setStatus(plan.id, "approved");
    await runner.kickOff(plan.id);
  };
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const get = (path: string) => handleRequest(authed(path), engine.deps);
  const post = (path: string, body: unknown) => handleRequest(authed(path, { method: "POST", body }), engine.deps);
  return { engine, repos, plan, runner, add, start, drain, queue, get, post };
}

describe("a made item says what it became", () => {
  it("its row carries the format's words for what was made and the maker's note on its size", async () => {
    const log = emptyLog();
    const byte = fakeDefinition("byte", log, () => ({}));
    const registry = new FormatRegistry().register({
      ...byte,
      engine: { ...byte.engine, generate: async (ctx, blueprint) => ({ ...(await byte.engine.generate(ctx, blueprint)), payload: { made: true, sizeNote: "Shorter: the notes held less." } as never }) },
      describeMade: (payload) => [(payload as { made?: boolean }).made ? "2 bits" : "?"],
    });
    const engine = createTestEngine({ registry });
    const { repos } = engine.deps;
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const project = await repos.projects.create({ ownerId, title: "Calculus" });
    const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, text: "Limits and continuity." });
    const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Unit 1" });
    const queue: string[] = [];
    const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
    engine.deps.plans = runner;
    engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
    const node = await repos.plans.addNode({ planId: plan.id, ord: 0, type: "byte", title: "First", level: 0 });
    await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    await repos.plans.setStatus(plan.id, "approved");
    await runner.kickOff(plan.id);
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
    const body = await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}`), engine.deps));
    expect(body.items[0]).toMatchObject({ madeAs: ["2 bits"], madeNote: "Shorter: the notes held less." });
  });
});

describe("GET /v1/plans/:id/progress", () => {
  it("lists items in order with status, output, ticks and counts", async () => {
    const t = await setup();
    const first = await t.add("First", { level: 0 });
    await t.add("Second", { level: 1 });
    await t.add("Off", { level: 1, ord: 1, enabled: false });
    await t.repos.plans.setStageLabel(t.plan.id, 1, "Practice");
    await t.start();
    await t.drain();
    await t.repos.results.set(first.id, { done: true, result: { score: 0.8 } });

    const response = await t.get(`/v1/plans/${t.plan.id}/progress`);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.plan).toMatchObject({ id: t.plan.id, title: "Unit 1", status: "done" });
    expect(body.stages).toEqual([{ level: 1, label: "Practice" }]);
    expect(body.items.map((item: any) => [item.title, item.status, item.done])).toEqual([
      ["First", "done", true],
      ["Second", "done", false],
      ["Off", "skipped", false],
    ]);
    expect(body.items[0]).toMatchObject({ result: { score: 0.8 }, outputId: expect.any(String), doneAt: expect.any(String) });
    expect(body.items[1].doneAt).toBeUndefined();
    expect(body.items[0].job).toMatchObject({ status: "done", stage: "done", progress: 1, attempt: 1 });
    expect(body.items[0].job.validation).toEqual([expect.objectContaining({ round: 0, valid: true, errors: 0 })]);
    expect(body.items[2].job).toBeUndefined();
    expect(body.counts).toEqual({ total: 2, done: 1 });
  });

  it("shows an item as running, with its job's stage and progress, while the job runs", async () => {
    const t = await setup();
    const first = await t.add("First", { level: 0 });
    await t.start();
    const [jobId] = t.queue;
    const job = (await t.engine.deps.jobs.get(jobId))!;
    await t.engine.deps.jobs.compareAndSet(jobId, job.version, { status: "running", stage: "writing", progress: 0.78, attempt: 1 });

    const body = await bodyOf(await t.get(`/v1/plans/${t.plan.id}/progress`));
    const item = body.items.find((candidate: any) => candidate.id === first.id);
    expect(item).toMatchObject({ status: "running", job: { id: jobId, status: "running", stage: "writing", progress: 0.78, attempt: 1 } });
  });

  it("shows an undecided ask branch with its question", async () => {
    const t = await setup();
    const parent = await t.add("Check", { level: 0, type: "quiz" });
    const branch = await t.add("More?", { level: 1, parentId: parent.id, condition: { kind: "ask", question: "More practice?" } });
    await t.start();
    await t.drain();
    const body = await bodyOf(await t.get(`/v1/plans/${t.plan.id}/progress`));
    const item = body.items.find((candidate: any) => candidate.id === branch.id);
    expect(item).toMatchObject({ status: "pending", parentId: parent.id, asking: { question: "More practice?" } });
  });

  it("works before Start", async () => {
    const t = await setup();
    await t.add("First", { level: 0 });
    const body = await bodyOf(await t.get(`/v1/plans/${t.plan.id}/progress`));
    expect(body.plan.status).toBe("draft");
    expect(body.items[0].status).toBe("pending");
  });

  it("needs the token and hides other owners' plans", async () => {
    const t = await setup("another-client-token-0123456789");
    const path = `/v1/plans/${t.plan.id}/progress`;
    expect((await handleRequest(new Request(`https://engine.test${path}`), t.engine.deps)).status).toBe(401);
    expect((await t.get(path)).status).toBe(404);
    expect((await t.get("/v1/plans/missing/progress")).status).toBe(404);
  });
});

describe("POST /v1/plans/:id/items/:itemId/done", () => {
  const done = (t: Awaited<ReturnType<typeof setup>>, id: string, body: unknown = {}) => t.post(`/v1/plans/${t.plan.id}/items/${id}/done`, body);

  it("ticks a finished item, keeps the first time, un-ticks and keeps the result", async () => {
    const t = await setup();
    const item = await t.add("First", { level: 0 });
    await t.start();
    await t.drain();

    const ticked = await done(t, item.id, { result: { score: 0.9 } });
    expect(ticked.status).toBe(200);
    const first = await bodyOf(ticked);
    expect(first.item).toMatchObject({ id: item.id, done: true, result: { score: 0.9 } });
    expect(first.counts).toEqual({ total: 1, done: 1 });

    t.engine.clock.advance(60_000);
    const again = await bodyOf(await done(t, item.id));
    expect(again.item.doneAt).toBe(first.item.doneAt);

    const undone = await bodyOf(await done(t, item.id, { done: false }));
    expect(undone.item).toMatchObject({ done: false, result: { score: 0.9 } });
    expect(undone.item.doneAt).toBeUndefined();
    expect(undone.counts).toEqual({ total: 1, done: 0 });
  });

  it("advances the plan so a branch waiting on the result moves", async () => {
    const t = await setup();
    const check = await t.add("Check", { level: 0, type: "quiz" });
    const fix = await t.add("Fix", { level: 1, parentId: check.id, condition: { kind: "metric", metric: "score", below: 0.7 } });
    await t.start();
    await t.drain();
    expect((await t.repos.plans.getNode(fix.id))!.status).toBe("pending");

    const body = await bodyOf(await done(t, check.id, { result: { score: 0.4 } }));
    expect(body.item.done).toBe(true);
    expect((await t.repos.plans.getNode(fix.id))!.status).toBe("queued");
  });

  it("refuses an unstarted plan, an item with no output, a foreign output and a bad body", async () => {
    const t = await setup();
    const first = await t.add("First", { level: 0 });
    const later = await t.add("Later", { level: 1 });
    expect(await bodyOf(await done(t, first.id))).toMatchObject({ error: "plan_not_started" });
    expect((await done(t, first.id)).status).toBe(409);

    await t.start();
    expect(await bodyOf(await done(t, later.id))).toMatchObject({ error: "item_not_ready" });
    // Un-ticking an item with no output is harmless.
    expect((await done(t, later.id, { done: false })).status).toBe(200);

    await t.drain();
    const outputOfLater = (await t.repos.outputs.latestForNode(later.id))!;
    const mismatch = await done(t, first.id, { outputId: outputOfLater.id });
    expect(mismatch.status).toBe(400);
    expect(await bodyOf(mismatch)).toMatchObject({ error: "output_mismatch" });
    expect((await done(t, first.id, { outputId: "nope" })).status).toBe(400);
    expect((await t.repos.results.get(first.id))).toBeUndefined();

    const own = (await t.repos.outputs.latestForNode(first.id))!;
    expect((await done(t, first.id, { outputId: own.id })).status).toBe(200);
    expect((await done(t, first.id, { done: "yes" })).status).toBe(400);
    expect((await done(t, first.id, { result: "x".repeat(70_000) })).status).toBe(413);
  });

  it("hides other plans, other owners and items of other plans", async () => {
    const t = await setup();
    const item = await t.add("First", { level: 0 });
    const other = await t.repos.plans.create({ ownerId: await ownerIdForToken(CLIENT_TOKEN), projectId: t.plan.projectId });
    expect((await t.post(`/v1/plans/${other.id}/items/${item.id}/done`, {})).status).toBe(404);
    expect((await t.post(`/v1/plans/${t.plan.id}/items/missing/done`, {})).status).toBe(404);
    const stranger = await setup("another-client-token-0123456789");
    expect((await t.post(`/v1/plans/${stranger.plan.id}/items/x/done`, {})).status).toBe(404);
    expect((await handleRequest(new Request(`https://engine.test/v1/plans/${t.plan.id}/items/${item.id}/done`, { method: "POST", body: "{}" }), t.engine.deps)).status).toBe(401);
  });
});

describe("POST /v1/plans/:id/items/:itemId/progress", () => {
  const keep = (t: Awaited<ReturnType<typeof setup>>, id: string, body: unknown) => t.post(`/v1/plans/${t.plan.id}/items/${id}/progress`, body);

  it("keeps where the person stopped, apart from the tick and the result, and shows it on the plan", async () => {
    const t = await setup();
    const item = await t.add("First", { level: 0 });
    await t.start();
    await t.drain();
    await t.post(`/v1/plans/${t.plan.id}/items/${item.id}/done`, { result: { score: 0.9 } });

    const kept = await keep(t, item.id, { progress: { bit: 2 } });
    expect(kept.status).toBe(200);
    expect((await bodyOf(kept)).item).toMatchObject({ id: item.id, done: true, result: { score: 0.9 }, progress: { bit: 2 } });

    // A later tick or un-tick leaves the progress alone, and the plan read shows it.
    await t.post(`/v1/plans/${t.plan.id}/items/${item.id}/done`, { done: false });
    const plan = await bodyOf(await t.get(`/v1/plans/${t.plan.id}`));
    expect(plan.items[0]).toMatchObject({ done: false, result: { score: 0.9 }, progress: { bit: 2 } });

    // Null clears it.
    await keep(t, item.id, { progress: null });
    expect((await bodyOf(await t.get(`/v1/plans/${t.plan.id}/progress`))).items[0].progress).toBeUndefined();
  });

  it("never moves a branch", async () => {
    const t = await setup();
    const check = await t.add("Check", { level: 0, type: "quiz" });
    const fix = await t.add("Fix", { level: 1, parentId: check.id, condition: { kind: "metric", metric: "score", below: 0.7 } });
    await t.start();
    await t.drain();
    expect((await keep(t, check.id, { progress: { score: 0.1, answers: {} } })).status).toBe(200);
    expect((await t.repos.plans.getNode(fix.id))!.status).toBe("pending");
  });

  it("refuses an unstarted plan, an item with no output, a bad or too large body, and other owners", async () => {
    const t = await setup();
    const first = await t.add("First", { level: 0 });
    const later = await t.add("Later", { level: 1 });
    expect(await bodyOf(await keep(t, first.id, { progress: { bit: 1 } }))).toMatchObject({ error: "plan_not_started" });
    await t.start();
    expect(await bodyOf(await keep(t, later.id, { progress: { bit: 1 } }))).toMatchObject({ error: "item_not_ready" });
    await t.drain();
    expect((await keep(t, first.id, { progress: [1] })).status).toBe(400);
    expect((await keep(t, first.id, { progress: "bit 1" })).status).toBe(400);
    expect((await keep(t, first.id, {})).status).toBe(400);
    expect((await keep(t, first.id, { progress: { long: "x".repeat(17_000) } })).status).toBe(413);
    const stranger = await setup("another-client-token-0123456789");
    expect((await t.post(`/v1/plans/${stranger.plan.id}/items/${first.id}/progress`, { progress: {} })).status).toBe(404);
  });
});

describe("POST /v1/plans/:id/items/:itemId/answer", () => {
  it("decides an ask branch while it is pending, and refuses anything else", async () => {
    const t = await setup();
    const check = await t.add("Check", { level: 0, type: "quiz" });
    const yes = await t.add("More?", { level: 1, parentId: check.id, condition: { kind: "ask" } });
    const no = await t.add("Extra?", { level: 1, ord: 1, parentId: check.id, condition: { kind: "ask" } });
    const answer = (id: string, body: unknown) => t.post(`/v1/plans/${t.plan.id}/items/${id}/answer`, body);
    expect((await answer(yes.id, { answer: true })).status).toBe(409);

    await t.start();
    await t.drain();
    expect((await answer(check.id, { answer: true })).status).toBe(409);
    expect((await answer(yes.id, { answer: "yes" })).status).toBe(400);

    const accepted = await bodyOf(await answer(yes.id, { answer: true }));
    expect(accepted.item).toMatchObject({ id: yes.id, status: "queued", result: { answer: true } });
    expect(accepted.item.asking).toBeUndefined();
    const declined = await bodyOf(await answer(no.id, { answer: false }));
    expect(declined.item.status).toBe("skipped");
    // Decided: it is no longer asking.
    expect(await bodyOf(await answer(yes.id, { answer: false }))).toMatchObject({ error: "not_asking" });
    await t.drain();
    expect((await t.repos.plans.get(t.plan.id))!.status).toBe("done");
  });

  it("refuses a branch whose condition is not ask", async () => {
    const t = await setup();
    const check = await t.add("Check", { level: 0, type: "quiz" });
    const fix = await t.add("Fix", { level: 1, parentId: check.id, condition: { kind: "metric", metric: "score", below: 0.7 } });
    await t.start();
    await t.drain();
    const response = await t.post(`/v1/plans/${t.plan.id}/items/${fix.id}/answer`, { answer: true });
    expect(response.status).toBe(409);
  });
});

describe("an item waiting on its voice", () => {
  it("says why and what is kept, offers its way on as a button, and the person taking it carries the item on that way", async () => {
    const log = emptyLog();
    const chosen: Array<string | undefined> = [];
    const registry = new FormatRegistry().register(
      fakeDefinition("byte", log, (ctx) => {
        chosen.push(ctx.services.chosen);
        return ctx.services.chosen === WITHOUT_SOUND.id ? {} : { failWith: new JobWait("The voice could not speak.", "voice", "voice_down", {}, { trouble: "credits", choice: WITHOUT_SOUND }) };
      }),
    );
    const engine = createTestEngine({ registry });
    const { repos } = engine.deps;
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const project = await repos.projects.create({ ownerId, title: "Civics" });
    const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, text: "How a bill becomes a law." });
    const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Unit 1" });
    const queue: string[] = [];
    const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
    engine.deps.plans = runner;
    engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
    const node = await repos.plans.addNode({ planId: plan.id, ord: 0, level: 0, type: "byte", title: "Bill to law" });
    await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    await repos.plans.setStatus(plan.id, "approved");
    await runner.kickOff(plan.id);
    const drain = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
    };
    await drain();

    const waiting = (await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}/progress`), engine.deps))).items[0];
    expect(waiting.job).toMatchObject({
      status: "waiting",
      step: "Waiting for the voice…",
      waiting: { reason: "voice", words: expect.stringMatching(/^The voice account is out of credits, so the voice cannot speak\. What was made of this .* so far is kept\. Add credits to the voice account and Open Sourcebook carries on by itself, or finish it now without sound, with the captions carrying the words\.$/) },
      choice: { id: "without_sound", label: "Finish without sound" },
    });

    const retry = (body?: unknown) => handleRequest(authed(`/v1/plans/${plan.id}/items/${node.id}/retry`, { method: "POST", ...(body === undefined ? {} : { body }) }), engine.deps);
    // A waiting item is not failed: a plain retry is refused, and so is a way it does not offer.
    expect((await retry()).status).toBe(409);
    expect((await retry({ choice: "something_else" })).status).toBe(409);
    // The plan runner's "now" is the wall clock's: the engine's own clock is brought to it.
    engine.clock.advanceTo(Date.now() + 1_000);
    expect((await retry({ choice: WITHOUT_SOUND.id })).status).toBe(200);
    await drain();
    const made = (await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}/progress`), engine.deps))).items[0];
    expect(made.status).toBe("done");
    expect(chosen[0]).toBeUndefined();
    expect(chosen.at(-1)).toBe(WITHOUT_SOUND.id);
  });
});

describe("POST /v1/plans/:id/maker", () => {
  it("changes who makes what is left of a stopped plan, says what it left, and refuses a running one", async () => {
    const t = await setup();
    const quiz = await t.add("Quiz", { level: 0, type: "quiz" });
    const byte = await t.add("Byte", { level: 0, ord: 1 });
    await t.start();
    const running = await t.post(`/v1/plans/${t.plan.id}/maker`, { agent: "agent:codex" });
    expect(running.status).toBe(409);
    expect((await bodyOf(running)).error).toBe("plan_running");
    await t.post(`/v1/plans/${t.plan.id}/cancel`, {});

    const changed = await t.post(`/v1/plans/${t.plan.id}/maker`, { agent: "agent:codex:gpt-5", effort: "high" });
    expect(changed.status).toBe(200);
    const body = await bodyOf(changed);
    expect(body.changed).toEqual([quiz.id]);
    expect(body.unchanged).toEqual([{ itemId: byte.id, why: "Made without your agent" }]);
    expect(body.plan.status).toBe("cancelled");
    expect(body.items.find((item: { id: string }) => item.id === quiz.id).settings).toMatchObject({ agent: "agent:codex:gpt-5", effort: "high" });

    expect((await t.post(`/v1/plans/${t.plan.id}/maker`, { effort: "high" })).status).toBe(400);
    expect((await t.post(`/v1/plans/${t.plan.id}/maker`, { agent: 3 })).status).toBe(400);
    expect((await t.post(`/v1/plans/nope/maker`, { agent: null })).status).toBe(404);
  });
});

describe("POST /v1/plans/:id/items/:itemId/stop", () => {
  async function holding() {
    const log = emptyLog();
    const hold = gate();
    let held = false;
    const registry = new FormatRegistry().register(
      fakeDefinition("byte", log, (ctx) => (ctx.node.title === "Second" && !held ? { holdGenerate: async () => void ((held = true), await hold.promise) } : {})),
    );
    const engine = createTestEngine({ registry });
    const { repos } = engine.deps;
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const project = await repos.projects.create({ ownerId, title: "Civics" });
    const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, text: "How a bill becomes a law." });
    const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Unit 1" });
    const queue: string[] = [];
    const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
    engine.deps.plans = runner;
    engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
    const add = async (title: string, level: number, ord = 0) => {
      const node = await repos.plans.addNode({ planId: plan.id, ord, level, type: "byte", title });
      await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
      return node;
    };
    const drain = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
    };
    const post = (path: string) => handleRequest(authed(path, { method: "POST" }), engine.deps);
    const statuses = async () => Object.fromEntries((await repos.plans.listNodes(plan.id)).map((node) => [node.title, node.status]));
    return { engine, repos, plan, runner, log, hold, isHeld: () => held, add, queue, drain, post, statuses };
  }

  it("stops the second of three while it runs, the third is still made, and retry goes on with the second from what it saved", async () => {
    const t = await holding();
    await t.add("First", 0);
    const second = await t.add("Second", 0, 1);
    await t.add("Third", 1);
    await t.repos.plans.setStatus(t.plan.id, "approved");
    await t.runner.kickOff(t.plan.id);
    const [firstJob, secondJob] = t.queue.splice(0);
    await t.engine.deliver(firstJob!);
    const running = t.engine.deliver(secondJob!);
    await until(t.isHeld, "the second item to start making");
    const savedBefore = (await t.engine.deps.jobs.get(secondJob!))!.state;
    expect(savedBefore).toBeTruthy();

    const stopped = await t.post(`/v1/plans/${t.plan.id}/items/${second.id}/stop`);
    expect(stopped.status).toBe(200);
    const view = await bodyOf(stopped);
    // The plan view, as every plan call answers it.
    expect(view.plan).toMatchObject({ id: t.plan.id, status: "running" });
    expect(view.items.map((item: { title: string; status: string }) => [item.title, item.status])).toEqual([
      ["First", "done"],
      ["Second", "cancelled"],
      ["Third", "queued"],
    ]);
    const job = (await t.engine.deps.jobs.get(secondJob!))!;
    expect(job.status).toBe("cancelled");
    // What its maker saved is kept.
    expect(job.state).toEqual(savedBefore);
    t.hold.open();
    expect(await running).toBe("ack");

    await t.drain();
    expect(await t.statuses()).toEqual({ First: "done", Second: "cancelled", Third: "done" });
    // Nothing failed: the plan is stopped with its stopped item, so it can go on.
    expect((await t.repos.plans.get(t.plan.id))!.status).toBe("cancelled");
    // Stopping what is not being made is refused.
    expect(await bodyOf(await t.post(`/v1/plans/${t.plan.id}/items/${second.id}/stop`))).toMatchObject({ error: "item_not_running" });

    const plansBefore = t.log.plans;
    const again = await t.post(`/v1/plans/${t.plan.id}/items/${second.id}/retry`);
    expect(again.status).toBe(200);
    expect((await bodyOf(again)).plan.status).toBe("running");
    await t.drain();
    expect(await t.statuses()).toEqual({ First: "done", Second: "done", Third: "done" });
    expect((await t.repos.plans.get(t.plan.id))!.status).toBe("done");
    // It went on from its saved steps: nothing was planned again.
    expect(t.log.plans).toBe(plansBefore);
  });

  it("lets what depends on the stopped item wait without failing the plan, and makes it once the item goes on", async () => {
    const t = await holding();
    await t.add("First", 0);
    const second = await t.add("Second", 0, 1);
    const third = await t.add("Third", 1);
    await t.repos.plans.addEdge({ fromNode: second.id, toNode: third.id, kind: "assumes" });
    await t.repos.plans.setStatus(t.plan.id, "approved");
    await t.runner.kickOff(t.plan.id);
    const [firstJob, secondJob] = t.queue.splice(0);
    const running = t.engine.deliver(secondJob!);
    await until(t.isHeld, "the second item to start making");
    // Queued or running, either can be stopped.
    expect((await t.post(`/v1/plans/${t.plan.id}/items/${second.id}/stop`)).status).toBe(200);
    t.hold.open();
    await running;
    await t.engine.deliver(firstJob!);
    await t.drain();
    expect(await t.statuses()).toEqual({ First: "done", Second: "cancelled", Third: "skipped" });
    expect((await t.repos.plans.get(t.plan.id))!.status).toBe("cancelled");

    expect((await t.post(`/v1/plans/${t.plan.id}/items/${second.id}/retry`)).status).toBe(200);
    await t.drain();
    expect(await t.statuses()).toEqual({ First: "done", Second: "done", Third: "done" });
    expect((await t.repos.plans.get(t.plan.id))!.status).toBe("done");
  });

  it("answers 404 for an unknown plan or item and 409 for an item that is not being made", async () => {
    const t = await holding();
    const first = await t.add("First", 0);
    const later = await t.add("Later", 1);
    expect((await t.post(`/v1/plans/nope/items/${first.id}/stop`)).status).toBe(404);
    expect((await t.post(`/v1/plans/${t.plan.id}/items/nope/stop`)).status).toBe(404);
    // Before Start nothing is being made.
    expect(await bodyOf(await t.post(`/v1/plans/${t.plan.id}/items/${first.id}/stop`))).toMatchObject({ error: "item_not_running" });
    await t.repos.plans.setStatus(t.plan.id, "approved");
    await t.runner.kickOff(t.plan.id);
    // Not reached yet.
    const pending = await t.post(`/v1/plans/${t.plan.id}/items/${later.id}/stop`);
    expect(pending.status).toBe(409);
    await t.drain();
    // Made already.
    expect((await t.post(`/v1/plans/${t.plan.id}/items/${first.id}/stop`)).status).toBe(409);
  });
});
