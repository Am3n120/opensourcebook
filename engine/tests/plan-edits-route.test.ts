/**
 * Plans over HTTP: create, read, edit items, stages and edges, approve,
 * Start, cancel (docs/api.md, "Plans"), with fake engines, the real plan
 * runner, queue consumer and SQL.
 */
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";

const strictCheck = (log: ReturnType<typeof emptyLog>) => {
  const definition = fakeDefinition("quiz", log);
  return {
    ...definition,
    parseSettings: (raw: unknown) => {
      const questions = (raw as { questions?: unknown } | undefined)?.questions;
      return questions === undefined || (typeof questions === "number" && questions > 0)
        ? { ok: true as const, settings: (raw ?? {}) as Record<string, unknown> }
        : { ok: false as const, issues: [{ path: "$.questions", code: "range", message: "questions must be a positive number", severity: "error" as const }] };
    },
  };
};

async function setup() {
  const log = emptyLog();
  const registry = new FormatRegistry()
    .register(fakeDefinition("byte", log))
    .register(strictCheck(log))
    .declare({ id: "video", label: "video", colorSlot: 3, icon: "play", settings: [], defaults: {} });
  const engine = createTestEngine({ registry });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: response.status === 204 ? null : await bodyOf(response) };
  };
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: "Limits and continuity.", projectId: project.id })).body.source;
  const plan = (await call(`/v1/projects/${project.id}/plans`, "POST", { title: "Unit 1" })).body.plan;
  const add = async (fields: Record<string, unknown>) =>
    call(`/v1/plans/${plan.id}/items`, "POST", { type: "byte", title: "Item", level: 0, sources: [{ sourceId: source.id }], ...fields });
  const itemId = (view: any, title: string) => view.items.find((item: any) => item.title === title).id;
  return { engine, call, drain, queue, project, source, plan, add, itemId };
}

describe("plans in a project", () => {
  it("creates a draft and lists the project's plans with counts", async () => {
    const t = await setup();
    t.engine.clock.advance(1000);
    const created = await t.call(`/v1/projects/${t.project.id}/plans`, "POST", {});
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ plan: { status: "draft", version: 1, projectId: t.project.id }, items: [], edges: [], stages: [], estimateUsd: 0, issues: [] });
    expect(created.body.plan.ownerId).toBeUndefined();
    await t.add({ title: "First" });
    const list = await t.call(`/v1/projects/${t.project.id}/plans`);
    expect(list.body.plans.map((plan: any) => [plan.title, plan.counts])).toEqual([
      ["Unit 1", { total: 1, done: 0 }],
      [undefined, { total: 0, done: 0 }],
    ]);
  });

  it("refuses an archived or foreign project and a bad title", async () => {
    const t = await setup();
    const theirs = await t.engine.deps.repos.projects.create({ ownerId: "client:someone-else", title: "Theirs" });
    expect((await t.call(`/v1/projects/${theirs.id}/plans`, "POST", {})).status).toBe(404);
    expect((await t.call(`/v1/projects/${theirs.id}/plans`)).status).toBe(404);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`, "POST", { title: 4 })).status).toBe(400);
    await t.call(`/v1/projects/${t.project.id}/archive`, "POST");
    const refused = await t.call(`/v1/projects/${t.project.id}/plans`, "POST", {});
    expect(refused).toMatchObject({ status: 409, body: { error: "project_archived" } });
  });

  it("renames a plan and labels stages without touching approval", async () => {
    const t = await setup();
    await t.add({ title: "First" });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    expect((await t.call(`/v1/plans/${t.plan.id}`, "PATCH", { title: "Limits" })).body.plan).toMatchObject({ title: "Limits", status: "approved" });
    const labelled = await t.call(`/v1/plans/${t.plan.id}/stages/1`, "PUT", { label: "Practice" });
    expect(labelled.body.stages).toEqual([{ level: 1, label: "Practice" }]);
    expect(labelled.body.plan.status).toBe("approved");
    expect((await t.call(`/v1/plans/${t.plan.id}/stages/1`, "PUT", { label: null })).body.stages).toEqual([]);
    expect((await t.call(`/v1/plans/${t.plan.id}`, "PATCH", { title: null })).body.plan.title).toBeUndefined();
    expect((await t.call(`/v1/plans/${t.plan.id}/stages/x`, "PUT", { label: "A" })).status).toBe(400);
    expect((await t.call(`/v1/plans/${t.plan.id}/stages/1`, "PUT", {})).status).toBe(400);
    expect((await t.call(`/v1/plans/${t.plan.id}`, "PATCH", {})).status).toBe(400);
  });
});

describe("editing items", () => {
  it("adds an item with every field and reads it back in the plan view", async () => {
    const t = await setup();
    const response = await t.add({
      type: "quiz",
      title: "Limits quiz",
      level: 0,
      prompt: "Diagnostic over 2.1 to 2.3.",
      settings: { questions: 10 },
      sources: [{ sourceId: t.source.id, range: { page: 3, endPage: 9 } }],
      estCostUsd: 0.12,
    });
    expect(response.status).toBe(201);
    const item = response.body.items[0];
    expect(item).toMatchObject({
      type: "quiz",
      title: "Limits quiz",
      level: 0,
      ord: 0,
      prompt: "Diagnostic over 2.1 to 2.3.",
      settings: { questions: 10 },
      enabled: true,
      status: "pending",
      estCostUsd: 0.12,
      done: false,
      sources: [{ sourceId: t.source.id, range: { page: 3, endPage: 9 } }],
    });
    expect(response.body.estimateUsd).toBe(0.12);
    expect((await t.call(`/v1/plans/${t.plan.id}`)).body.items).toEqual(response.body.items);
  });

  it("puts a new item after the others on its level unless ord is given", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    await t.add({ title: "B" });
    const view = (await t.add({ title: "C", ord: -1 })).body;
    expect(view.items.map((item: any) => [item.title, item.ord])).toEqual([["C", -1], ["A", 0], ["B", 1]]);
  });

  it("refuses bad fields, unknown formats, bad settings and sources from elsewhere", async () => {
    const t = await setup();
    const inbox = (await t.call("/v1/sources", "POST", { text: "Loose." })).body.source;
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ type: undefined }, 400, "invalid_request"],
      [{ title: "" }, 400, "invalid_request"],
      [{ level: -1 }, 400, "invalid_request"],
      [{ level: 0.5 }, 400, "invalid_request"],
      [{ settings: "x" }, 400, "invalid_request"],
      [{ enabled: "yes" }, 400, "invalid_request"],
      [{ estCostUsd: -1 }, 400, "invalid_request"],
      [{ sources: [{ sourceId: t.source.id }, { sourceId: t.source.id }] }, 400, "invalid_request"],
      [{ sources: [{ sourceId: t.source.id, range: { page: -2 } }] }, 400, "invalid_request"],
      [{ type: "podcast" }, 400, "unknown_format"],
      [{ type: "quiz", settings: { questions: 0 } }, 400, "invalid_settings"],
      [{ sources: [{ sourceId: inbox.id }] }, 400, "source_not_in_project"],
      [{ sources: [{ sourceId: "missing" }] }, 400, "source_not_in_project"],
    ];
    for (const [fields, status, error] of cases) {
      const response = await t.add(fields);
      expect([fields, response.status, response.body.error]).toEqual([fields, status, error]);
    }
    const settings = await t.add({ type: "quiz", settings: { questions: 0 } });
    expect(settings.body.issues[0]).toMatchObject({ path: "$.questions" });
    expect((await t.call(`/v1/plans/${t.plan.id}`)).body.items).toEqual([]);
  });

  it("allows a declared-only format in a draft and reports it in issues", async () => {
    const t = await setup();
    const view = (await t.add({ type: "video", title: "Lecture" })).body;
    expect(view.issues).toEqual([`"Lecture": Open Sourcebook can't make a video yet`]);
    expect(view.issueDetails).toEqual([
      { code: "format_not_ready", message: `"Lecture": Open Sourcebook can't make a video yet`, short: "Open Sourcebook can't make a video yet", itemId: t.itemId(view, "Lecture") },
    ]);
    const approve = await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    expect(approve).toMatchObject({ status: 422, body: { error: "plan_invalid" } });
    const unchecked = await t.call(`/v1/plans/${t.plan.id}/items/${t.itemId(view, "Lecture")}`, "PATCH", { enabled: false });
    expect(unchecked.body.issues).toEqual([]);
  });

  it("refuses an edit that would break the plan's structure and writes nothing", async () => {
    const t = await setup();
    const parent = t.itemId((await t.add({ type: "quiz", title: "Check" })).body, "Check");
    const sameLevel = await t.add({ title: "Fix", parentId: parent, condition: { kind: "metric", metric: "score", below: 0.7 } });
    expect(sameLevel.status).toBe(422);
    expect(sameLevel.body.issues[0]).toBe('"Fix" must be in a later stage than "Check", the item it branches from');
    expect(sameLevel.body.issueDetails[0]).toEqual({
      code: "branch_parent_not_earlier",
      message: sameLevel.body.issues[0],
      short: 'Must be in a later stage than "Check", the item it branches from',
      itemId: expect.any(String),
    });
    expect((await t.add({ title: "Odd", level: 1, parentId: parent, condition: { kind: "nope" } })).status).toBe(422);
    expect((await t.add({ title: "Orphan", level: 1, condition: { kind: "ask" } })).status).toBe(422);
    expect((await t.add({ title: "Lost", level: 1, parentId: "missing" })).status).toBe(422);

    const view = (await t.add({ title: "Fix", level: 1, parentId: parent, condition: { kind: "metric", metric: "score", below: 0.7 } })).body;
    const fix = t.itemId(view, "Fix");
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${parent}`, "PATCH", { level: 2 })).status).toBe(422);
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${fix}`, "PATCH", { parentId: null })).status).toBe(422);
    const cleared = await t.call(`/v1/plans/${t.plan.id}/items/${fix}`, "PATCH", { parentId: null, condition: null });
    expect(cleared.status).toBe(200);
    const item = cleared.body.items.find((candidate: any) => candidate.id === fix);
    expect(item.parentId).toBeUndefined();
    expect(item.condition).toBeUndefined();
  });

  it("edits an item's format, brief, settings, sources and checkbox", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "First" })).body, "First");
    const path = `/v1/plans/${t.plan.id}/items/${id}`;
    const edited = await t.call(path, "PATCH", {
      type: "quiz",
      title: "Renamed",
      prompt: "New brief.",
      settings: { questions: 5 },
      sources: [{ sourceId: t.source.id }],
      enabled: false,
      estCostUsd: 0.5,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.items[0]).toMatchObject({ type: "quiz", title: "Renamed", prompt: "New brief.", settings: { questions: 5 }, enabled: false, sources: [{ sourceId: t.source.id }] });
    expect(edited.body.estimateUsd).toBe(0);
    expect((await t.call(path, "PATCH", { sources: [], estCostUsd: null })).body.items[0]).toMatchObject({ sources: [] });
    expect((await t.call(path, "PATCH", { settings: { questions: -1 } })).body.error).toBe("invalid_settings");
    expect((await t.call(`/v1/plans/${t.plan.id}/items/missing`, "PATCH", { title: "X" })).status).toBe(404);
  });

  it("removes an item with its branches and edges", async () => {
    const t = await setup();
    const parent = t.itemId((await t.add({ type: "quiz", title: "Check" })).body, "Check");
    let view = (await t.add({ title: "Branch", level: 1, parentId: parent, condition: { kind: "ask" } })).body;
    view = (await t.add({ title: "After", level: 2 })).body;
    await t.call(`/v1/plans/${t.plan.id}/edges`, "POST", { from: parent, to: t.itemId(view, "After"), kind: "fix_of" });
    const removed = await t.call(`/v1/plans/${t.plan.id}/items/${parent}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body.items.map((item: any) => item.title)).toEqual(["After"]);
    expect(removed.body.edges).toEqual([]);
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${parent}`, "DELETE")).status).toBe(404);
  });

  it("reorders items in one step, all or nothing", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    const view = (await t.add({ title: "B" })).body;
    const [a, b] = [t.itemId(view, "A"), t.itemId(view, "B")];
    const moved = await t.call(`/v1/plans/${t.plan.id}/reorder`, "POST", { items: [{ id: a, level: 1, ord: 0 }, { id: b, level: 0, ord: 0 }] });
    expect(moved.body.items.map((item: any) => [item.title, item.level])).toEqual([["B", 0], ["A", 1]]);

    await t.call(`/v1/plans/${t.plan.id}/edges`, "POST", { from: b, to: a, kind: "assumes" });
    const broken = await t.call(`/v1/plans/${t.plan.id}/reorder`, "POST", { items: [{ id: b, level: 1, ord: 1 }] });
    expect(broken.status).toBe(422);
    expect((await t.call(`/v1/plans/${t.plan.id}`)).body.items.map((item: any) => item.title)).toEqual(["B", "A"]);
    for (const body of [{}, { items: [] }, { items: [{ id: a, level: 0, ord: 0 }, { id: a, level: 1, ord: 0 }] }, { items: [{ id: "missing", level: 0, ord: 0 }] }, { items: [{ id: a, level: -1, ord: 0 }] }]) {
      expect((await t.call(`/v1/plans/${t.plan.id}/reorder`, "POST", body)).status).toBe(400);
    }
  });

  it("writes a reorder all at once: a failure part way moves nothing", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    const view = (await t.add({ title: "B" })).body;
    const [a, b] = [t.itemId(view, "A"), t.itemId(view, "B")];
    const db = t.engine.db;
    const prepare = db.prepare.bind(db);
    let updates = 0;
    db.prepare = (sql: string) => {
      if (sql.startsWith("UPDATE plan_nodes") && ++updates === 2) throw new Error("connection lost");
      return prepare(sql);
    };
    const failed = await t.call(`/v1/plans/${t.plan.id}/reorder`, "POST", { items: [{ id: a, level: 1, ord: 0 }, { id: b, level: 2, ord: 0 }] });
    db.prepare = prepare;
    expect(failed.status).toBe(500);
    expect((await t.call(`/v1/plans/${t.plan.id}`)).body.items.map((item: any) => [item.title, item.level])).toEqual([["A", 0], ["B", 0]]);
  });

  it("adds and removes edges with checks", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    const view = (await t.add({ title: "B", level: 1 })).body;
    const [a, b] = [t.itemId(view, "A"), t.itemId(view, "B")];
    const edges = `/v1/plans/${t.plan.id}/edges`;
    expect((await t.call(edges, "POST", { from: a, to: b, kind: "fix_of" })).body.edges).toEqual([{ from: a, to: b, kind: "fix_of" }]);
    expect((await t.call(edges, "POST", { from: a, to: b, kind: "fix_of" })).body.edges).toHaveLength(1);
    expect((await t.call(edges, "POST", { from: b, to: a, kind: "assumes" })).status).toBe(422);
    expect((await t.call(edges, "POST", { from: a, to: a, kind: "assumes" })).status).toBe(400);
    expect((await t.call(edges, "POST", { from: a, to: b, kind: "Bad Kind" })).status).toBe(400);
    expect((await t.call(edges, "POST", { from: a, to: "missing", kind: "assumes" })).status).toBe(400);
    expect((await t.call(`${edges}?from=${a}&to=${b}&kind=assumes`, "DELETE")).status).toBe(404);
    expect((await t.call(`${edges}?from=${a}&to=${b}&kind=fix_of`, "DELETE")).body.edges).toEqual([]);
  });

  it("hides another owner's plan", async () => {
    const t = await setup();
    const ownerId = "client:someone-else";
    const project = await t.engine.deps.repos.projects.create({ ownerId, title: "Theirs" });
    const plan = await t.engine.deps.repos.plans.create({ ownerId, projectId: project.id });
    for (const [path, method, body] of [
      [`/v1/plans/${plan.id}`, "GET"],
      [`/v1/plans/${plan.id}`, "PATCH", { title: "x" }],
      [`/v1/plans/${plan.id}/items`, "POST", { type: "byte", title: "x", level: 0 }],
      [`/v1/plans/${plan.id}/approve`, "POST"],
      [`/v1/plans/${plan.id}/start`, "POST"],
      [`/v1/plans/${plan.id}/cancel`, "POST"],
      ["/v1/plans/missing", "GET"],
    ] as const) {
      expect((await t.call(path, method, body)).status).toBe(404);
    }
  });
});

describe("ids inside a plan the caller owns", () => {
  it("never reach another owner's rows, or another plan's items", async () => {
    const t = await setup();
    const ownerId = "client:someone-else";
    const theirProject = await t.engine.deps.repos.projects.create({ ownerId, title: "Theirs" });
    const theirPlan = await t.engine.deps.repos.plans.create({ ownerId, projectId: theirProject.id });
    const theirItem = await t.engine.deps.repos.plans.addNode({ planId: theirPlan.id, level: 0, ord: 0, type: "byte", title: "Theirs" });
    const theirSource = (await t.engine.deps.repos.sources.create({ ownerId, projectId: theirProject.id, kind: "text", contentHash: (await t.engine.deps.repos.sources.listByProject(t.project.id))[0].contentHash }))!;
    const otherPlan = (await t.call(`/v1/projects/${t.project.id}/plans`, "POST", {})).body.plan;
    const otherItem = t.itemId((await t.call(`/v1/plans/${otherPlan.id}/items`, "POST", { type: "byte", title: "Other plan", level: 0 })).body, "Other plan");
    const otherProject = (await t.call("/v1/projects", "POST", { title: "Elsewhere" })).body.project;
    const elsewhere = (await t.call("/v1/sources", "POST", { text: "Elsewhere.", projectId: otherProject.id })).body.source;
    const mine = t.itemId((await t.add({ title: "Mine", level: 1 })).body, "Mine");
    const base = `/v1/plans/${t.plan.id}`;

    expect((await t.add({ title: "X", sources: [{ sourceId: theirSource.id }] })).body.error).toBe("source_not_in_project");
    expect((await t.add({ title: "X", sources: [{ sourceId: elsewhere.id }] })).body.error).toBe("source_not_in_project");
    expect((await t.call(`${base}/items/${mine}`, "PATCH", { sources: [{ sourceId: theirSource.id }] })).body.error).toBe("source_not_in_project");
    for (const parentId of [theirItem.id, otherItem]) {
      expect((await t.add({ title: "X", level: 2, parentId, condition: { kind: "ask" } })).status).toBe(422);
      expect((await t.call(`${base}/items/${mine}`, "PATCH", { parentId })).status).toBe(422);
      expect((await t.call(`${base}/edges`, "POST", { from: parentId, to: mine, kind: "assumes" })).status).toBe(400);
      expect((await t.call(`${base}/edges?from=${parentId}&to=${mine}&kind=assumes`, "DELETE")).status).toBe(404);
    }
    for (const foreign of [theirItem.id, otherItem]) {
      expect((await t.call(`${base}/items/${foreign}`, "PATCH", { title: "Taken" })).status).toBe(404);
      expect((await t.call(`${base}/items/${foreign}`, "DELETE")).status).toBe(404);
      expect((await t.call(`${base}/reorder`, "POST", { items: [{ id: foreign, level: 5, ord: 0 }] })).status).toBe(400);
    }
    expect((await t.call(`/v1/plans/${theirPlan.id}/stages/0`, "PUT", { label: "Taken" })).status).toBe(404);
    expect((await t.call(`/v1/plans/${theirPlan.id}/reorder`, "POST", { items: [{ id: theirItem.id, level: 5, ord: 0 }] })).status).toBe(404);
    expect((await t.call(`/v1/plans/${theirPlan.id}/items/${theirItem.id}`, "DELETE")).status).toBe(404);

    expect(await t.engine.deps.repos.plans.getNode(theirItem.id)).toMatchObject({ title: "Theirs", level: 0 });
    expect((await t.call(`/v1/plans/${otherPlan.id}`)).body.items).toMatchObject([{ title: "Other plan", level: 0 }]);
    expect(await t.engine.deps.repos.plans.listStages(theirPlan.id)).toEqual([]);
    const view = (await t.call(base)).body;
    expect(view.items.map((item: any) => item.title)).toEqual(["Mine"]);
    expect(view.items[0].parentId).toBeUndefined();
    expect(view.items[0].sources).toEqual([{ sourceId: t.source.id }]);
    expect(view.edges).toEqual([]);
  });
});

describe("items that read no source", () => {
  it("show in issues, and block approve and Start, until the item reads a source or is left out", async () => {
    const t = await setup();
    const base = `/v1/plans/${t.plan.id}`;
    const id = t.itemId((await t.add({ title: "Check", type: "quiz", sources: [] })).body, "Check");
    let view = (await t.call(base)).body;
    expect(view.issues).toEqual(['"Check" reads no sources: pick at least one']);
    expect(await t.call(`${base}/approve`, "POST")).toMatchObject({ status: 422, body: { error: "plan_invalid", issues: ['"Check" reads no sources: pick at least one'] } });
    await t.add({ title: "Notes" });
    view = (await t.call(`${base}/items/${id}`, "PATCH", { enabled: false })).body;
    expect(view.issues).toEqual([]);
    view = (await t.call(`${base}/items/${id}`, "PATCH", { enabled: true, sources: [{ sourceId: t.source.id }] })).body;
    expect(view.issues).toEqual([]);
    expect((await t.call(`${base}/approve`, "POST")).status).toBe(200);
  });
});

describe("making a failed item again", () => {
  it("is refused for a plan that is not running or failed, an item that did not fail, and an item not in the plan", async () => {
    const t = await setup();
    const base = `/v1/plans/${t.plan.id}`;
    const id = t.itemId((await t.add({ title: "A" })).body, "A");
    expect(await t.call(`${base}/items/${id}/retry`, "POST")).toMatchObject({ status: 409, body: { error: "plan_not_running" } });
    expect((await t.call(`${base}/items/nope/retry`, "POST")).status).toBe(404);
    await t.call(`${base}/approve`, "POST");
    await t.call(`${base}/start`, "POST");
    expect(await t.call(`${base}/items/${id}/retry`, "POST")).toMatchObject({ status: 409, body: { error: "item_not_failed" } });
  });
});

describe("plan budget", () => {
  it("is set on create and by PATCH, shows in issues and blocks approval when the estimate passes it", async () => {
    const t = await setup();
    const created = await t.call(`/v1/projects/${t.project.id}/plans`, "POST", { budgetUsd: 1 });
    expect(created.body.plan.budgetUsd).toBe(1);
    const planId = created.body.plan.id;
    let view = (await t.call(`/v1/plans/${planId}/items`, "POST", { type: "byte", title: "A", level: 0, estCostUsd: 0.75, sources: [{ sourceId: t.source.id }] })).body;
    expect(view.issues).toEqual([]);
    view = (await t.call(`/v1/plans/${planId}`, "PATCH", { budgetUsd: 0.5 })).body;
    expect(view.plan.budgetUsd).toBe(0.5);
    expect(view.issues).toEqual([expect.stringContaining("over the plan budget")]);
    expect(await t.call(`/v1/plans/${planId}/approve`, "POST")).toMatchObject({ status: 422, body: { error: "plan_invalid" } });
    const cleared = (await t.call(`/v1/plans/${planId}`, "PATCH", { budgetUsd: null })).body;
    expect(cleared.plan.budgetUsd).toBeUndefined();
    expect(cleared.issues).toEqual([]);
    expect((await t.call(`/v1/plans/${planId}`, "PATCH", { budgetUsd: -1 })).status).toBe(400);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`, "POST", { budgetUsd: "a lot" })).status).toBe(400);
  });

  it("refuses Start when the budget drops below the estimate after approval", async () => {
    const t = await setup();
    await t.add({ title: "A", estCostUsd: 0.75 });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    expect((await t.call(`/v1/plans/${t.plan.id}`, "PATCH", { budgetUsd: 0.5 })).body.plan.status).toBe("approved");
    const refused = await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    expect(refused).toMatchObject({ status: 422, body: { error: "plan_invalid", issues: [expect.stringContaining("over the plan budget")] } });
  });
});

describe("approve, Start and cancel", () => {
  it("approves a valid plan; an edit sends it back to draft", async () => {
    const t = await setup();
    expect((await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).body.issues).toEqual(["the plan has no enabled items"]);
    const id = t.itemId((await t.add({ title: "A" })).body, "A");
    expect((await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).body.plan.status).toBe("approved");
    expect((await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).body.plan.status).toBe("approved");
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "A2" })).body.plan.status).toBe("draft");
  });

  it("starts only an approved plan, then locks its items", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "A", sources: [{ sourceId: t.source.id }] })).body, "A");
    expect(await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).toMatchObject({ status: 409, body: { error: "plan_not_approved" } });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    const started = await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    expect(started.status).toBe(200);
    expect(started.body.plan).toMatchObject({ status: "running", kickedOffAt: expect.any(String) });
    expect(started.body.items[0].status).toBe("queued");
    expect(t.queue).toHaveLength(1);
    expect((await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).body.plan.status).toBe("running");
    expect(t.queue).toHaveLength(1);

    for (const [path, method, body] of [
      [`/v1/plans/${t.plan.id}/items`, "POST", { type: "byte", title: "Late", level: 0 }],
      [`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "Late" }],
      [`/v1/plans/${t.plan.id}/items/${id}`, "DELETE"],
      [`/v1/plans/${t.plan.id}/reorder`, "POST", { items: [{ id, level: 1, ord: 0 }] }],
      [`/v1/plans/${t.plan.id}/approve`, "POST"],
    ] as const) {
      expect(await t.call(path, method, body)).toMatchObject({ status: 409, body: { error: "plan_locked" } });
    }
    expect((await t.call(`/v1/plans/${t.plan.id}`, "PATCH", { title: "Still renamable" })).status).toBe(200);
  });

  it("answers the runner's refusal at Start with its issues", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    // A format that loses its engine between approval and Start.
    const node = (await t.engine.deps.repos.plans.listNodes(t.plan.id))[0];
    await t.engine.deps.repos.plans.updateNode(node.id, { type: "video" });
    const refused = await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    expect(refused).toMatchObject({ status: 422, body: { error: "plan_invalid", issues: [expect.stringContaining("video")] } });
  });

  it("cancels a running plan and refuses a finished one", async () => {
    const t = await setup();
    await t.add({ title: "A", sources: [{ sourceId: t.source.id }] });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    const cancelled = await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST");
    expect(cancelled.body.plan.status).toBe("cancelled");
    expect(cancelled.body.items[0].status).toBe("cancelled");
    expect(await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST")).toMatchObject({ status: 409, body: { error: "plan_finished" } });
    expect(await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).toMatchObject({ status: 409, body: { error: "plan_finished" } });
  });

  it("closes a plan cancelled before Start to edits, approval, Start and ticks", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "A" })).body, "A");
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    const cancelled = await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST");
    // Cancelled before Start: discarded, which a client tells apart from a plan stopped while running.
    expect(cancelled.body.plan.status).toBe("discarded");
    expect(cancelled.body.plan.kickedOffAt).toBeUndefined();
    for (const [path, method, body] of [
      [`/v1/plans/${t.plan.id}/items`, "POST", { type: "byte", title: "Late", level: 0 }],
      [`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "Late" }],
      [`/v1/plans/${t.plan.id}/approve`, "POST"],
      [`/v1/plans/${t.plan.id}/start`, "POST"],
    ] as const) {
      expect(await t.call(path, method, body)).toMatchObject({ status: 409, body: { error: "plan_finished" } });
    }
    for (const body of [{ done: false }, { done: false, result: { score: 1 } }]) {
      expect(await t.call(`/v1/plans/${t.plan.id}/items/${id}/done`, "POST", body)).toMatchObject({ status: 409, body: { error: "plan_not_started" } });
    }
    expect(await t.engine.deps.repos.results.listByPlan(t.plan.id)).toEqual([]);
  });

  it("needs a plan runner for Start and cancel", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    delete t.engine.deps.plans;
    expect((await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).status).toBe(503);
    expect((await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST")).status).toBe(503);
  });
});

describe("a project worked end to end over HTTP", () => {
  it("creates a project, adds a source, writes a plan with a branch, approves, starts, reads progress and ticks", async () => {
    const t = await setup();
    const project = (await t.call("/v1/projects", "POST", { title: "Physics" })).body.project;
    const source = (await t.call("/v1/sources", "POST", { text: "Newton's laws.", projectId: project.id })).body.source;
    const plan = (await t.call(`/v1/projects/${project.id}/plans`, "POST", { title: "Mechanics" })).body.plan;
    const items = `/v1/plans/${plan.id}/items`;
    let view = (await t.call(items, "POST", { type: "byte", title: "Laws", level: 0, sources: [{ sourceId: source.id }] })).body;
    view = (await t.call(items, "POST", { type: "quiz", title: "Check", level: 1, sources: [{ sourceId: source.id }] })).body;
    const check = t.itemId(view, "Check");
    view = (await t.call(items, "POST", {
      type: "byte",
      title: "Fix",
      level: 2,
      parentId: check,
      condition: { kind: "metric", metric: "score", below: 0.7 },
      sources: [{ sourceId: source.id }],
    })).body;
    await t.call(`/v1/plans/${plan.id}/stages/2`, "PUT", { label: "If needed" });
    expect(view.issues).toEqual([]);
    expect((await t.call(`/v1/plans/${plan.id}/approve`, "POST")).body.plan.status).toBe("approved");
    expect((await t.call(`/v1/plans/${plan.id}/start`, "POST")).body.plan.status).toBe("running");
    await t.drain();

    let progress = (await t.call(`/v1/plans/${plan.id}/progress`)).body;
    expect(progress.items.map((item: any) => [item.title, item.status])).toEqual([
      ["Laws", "done"],
      ["Check", "done"],
      ["Fix", "pending"],
    ]);
    const ticked = await t.call(`/v1/plans/${plan.id}/items/${check}/done`, "POST", { result: { score: 0.5 } });
    expect(ticked.body.item).toMatchObject({ done: true, result: { score: 0.5 } });
    await t.drain();
    progress = (await t.call(`/v1/plans/${plan.id}/progress`)).body;
    expect(progress.plan.status).toBe("done");
    expect(progress.items.map((item: any) => item.status)).toEqual(["done", "done", "done"]);
    expect(progress.counts).toEqual({ total: 3, done: 1 });
    expect(progress.stages).toEqual([{ level: 2, label: "If needed" }]);
  });
});

/**
 * Two requests on one plan at once. Each test hands a route the plan as it
 * was read just before another request changed it (a stale read), which is
 * what an interleaving on the Worker looks like to the route.
 */
describe("races between edits, approve, Start and cancel", () => {
  const staleReads = async (t: Awaited<ReturnType<typeof setup>>, times: number) => {
    const repo = t.engine.deps.repos.plans;
    const snapshot = (await repo.get(t.plan.id))!;
    const real = repo.get.bind(repo);
    let left = times;
    return () => {
      repo.get = async (id: string) => (id === snapshot.id && left-- > 0 ? { ...snapshot } : real(id));
    };
  };

  it("answers an edit that loses to Start with 409 plan_locked, not a crash", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "A", sources: [{ sourceId: t.source.id }] })).body, "A");
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    const stale = await staleReads(t, 1);
    await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    stale();
    expect(await t.call(`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "Late" })).toMatchObject({ status: 409, body: { error: "plan_locked" } });
    expect((await t.engine.deps.repos.plans.getNode(id))!.title).toBe("A");
  });

  it("sends a plan approved during an edit back to draft", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "A" })).body, "A");
    const stale = await staleReads(t, 1);
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    stale();
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "A2" })).body.plan.status).toBe("draft");
  });

  it("does not approve a plan cancelled while approve ran", async () => {
    const t = await setup();
    await t.add({ title: "A" });
    const stale = await staleReads(t, 1);
    await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST");
    stale();
    expect(await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).toMatchObject({ status: 409, body: { error: "plan_finished" } });
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("discarded");
  });

  it("does not start a plan an edit sent back to draft after Start read it", async () => {
    const t = await setup();
    const id = t.itemId((await t.add({ title: "A", sources: [{ sourceId: t.source.id }] })).body, "A");
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    const stale = await staleReads(t, 2);
    await t.call(`/v1/plans/${t.plan.id}/items/${id}`, "PATCH", { title: "A2" });
    stale();
    expect(await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).toMatchObject({ status: 409, body: { error: "plan_not_approved" } });
    const plan = (await t.engine.deps.repos.plans.get(t.plan.id))!;
    expect(plan.status).toBe("draft");
    expect(plan.kickedOffAt).toBeUndefined();
    expect(t.queue).toHaveLength(0);
  });

  it("keeps a plan cancelled when its last job settles at the same moment", async () => {
    const t = await setup();
    await t.add({ title: "A", sources: [{ sourceId: t.source.id }] });
    await t.call(`/v1/plans/${t.plan.id}/approve`, "POST");
    await t.call(`/v1/plans/${t.plan.id}/start`, "POST");
    const stale = await staleReads(t, 1);
    await t.call(`/v1/plans/${t.plan.id}/cancel`, "POST");
    stale();
    await t.engine.deps.plans!.advance(t.plan.id);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("cancelled");
  });
});

describe("errors nobody planned for", () => {
  it("are a JSON 500 with the CORS headers, so a browser can read them", async () => {
    const t = await setup();
    t.engine.deps.repos.projects.get = async () => {
      throw new Error("database went away");
    };
    const response = await handleRequest(authed(`/v1/projects/${t.project.id}`), t.engine.deps);
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "internal_error", message: "Something went wrong on the engine" });
  });
});

describe("item cost estimates", () => {
  async function pricedSetup(priced: boolean) {
    const log = emptyLog();
    const byte = fakeDefinition("byte", log);
    const registry = new FormatRegistry().register({
      ...byte,
      // One cent per thousand characters, times the item's `scale` setting.
      estimateCost: ({ settings, sourceChars }) =>
        priced ? { usd: (sourceChars / 1000) * 0.01 * Number((settings as { scale?: number }).scale ?? 1), basis: "test" } : { unpriced: true as const, basis: "no price" },
    });
    const engine = createTestEngine({ registry });
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
    const text = "x".repeat(4_000);
    const source = (await call("/v1/sources", "POST", { text, projectId: project.id })).body.source;
    const plan = (await call(`/v1/projects/${project.id}/plans`, "POST", { title: "Unit 1" })).body.plan;
    return { call, source, plan };
  }

  it("prices an item from its format when it is added, and again when its settings or sources change", async () => {
    const t = await pricedSetup(true);
    const added = await t.call(`/v1/plans/${t.plan.id}/items`, "POST", { type: "byte", title: "A", level: 0, sources: [{ sourceId: t.source.id }] });
    expect(added.body.items[0].estCostUsd).toBeCloseTo(0.04);
    expect(added.body.estimateUsd).toBeCloseTo(0.04);
    const id = added.body.items[0].id;
    const path = `/v1/plans/${t.plan.id}/items/${id}`;
    expect((await t.call(path, "PATCH", { settings: { scale: 2 } })).body.items[0].estCostUsd).toBeCloseTo(0.08);
    // A range prices only the passages in it.
    const ranged = (await t.call(path, "PATCH", { sources: [{ sourceId: t.source.id, range: { charStart: 0, charEnd: 1_000 } }] })).body.items[0].estCostUsd;
    expect(ranged).toBeGreaterThan(0);
    expect(ranged).toBeLessThan(0.08);
    expect((await t.call(path, "PATCH", { title: "Renamed" })).body.items[0].estCostUsd).toBe(ranged);
    // A cost the client sets is kept.
    expect((await t.call(path, "PATCH", { settings: { scale: 3 }, estCostUsd: 1.5 })).body.items[0].estCostUsd).toBe(1.5);
  });

  it("leaves the estimate out when the format's model has no price, never $0", async () => {
    const t = await pricedSetup(false);
    const added = await t.call(`/v1/plans/${t.plan.id}/items`, "POST", { type: "byte", title: "A", level: 0, sources: [{ sourceId: t.source.id }] });
    expect(added.body.items[0].estCostUsd).toBeUndefined();
  });
});
