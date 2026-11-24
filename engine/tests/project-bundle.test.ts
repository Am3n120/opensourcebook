/**
 * A project as one file and back (studio/bundle.ts): GET /v1/projects/:id/export
 * and POST /v1/projects/import, over the real routes and SQL.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";

const TEXT = "# Tides\n\nThe Moon's pull raises the sea on the side of the Earth facing it. A second bulge forms on the far side.";

async function setup() {
  const engine = createTestEngine();
  const call = (path: string, method = "GET", body?: unknown) => handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
  const ownerId = await ownerIdForToken(CLIENT_TOKEN);
  const { project } = await bodyOf(await call("/v1/projects", "POST", { title: "Tides" }));
  const added = await bodyOf(await call("/v1/sources", "POST", { text: TEXT, projectId: project.id }));
  const repos = engine.deps.repos;
  const source = (await repos.sources.get(added.source.id))!;
  const [chunk] = await repos.sources.listChunks(source.contentHash);
  const chat = await repos.sessions.create({ ownerId, projectId: project.id, title: "What makes tides" });
  await repos.sessions.append(chat.id, { role: "user", content: { text: "What makes tides?" } });
  const plan = await repos.plans.create({ ownerId, projectId: project.id, sessionId: chat.id, title: "Tides in two steps" });
  const good = { sourceId: source.id, spot: "passage", chunkId: chunk!.id, quote: "The Moon's pull raises the sea" };
  const bad = { sourceId: source.id, spot: "passage", chunkId: chunk!.id, quote: "words the source never says" };
  await repos.sessions.append(chat.id, {
    role: "assistant",
    content: {
      text: "The Moon pulls the sea.",
      state: "done",
      pieces: [
        { kind: "text", text: "Not said by the source.", cites: [0] },
        { kind: "text", text: "The Moon pulls the sea.", cites: [1] },
        { kind: "plan", planId: plan.id, action: "created" },
      ],
      cites: [bad, good],
    },
  });
  // A reply still being written is not kept.
  await repos.sessions.append(chat.id, { role: "assistant", content: { text: "", pieces: [], state: "running" } });
  const quizNode = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "quiz", title: "Check the two bulges" });
  await repos.plans.setNodeSources(quizNode.id, [{ sourceId: source.id }]);
  await repos.outputs.create({
    ownerId,
    projectId: project.id,
    nodeId: quizNode.id,
    type: "quiz",
    schemaVersion: 1,
    title: "Check the two bulges",
    payload: { questions: [{ prompt: "How many bulges?" }] },
    citations: [good],
    sources: [{ sourceId: source.id }],
  });
  await repos.plans.updateNode(quizNode.id, { status: "done" });
  const videoNode = await repos.plans.addNode({ planId: plan.id, level: 1, ord: 0, type: "video", title: "Tides, drawn" });
  await repos.outputs.create({ ownerId, projectId: project.id, nodeId: videoNode.id, type: "video", schemaVersion: 1, title: "Tides, drawn", payload: { url: "/v1/assets/abc" } });
  await repos.plans.updateNode(videoNode.id, { status: "done" });
  await repos.plans.setStageDate(plan.id, 1, "2026-12-01");
  await repos.plans.setStatus(plan.id, "running");
  await repos.plans.setStatus(plan.id, "done");
  return { engine, call, project, source };
}

describe("GET /v1/projects/:id/export", () => {
  it("writes the sources' text, the finished chat and the plans with what they made", async () => {
    const t = await setup();
    const response = await t.call(`/v1/projects/${t.project.id}/export`);
    expect(response.status).toBe(200);
    const { bundle } = await bodyOf(response);
    expect(bundle).toMatchObject({ opensourcebook: "project", version: 1, project: { title: "Tides" } });
    expect(bundle).not.toHaveProperty("re");
    expect(bundle.sources).toEqual([{ key: "s1", kind: "text", title: "Tides", text: TEXT }]);
    const [chat] = bundle.chats;
    expect(chat.title).toBe("What makes tides");
    expect(chat.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[1].content.state).toBeUndefined();
    expect(chat.messages[1].content.cites[1]).toEqual({ source: "s1", quote: "The Moon's pull raises the sea" });
    expect(chat.messages[1].content.pieces[2]).toMatchObject({ kind: "plan", planId: "p1" });
    const [plan] = bundle.plans;
    expect(plan).toMatchObject({ key: "p1", chat: chat.key, title: "Tides in two steps", status: "done" });
    expect(plan.items[0]).toMatchObject({ type: "quiz", status: "done", sources: ["s1"], output: { title: "Check the two bulges", citations: [{ source: "s1" }] } });
    // The video's file is not in the bundle, so the item goes back to waiting.
    expect(plan.items[1]).toMatchObject({ type: "video", status: "pending" });
    expect(plan.items[1].output).toBeUndefined();
  });

  it("is a 404 for a project that is not there", async () => {
    const t = await setup();
    expect((await t.call("/v1/projects/nope/export")).status).toBe(404);
  });
});

describe("POST /v1/projects/import", () => {
  it("makes a new project from a bundle, finding every cite again word for word", async () => {
    const t = await setup();
    const { bundle } = await bodyOf(await t.call(`/v1/projects/${t.project.id}/export`));
    const response = await t.call("/v1/projects/import", "POST", { bundle, example: "tides" });
    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body.project).toMatchObject({ title: "Tides", settings: { example: "tides" } });
    expect(body.droppedCites).toBe(1);
    const id = body.project.id;
    expect(id).not.toBe(t.project.id);

    const { sources } = await bodyOf(await t.call(`/v1/projects/${id}/sources`));
    expect(sources).toHaveLength(1);
    const { chats } = await bodyOf(await t.call(`/v1/projects/${id}/chats`));
    expect(chats.map((c: any) => c.title)).toEqual(["What makes tides"]);
    const { messages } = await bodyOf(await t.call(`/v1/chats/${chats[0].id}`));
    const { plans } = await bodyOf(await t.call(`/v1/projects/${id}/plans`));
    const reply = messages[1];
    // The cite whose words are not in the source is gone, and the pieces point at the one kept.
    expect(reply.cites).toHaveLength(1);
    expect(reply.cites[0]).toMatchObject({ sourceId: sources[0].id, spot: "passage", quote: "The Moon's pull raises the sea" });
    expect(reply.pieces[0].cites).toEqual([]);
    expect(reply.pieces[1].cites).toEqual([0]);
    expect(reply.pieces[2].planId).toBe(plans[0].id);

    const { outputs } = await bodyOf(await t.call(`/v1/projects/${id}/outputs`));
    expect(outputs.map((o: any) => o.title)).toEqual(["Check the two bulges"]);
    const view = await bodyOf(await t.call(`/v1/plans/${plans[0].id}`));
    expect(view.plan.status).toBe("done");
    expect(view.items.map((i: any) => [i.title, i.status, Boolean(i.outputId)])).toEqual([
      ["Check the two bulges", "done", true],
      ["Tides, drawn", "pending", false],
    ]);
    expect(view.stages).toEqual([{ level: 1, dueOn: "2026-12-01" }]);
  });

  it("reads a file exported before the rename, marked re, and one marked opensourcebook", async () => {
    const t = await setup();
    const { bundle } = await bodyOf(await t.call(`/v1/projects/${t.project.id}/export`));
    const { opensourcebook: _mark, ...rest } = bundle;
    const old = await t.call("/v1/projects/import", "POST", { bundle: { re: "project", ...rest } });
    expect(old.status).toBe(201);
    const made = (await bodyOf(old)).project;
    expect(made.title).toBe("Tides");
    expect((await t.call("/v1/projects/import", "POST", { bundle })).status).toBe(201);
    // Written out again, it carries the new mark only.
    const again = await bodyOf(await t.call(`/v1/projects/${made.id}/export`));
    expect(again.bundle.opensourcebook).toBe("project");
    expect(again.bundle).not.toHaveProperty("re");
  });

  it("refuses what is not a bundle and an example name that is not a folder name", async () => {
    const t = await setup();
    for (const bundle of [undefined, {}, { opensourcebook: "project", version: 9, project: { title: "x" } }, { opensourcebook: "project", version: 1, project: { title: "" } }, { opensourcebook: "project", version: 1, project: { title: "x" }, sources: [{ key: "s1" }] }, { re: "project", version: 9, project: { title: "x" } }, { re: "thing", version: 1, project: { title: "x" } }]) {
      const response = await t.call("/v1/projects/import", "POST", { bundle });
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBe("invalid_bundle");
    }
    const { bundle } = await bodyOf(await t.call(`/v1/projects/${t.project.id}/export`));
    expect((await t.call("/v1/projects/import", "POST", { bundle, example: "../up" })).status).toBe(400);
  });
});
