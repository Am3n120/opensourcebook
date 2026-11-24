/**
 * Rows written before the three shapes (DECISIONS #33 to #35) keep working
 * without being rewritten: `read`, `bits` and `byte` outputs are served as
 * `flashcards`, their pages and bits turned into cards at read time; `check`
 * is served as `quiz`; plan items with old ids show the new ones; the phone's
 * /v1/jobs wrapper still hands an old page back as it was stored, with the
 * set beside it. Nothing here changes a stored row.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import type { PagePayload } from "../src/cards/blocks";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";

const page: PagePayload = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  type: "note",
  title: "Old read",
  subtitle: "Saved before bytes",
  timeAgo: "just now",
  tags: [],
  status: { type: "ready" },
  blocks: [
    { type: "heading", text: "Limits" },
    { type: "text", text: "Both one-sided limits must agree." },
    { type: "divider" },
    { type: "heading", text: "Continuity" },
    { type: "text", text: "A function is continuous where its limit equals its value." },
  ],
  byteDepth: "light",
};

async function setup() {
  const engine = createTestEngine({ registry: createDefaultRegistry() });
  const ownerId = await ownerIdForToken(CLIENT_TOKEN);
  const read = await engine.deps.repos.outputs.create({ ownerId, type: "read", schemaVersion: 1, title: "Old read", payload: page as never });
  engine.clock.advance(1000);
  const bits = await engine.deps.repos.outputs.create({ ownerId, type: "bits", schemaVersion: 1, title: "Old bits", payload: { ...page, title: "Old bits" } as never });
  engine.clock.advance(1000);
  const check = await engine.deps.repos.outputs.create({ ownerId, type: "check", schemaVersion: 1, title: "Old check", payload: { title: "Old check", passMark: 0.7, feedback: "atEnd", questions: [] } });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps, engine.ctx);
    return { status: response.status, body: await bodyOf(response) };
  };
  return { engine, ownerId, read, bits, check, call };
}

describe("old outputs", () => {
  it("serve a stored read page as cards, one screen each, leaving the row as it was", async () => {
    const t = await setup();
    const { output } = (await t.call(`/v1/outputs/${t.read.id}`)).body;
    expect(output).toMatchObject({ id: t.read.id, type: "flashcards", schemaVersion: 3 });
    expect(output.payload).toMatchObject({ schemaVersion: 3, id: page.id, title: "Old read", sourceKind: "note", upgradedFrom: 1 });
    expect(output.payload.cards.map((card: { id: string; kind: string; section: string; front: Array<{ type: string }> }) => [card.id, card.kind, card.section, card.front.map((block) => block.type)])).toEqual([
      ["c1", "explain", "Limits", ["heading", "text"]],
      ["c2", "explain", "Continuity", ["heading", "text"]],
    ]);

    const stored = (await t.engine.deps.repos.outputs.get(t.read.id))!;
    expect(stored).toMatchObject({ type: "read", schemaVersion: 1, payload: page });
  });

  it("list under the new ids, and a format filter finds rows stored under its old ones", async () => {
    const t = await setup();
    const all = (await t.call("/v1/outputs")).body.outputs;
    expect(all.map((output: { title: string; type: string; schemaVersion: number }) => [output.title, output.type, output.schemaVersion])).toEqual([
      ["Old check", "quiz", 1],
      ["Old bits", "flashcards", 3],
      ["Old read", "flashcards", 3],
    ]);
    const titles = async (type: string) => (await t.call(`/v1/outputs?type=${type}`)).body.outputs.map((output: { title: string }) => output.title);
    expect(await titles("flashcards")).toEqual(["Old bits", "Old read"]);
    expect(await titles("byte")).toEqual(["Old bits", "Old read"]);
    expect(await titles("read")).toEqual(["Old bits", "Old read"]);
    expect(await titles("quiz")).toEqual(["Old check"]);
  });

  it("serve a stored check under quiz with its payload untouched", async () => {
    const t = await setup();
    const { output } = (await t.call(`/v1/outputs/${t.check.id}`)).body;
    expect(output).toMatchObject({ type: "quiz", schemaVersion: 1, payload: { title: "Old check", questions: [] } });
  });
});

describe("old plan items", () => {
  it("show the new id, and an old id sent by a client is stored as the new one", async () => {
    const t = await setup();
    const project = await t.engine.deps.repos.projects.create({ ownerId: t.ownerId, title: "Calc" });
    const plan = await t.engine.deps.repos.plans.create({ ownerId: t.ownerId, projectId: project.id });
    const old = await t.engine.deps.repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "check", title: "Stored as check" });
    const view = (await t.call(`/v1/plans/${plan.id}/items`, "POST", { type: "read", title: "Sent as read", level: 1 })).body;
    expect(view.items.map((item: { title: string; type: string }) => [item.title, item.type])).toEqual([
      ["Stored as check", "quiz"],
      ["Sent as read", "flashcards"],
    ]);
    const rows = await t.engine.deps.repos.plans.listNodes(plan.id);
    expect(rows.map((row) => [row.id === old.id ? "old" : "new", row.type])).toEqual([
      ["old", "check"],
      ["new", "flashcards"],
    ]);
  });
});

describe("the phone's /v1/jobs wrapper", () => {
  it("hands an old read job's page back as stored, with the set beside it", async () => {
    const t = await setup();
    const { job } = await t.engine.deps.jobs.create({ ownerId: t.ownerId, idempotencyKey: "old-read-job", kind: "output", type: "read", input: {} });
    const done = await t.engine.deps.jobs.compareAndSet(job.id, job.version, { status: "done", progress: 1, outputId: t.read.id });
    expect(done.ok).toBe(true);
    const { job: view } = (await t.call(`/v1/jobs/${job.id}`)).body;
    expect(view).toMatchObject({ status: "done", resultByteID: page.id });
    expect(view.result).toEqual(page);
    expect(view.cards).toMatchObject({ schemaVersion: 3, id: page.id, upgradedFrom: 1 });
    expect(view.cards.cards).toHaveLength(2);
  });
});

describe("outputs made by a way of making Open Sourcebook took out (DECISIONS #69)", () => {
  it("still open: a storyboard video with its file, a byte and a quiz the mock engines made, on an engine with no video maker", async () => {
    const engine = createTestEngine({ registry: createDefaultRegistry() });
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const render = { by: "storyboard", storyboard: true, assetId: "a1", url: "/v1/assets/a1", contentType: "video/mp4", width: 720, height: 1280, fps: 10, durationMs: 9000, audio: false, captions: true, scenes: [{ id: "s1", startMs: 0, endMs: 9000 }], renderMs: 900, madeAt: "2026-11-13T09:00:00.000Z" };
    const scene = { id: "s1", kind: "page", durationMs: 9000, visual: { kind: "page", description: "The plan of the video written out." }, narration: "", onScreenText: [], cites: [] };
    const video = await engine.deps.repos.outputs.create({ ownerId, type: "video", schemaVersion: 1, title: "Old storyboard", payload: { schemaVersion: 1, title: "Old storyboard", idea: "One idea.", aspect: { width: 9, height: 16 }, scenes: [scene], render } });
    const byte = await engine.deps.repos.outputs.create({ ownerId, type: "byte", schemaVersion: 2, title: "Old mock byte", payload: { schemaVersion: 2, id: "b1", title: "Old mock byte", sourceKind: "text", depth: "light", bits: [{ id: "bit-1", section: "Plan", blocks: [{ type: "text", text: "What this byte would cover." }] }] } });
    const quiz = await engine.deps.repos.outputs.create({ ownerId, type: "quiz", schemaVersion: 1, title: "Old mock quiz", payload: { title: "Old mock quiz", passMark: 0.7, feedback: "afterEach", questions: [] } });
    for (const [row, type] of [[video, "video"], [byte, "flashcards"], [quiz, "quiz"]] as const) {
      const response = await handleRequest(authed(`/v1/outputs/${row.id}`), engine.deps, engine.ctx);
      expect(response.status, type).toBe(200);
      const { output } = (await bodyOf(response)) as { output: { type: string; title: string } };
      expect(output).toMatchObject({ type, title: row.title });
    }
    const served = (await bodyOf(await handleRequest(authed(`/v1/outputs/${video.id}`), engine.deps, engine.ctx))) as { output: { payload: { render: unknown } } };
    expect(served.output.payload.render).toEqual(render);
  });
});
