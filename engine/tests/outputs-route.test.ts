/**
 * /v1/outputs and usage routes (docs/api.md, "Outputs" and "Usage"): a plan
 * made by fake engines over HTTP, plus outputs written directly for things
 * outside a project, archived ones and another owner's.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { CLIENT_TOKEN, PROVIDER_CALL_USD, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";

async function setup() {
  const log = emptyLog();
  const registry = new FormatRegistry().register(fakeDefinition("byte", log)).register(fakeDefinition("quiz", log));
  const engine = createTestEngine({ registry });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      engine.clock.advance(1000);
      await engine.deliver(next);
    }
  };

  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: "Limits.", projectId: project.id })).body.source;
  const plan = (await call(`/v1/projects/${project.id}/plans`, "POST", {})).body.plan;
  const items = `/v1/plans/${plan.id}/items`;
  await call(items, "POST", { type: "byte", title: "Second", level: 1, prompt: "Assume the first.", sources: [{ sourceId: source.id }] });
  const view = (await call(items, "POST", { type: "quiz", title: "First", level: 0, settings: { n: 3 }, sources: [{ sourceId: source.id, range: { page: 2 } }] })).body;
  await call(`/v1/plans/${plan.id}/approve`, "POST");
  await call(`/v1/plans/${plan.id}/start`, "POST");
  await drain();

  const ownerId = await ownerIdForToken(CLIENT_TOKEN);
  engine.clock.advance(1000);
  const single = await engine.deps.repos.outputs.create({ ownerId, type: "byte", schemaVersion: 1, title: "On its own", payload: {} });
  engine.clock.advance(1000);
  const archived = await engine.deps.repos.outputs.create({ ownerId, type: "byte", schemaVersion: 1, title: "Gone", payload: {} });
  await engine.deps.repos.outputs.archive(archived.id);
  const foreign = await engine.deps.repos.outputs.create({ ownerId: "client:someone-else", type: "byte", schemaVersion: 1, title: "Theirs", payload: {} });
  const first = view.items.find((item: any) => item.title === "First");
  const second = view.items.find((item: any) => item.title === "Second");
  return { engine, call, project, plan, source, single, archived, foreign, first, second };
}

describe("GET /v1/outputs", () => {
  it("is the Library: everything the caller made, newest first, paged, no payloads or archived rows", async () => {
    const t = await setup();
    const all = (await t.call("/v1/outputs")).body.outputs;
    expect(all.map((output: any) => output.title)).toEqual(["On its own", "Output for Second", "Output for First"]);
    expect(all[0].payload).toBeUndefined();
    expect(all[1]).toMatchObject({ type: "byte", projectId: t.project.id, planId: t.plan.id, itemId: t.second.id, schemaVersion: 1, costUsd: expect.any(Number) });
    expect(all[0].projectId).toBeUndefined();
    expect(all[0].planId).toBeUndefined();

    const page = (await t.call("/v1/outputs?limit=2")).body;
    expect(page.outputs).toHaveLength(2);
    const rest = (await t.call(`/v1/outputs?limit=2&cursor=${page.nextCursor}`)).body;
    expect(rest.outputs.map((output: any) => output.title)).toEqual(["Output for First"]);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("filters to things made outside a project and by format", async () => {
    const t = await setup();
    expect((await t.call("/v1/outputs?project=none")).body.outputs.map((output: any) => output.title)).toEqual(["On its own"]);
    expect((await t.call("/v1/outputs?type=quiz")).body.outputs.map((output: any) => output.title)).toEqual(["Output for First"]);
    expect((await t.call("/v1/outputs?project=some")).status).toBe(400);
    expect((await t.call("/v1/outputs?type=Not%20a%20format")).status).toBe(400);
  });

  it("finds things by words in their title, in any case and order, with LIKE's marks taken literally", async () => {
    const t = await setup();
    const titles = async (q: string) => (await t.call(`/v1/outputs?q=${encodeURIComponent(q)}`)).body.outputs.map((output: any) => output.title);
    expect(await titles("SECOND")).toEqual(["Output for Second"]);
    expect(await titles("for output")).toEqual(["Output for Second", "Output for First"]);
    expect(await titles("own on")).toEqual(["On its own"]);
    expect(await titles("%")).toEqual([]);
    expect(await titles("nothing like this")).toEqual([]);
    expect((await t.call(`/v1/projects/${t.project.id}/outputs?q=first`)).body.outputs.map((output: any) => output.title)).toEqual(["Output for First"]);
  });
});

describe("an output's glimpse", () => {
  it("is what its format says of it, served in lists and in full, and absent when the format shows nothing", async () => {
    const log = emptyLog();
    const byte = { ...fakeDefinition("byte", log), glimpse: (payload: any) => (payload?.first ? { text: String(payload.first) } : undefined) };
    const engine = createTestEngine({ registry: new FormatRegistry().register(byte) });
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const shown = await engine.deps.repos.outputs.create({ ownerId, type: "byte", schemaVersion: 1, title: "Shown", payload: { first: "Three names, one idea" } });
    engine.clock.advance(1000);
    await engine.deps.repos.outputs.create({ ownerId, type: "byte", schemaVersion: 1, title: "Bare", payload: {} });
    const listed = await bodyOf(await handleRequest(authed("/v1/outputs"), engine.deps));
    expect(listed.outputs.map((output: any) => output.glimpse)).toEqual([undefined, { text: "Three names, one idea" }]);
    const full = await bodyOf(await handleRequest(authed(`/v1/outputs/${shown.id}`), engine.deps));
    expect(full.output.glimpse).toEqual({ text: "Three names, one idea" });
  });
});

describe("an output's size and done", () => {
  it("serves the size its format says, and whether the person ticked its item done", async () => {
    const log = emptyLog();
    const byte = { ...fakeDefinition("byte", log), size: (payload: any) => (payload?.n ? { count: payload.n, unit: "bits" } : undefined) };
    const engine = createTestEngine({ registry: new FormatRegistry().register(byte) });
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const project = await engine.deps.repos.projects.create({ ownerId, title: "Sizes" });
    const plan = await engine.deps.repos.plans.create({ ownerId, projectId: project.id, title: "Unit" });
    const node = await engine.deps.repos.plans.addNode({ planId: plan.id, type: "byte", title: "Item", level: 0, ord: 0 });
    const made = (title: string, payload: object, nodeId?: string) => {
      engine.clock.advance(1000);
      return engine.deps.repos.outputs.create({ ownerId, projectId: project.id, ...(nodeId ? { nodeId } : {}), type: "byte", schemaVersion: 1, title, payload });
    };
    const older = await made("Older", { n: 3 }, node.id);
    await made("Newer", {}, node.id);
    await made("On its own", { n: 1 });
    const list = async () =>
      Object.fromEntries((await bodyOf(await handleRequest(authed("/v1/outputs"), engine.deps))).outputs.map((output: any) => [output.title, { size: output.size, done: output.done }]));

    expect(await list()).toEqual({
      Older: { size: { count: 3, unit: "bits" }, done: false },
      Newer: { size: undefined, done: false },
      "On its own": { size: { count: 1, unit: "bits" }, done: undefined },
    });
    // A tick naming no output is the item's newest, as the plan view reads it.
    await engine.deps.repos.results.set(node.id, { done: true });
    expect(await list()).toMatchObject({ Older: { done: false }, Newer: { done: true } });
    // A tick naming one is that one.
    await engine.deps.repos.results.set(node.id, { done: true, outputId: older.id });
    expect(await list()).toMatchObject({ Older: { done: true }, Newer: { done: false } });
    expect((await bodyOf(await handleRequest(authed(`/v1/outputs/${older.id}`), engine.deps))).output).toMatchObject({ size: { count: 3, unit: "bits" }, done: true });
    expect((await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}/outputs`), engine.deps))).outputs.map((output: any) => output.done)).toEqual([false, true]);
    await engine.deps.repos.results.set(node.id, { done: false });
    expect(await list()).toMatchObject({ Older: { done: false }, Newer: { done: false } });
  });
});

describe("outputs by project and plan", () => {
  it("lists a project's outputs newest first", async () => {
    const t = await setup();
    const body = (await t.call(`/v1/projects/${t.project.id}/outputs`)).body;
    expect(body.outputs.map((output: any) => output.title)).toEqual(["Output for Second", "Output for First"]);
    expect((await t.call(`/v1/projects/${t.project.id}/outputs?type=byte`)).body.outputs).toHaveLength(1);
  });

  it("lists a plan's outputs in item run order", async () => {
    const t = await setup();
    const body = (await t.call(`/v1/plans/${t.plan.id}/outputs`)).body;
    expect(body.outputs.map((output: any) => output.itemId)).toEqual([t.first.id, t.second.id]);
  });
});

describe("GET /v1/outputs/:id", () => {
  it("returns the payload, citations and the brief, settings and sources as stored", async () => {
    const t = await setup();
    const listed = (await t.call(`/v1/plans/${t.plan.id}/outputs`)).body.outputs[0];
    const { output } = (await t.call(`/v1/outputs/${listed.id}`)).body;
    expect(output).toMatchObject({
      id: listed.id,
      title: "Output for First",
      itemId: t.first.id,
      planId: t.plan.id,
      settings: { n: 3 },
      sources: [{ sourceId: t.source.id, range: { page: 2 } }],
      citations: expect.any(Array),
    });
    expect(output.payload).toBeDefined();
    expect(output.ownerId).toBeUndefined();
  });

  it("reads an archived output and hides another owner's", async () => {
    const t = await setup();
    expect((await t.call(`/v1/outputs/${t.archived.id}`)).body.output.archivedAt).toEqual(expect.any(String));
    expect((await t.call(`/v1/outputs/${t.foreign.id}`)).status).toBe(404);
    expect((await t.call("/v1/outputs/missing")).status).toBe(404);
  });
});

describe("usage", () => {
  it("sums spend for a project and a plan, with each item", async () => {
    const t = await setup();
    const project = (await t.call(`/v1/projects/${t.project.id}/usage`)).body.usage;
    expect(project.calls).toBeGreaterThan(0);
    expect(project.usd).toBeCloseTo(project.calls * PROVIDER_CALL_USD);
    const plan = (await t.call(`/v1/plans/${t.plan.id}/usage`)).body;
    expect(plan.usage.usd).toBeCloseTo(project.usd);
    expect(plan.items.map((item: any) => item.id)).toEqual([t.first.id, t.second.id]);
    const perItem = plan.items.reduce((sum: number, item: any) => sum + item.usage.usd, 0);
    expect(perItem).toBeCloseTo(plan.usage.usd);
  });

  it("hides another owner's project and plan", async () => {
    const t = await setup();
    const ownerId = "client:someone-else";
    const project = await t.engine.deps.repos.projects.create({ ownerId, title: "Theirs" });
    const plan = await t.engine.deps.repos.plans.create({ ownerId, projectId: project.id });
    for (const path of [`/v1/projects/${project.id}/usage`, `/v1/plans/${plan.id}/usage`, `/v1/projects/${project.id}/outputs`, `/v1/plans/${plan.id}/outputs`]) {
      expect((await t.call(path)).status).toBe(404);
    }
  });
});
