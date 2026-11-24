/**
 * Renaming, removing and reading sources again; deleting chats, plans and
 * projects; starting a stopped plan again (docs/api.md, "Removing and
 * deleting", "Approve, Start, cancel"), over the real routes and SQL.
 */
import { describe, expect, it } from "vitest";
import { AssetStore, assetKeyForId } from "../src/assets";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { JobFailure } from "../src/jobs/lifecycle";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import type { SourceEnvelope } from "../src/types";
import { uploadKeyForId } from "../src/uploads";
import { CLIENT_TOKEN, FakeExtractor, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";

const BROKEN = "https://example.test/broken";

async function setup() {
  const log = emptyLog();
  // An item titled "Broken" cannot be made.
  const registry = new FormatRegistry()
    .register(fakeDefinition("byte", log, (ctx) => (ctx.node.title === "Broken" ? { failWith: new JobFailure("No maker answered", false) } : {})))
    .register(fakeDefinition("quiz", log));
  // Links listed here read as nothing at all, until the entry is deleted.
  const byURL: Record<string, Partial<SourceEnvelope>> = { [BROKEN]: { text: "", accessLevel: "none", limitations: ["This page could not be opened."] } };
  const engine = createTestEngine({ registry, extractor: new FakeExtractor(byURL) });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const project = (await call("/v1/projects", "POST", { title: "Linear algebra" })).body.project;
  const addSource = async (body: Record<string, unknown>, projectId: string = project.id) => (await call("/v1/sources", "POST", { projectId, ...body })).body.source;
  const listed = async (projectId: string = project.id) => (await call(`/v1/projects/${projectId}/sources`)).body.sources.map((source: any) => source.id);
  const newPlan = async (sourceId: string, titles: string[] = ["A"], extra: Record<string, unknown> = {}) => {
    const plan = (await call(`/v1/projects/${project.id}/plans`, "POST", { title: "Unit" })).body.plan;
    for (const [level, title] of titles.entries()) {
      await call(`/v1/plans/${plan.id}/items`, "POST", { type: "byte", title, level, sources: [{ sourceId }] });
    }
    await engine.deps.repos.plans.rename(plan.id, "Unit");
    if (extra.sessionId) await engine.db.prepare("UPDATE plans SET session_id = ? WHERE id = ?").bind(extra.sessionId, plan.id).run();
    return plan;
  };
  const start = async (planId: string) => {
    await call(`/v1/plans/${planId}/approve`, "POST");
    return call(`/v1/plans/${planId}/start`, "POST");
  };
  return { engine, byURL, call, drain, queue, project, addSource, listed, newPlan, start };
}

describe("PATCH /v1/sources/:id", () => {
  it("renames a source, clears its title with null, and checks the body", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/a" });
    const renamed = await t.call(`/v1/sources/${source.id}`, "PATCH", { title: "  Week 3 notes " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.source).toMatchObject({ id: source.id, title: "Week 3 notes", status: "ready", accessLevel: "full" });
    expect(renamed.body.source.ownerId).toBeUndefined();
    // Clearing their own name shows the title read from it again.
    expect((await t.call(`/v1/sources/${source.id}`, "PATCH", { title: null })).body.source.title).toBe("Title of https://example.test/a");
    for (const body of [{}, { title: 3 }, { title: "x".repeat(201) }]) {
      expect((await t.call(`/v1/sources/${source.id}`, "PATCH", body)).status).toBe(400);
    }
    expect((await t.call("/v1/sources/missing", "PATCH", { title: "A" })).status).toBe(404);
  });

  it("answers another owner's source as not found", async () => {
    const t = await setup();
    await t.engine.deps.repos.sources.ensureExtraction("url:x", "web");
    const theirs = await t.engine.deps.repos.sources.create({ ownerId: "client:someone-else", contentHash: "url:x", kind: "web" });
    expect((await t.call(`/v1/sources/${theirs.id}`, "PATCH", { title: "Mine now" })).status).toBe(404);
    expect((await t.call(`/v1/sources/${theirs.id}`, "DELETE")).status).toBe(404);
    expect((await t.call(`/v1/sources/${theirs.id}/retry`, "POST")).status).toBe(404);
    expect(await t.engine.deps.repos.sources.get(theirs.id)).toBeDefined();
  });
});

describe("DELETE /v1/sources/:id", () => {
  it("deletes a source nothing points at, with its reading and its uploaded file", async () => {
    const t = await setup();
    const upload = (await t.engine.deps.uploads.putUpload(new TextEncoder().encode("Eigenvalues and eigenvectors."), "text/plain", "eigen.txt"))!;
    const source = await t.addSource({ uploadId: upload.id });
    const hash = (await t.engine.deps.repos.sources.get(source.id))!.contentHash;
    expect(t.engine.bucket.objects.has(uploadKeyForId(upload.id))).toBe(true);
    const removed = await t.call(`/v1/sources/${source.id}`, "DELETE");
    expect(removed).toMatchObject({ status: 200, body: { sourceId: source.id, deleted: true, changedPlanIds: [] } });
    expect(await t.engine.deps.repos.sources.get(source.id)).toBeUndefined();
    expect(await t.engine.deps.repos.sources.getExtraction(hash)).toBeUndefined();
    expect(await t.engine.deps.repos.sources.listChunks(hash)).toEqual([]);
    expect(t.engine.bucket.objects.has(uploadKeyForId(upload.id))).toBe(false);
    expect((await t.call(`/v1/sources/${source.id}`)).status).toBe(404);
    expect((await t.call(`/v1/sources/${source.id}`, "DELETE")).status).toBe(404);
  });

  it("keeps the reading another source shares", async () => {
    const t = await setup();
    const other = (await t.call("/v1/projects", "POST", { title: "Other" })).body.project;
    const here = await t.addSource({ url: "https://example.test/shared" });
    const there = await t.addSource({ url: "https://example.test/shared" }, other.id);
    const hash = (await t.engine.deps.repos.sources.get(here.id))!.contentHash;
    expect((await t.call(`/v1/sources/${here.id}`, "DELETE")).body.deleted).toBe(true);
    expect((await t.engine.deps.repos.sources.getExtraction(hash))?.status).toBe("ready");
    expect(await t.listed(other.id)).toEqual([there.id]);
  });

  it("takes it out of plans not started yet and unticks it in chats", async () => {
    const t = await setup();
    const keep = await t.addSource({ url: "https://example.test/keep" });
    const gone = await t.addSource({ url: "https://example.test/gone" });
    const plan = await t.newPlan(gone.id);
    expect((await t.call(`/v1/plans/${plan.id}/approve`, "POST")).body.plan.status).toBe("approved");
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", { sources: [keep.id, gone.id] })).body.chat;
    const before = (await t.engine.deps.repos.sessions.get(chat.id))!.updatedAt;
    t.engine.clock.advance(1000);

    const removed = await t.call(`/v1/sources/${gone.id}`, "DELETE");
    expect(removed.body).toMatchObject({ deleted: true, changedPlanIds: [plan.id] });
    const view = (await t.call(`/v1/plans/${plan.id}`)).body;
    expect(view.plan.status).toBe("draft");
    expect(view.items[0].sources).toEqual([]);
    expect(view.issueDetails).toEqual([
      { code: "no_sources", message: '"A" reads no sources: pick at least one', short: "Reads no sources: pick at least one", itemId: view.items[0].id },
    ]);
    const after = (await t.call(`/v1/chats/${chat.id}`)).body.chat;
    expect(after.sources).toEqual([keep.id]);
    // Unticking is not use of the chat: its place in the list does not move.
    expect(after.updatedAt).toBe(before);
    expect(await t.listed()).toEqual([keep.id]);
  });

  it("keeps a source a started plan read, hidden, so what was made keeps working", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/used" });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    await t.drain();
    const output = (await t.call(`/v1/plans/${plan.id}/outputs`)).body.outputs[0];

    const removed = await t.call(`/v1/sources/${source.id}`, "DELETE");
    expect(removed.body).toMatchObject({ deleted: false, changedPlanIds: [] });
    expect(await t.listed()).toEqual([]);
    const read = await t.call(`/v1/sources/${source.id}`);
    expect(read.status).toBe(200);
    expect(read.body.source.removedAt).toEqual(expect.any(String));
    expect(read.body.extraction.text).toContain("Text of");
    expect((await t.call(`/v1/plans/${plan.id}`)).body.items[0].sources).toEqual([{ sourceId: source.id }]);
    expect((await t.call(`/v1/outputs/${output.id}`)).status).toBe(200);
    // A removed source takes no rename, retry or filing, and no new item or tick.
    expect((await t.call(`/v1/sources/${source.id}`, "PATCH", { title: "x" })).status).toBe(404);
    expect((await t.call(`/v1/sources/${source.id}/retry`, "POST")).status).toBe(404);
    expect((await t.call(`/v1/sources/${source.id}/file`, "POST", { projectId: null })).status).toBe(404);
    expect((await t.call(`/v1/projects/${t.project.id}/chats`, "POST", { sources: [source.id] })).body.error).toBe("source_not_in_project");
    const draft = (await t.call(`/v1/projects/${t.project.id}/plans`, "POST", {})).body.plan;
    expect((await t.call(`/v1/plans/${draft.id}/items`, "POST", { type: "byte", title: "B", level: 0, sources: [{ sourceId: source.id }] })).body.error).toBe(
      "source_not_in_project",
    );

    // Adding the same link again brings it back.
    const again = await t.call("/v1/sources", "POST", { projectId: t.project.id, url: "https://example.test/used" });
    expect(again.status).toBe(200);
    expect(again.body.source.id).toBe(source.id);
    expect(again.body.source.removedAt).toBeUndefined();
    expect(await t.listed()).toEqual([source.id]);
  });

  it("keeps a source a chat reply cites until that chat is deleted", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/cited" });
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    await t.engine.deps.repos.sessions.append(chat.id, { role: "user", content: { text: "What is a basis?", sources: [source.id] } });
    await t.engine.deps.repos.sessions.append(chat.id, {
      role: "assistant",
      content: { text: "A basis spans.", pieces: [{ kind: "text", text: "A basis spans.", cites: [0] }], cites: [{ sourceId: source.id, spot: "passage", quote: "spans" }] },
    });
    expect((await t.call(`/v1/sources/${source.id}`, "DELETE")).body.deleted).toBe(false);
    expect((await t.call(`/v1/sources/${source.id}`)).body.source.removedAt).toEqual(expect.any(String));

    expect((await t.call(`/v1/chats/${chat.id}`, "DELETE")).status).toBe(200);
    expect(await t.engine.deps.repos.sources.get(source.id)).toBeUndefined();
  });

  it("does not count a source that was only ticked in a message", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/ticked" });
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    await t.engine.deps.repos.sessions.append(chat.id, { role: "user", content: { text: "Hello", sources: [source.id] } });
    expect((await t.call(`/v1/sources/${source.id}`, "DELETE")).body.deleted).toBe(true);
  });
});

describe("POST /v1/sources/:id/retry", () => {
  it("reads a failed source again and refuses one that was read", async () => {
    const t = await setup();
    const failed = await t.addSource({ url: BROKEN });
    const first = await t.call(`/v1/sources/${failed.id}`);
    expect(first.body.extraction.status).toBe("failed");
    const listed = (await t.call(`/v1/projects/${t.project.id}/sources`)).body.sources[0];
    // A failed source says why in lists too, and is named by its link while it has no read title.
    expect(listed).toMatchObject({ id: failed.id, status: "failed", title: "example.test/broken", errorMessage: expect.stringContaining("Nothing could be read"), retryable: true });

    // Still unreadable: it stays failed and says why.
    const still = await t.call(`/v1/sources/${failed.id}/retry`, "POST");
    expect(still.status).toBe(200);
    expect(still.body.extraction).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("Nothing could be read") });

    delete t.byURL[BROKEN];
    const fixed = await t.call(`/v1/sources/${failed.id}/retry`, "POST");
    expect(fixed.status).toBe(200);
    expect(fixed.body.extraction.status).toBe("ready");
    expect(fixed.body.chunkCount).toBeGreaterThan(0);
    expect(await t.call(`/v1/sources/${failed.id}/retry`, "POST")).toMatchObject({ status: 409, body: { error: "source_not_failed" } });
    const read = (await t.call(`/v1/projects/${t.project.id}/sources`)).body.sources[0];
    expect(read).toMatchObject({ status: "ready", title: `Title of ${BROKEN}` });
    expect(read.errorMessage).toBeUndefined();
  });
});

describe("a source's title", () => {
  it("is the same everywhere for a source whose reading is shared, and the person's own name wins", async () => {
    const t = await setup();
    const url = "https://example.test/shared";
    const first = await t.addSource({ url });
    const other = (await t.call("/v1/projects", "POST", { title: "Other" })).body.project;
    // Same content, already read: this one reuses the reading.
    const second = await t.addSource({ url }, other.id);
    const inbox = (await t.call("/v1/sources", "POST", { url })).body.source;
    expect(first.title).toBe(`Title of ${url}`);
    expect(second.title).toBe(`Title of ${url}`);
    expect(inbox.title).toBe(`Title of ${url}`);
    expect((await t.call(`/v1/projects/${other.id}/sources`)).body.sources[0].title).toBe(`Title of ${url}`);
    expect((await t.call("/v1/inbox")).body.sources[0].title).toBe(`Title of ${url}`);
    expect((await t.call(`/v1/sources/${second.id}`)).body.source.title).toBe(`Title of ${url}`);
    // The chat and the planner see the same name.
    const context = await t.engine.deps.repos.sources.listByProject(other.id);
    expect(context[0].title).toBe(`Title of ${url}`);

    await t.call(`/v1/sources/${second.id}`, "PATCH", { title: "My copy" });
    expect((await t.call(`/v1/projects/${other.id}/sources`)).body.sources[0].title).toBe("My copy");
    // Only that person's source is renamed.
    expect((await t.call(`/v1/projects/${t.project.id}/sources`)).body.sources[0].title).toBe(`Title of ${url}`);
  });
});

describe("DELETE /v1/chats/:id", () => {
  it("deletes the chat, its messages and the plans it made that never started, and keeps started ones", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/chat" });
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", { title: "Before the midterm" })).body.chat;
    await t.engine.deps.repos.sessions.append(chat.id, { role: "user", content: { text: "/plan" } });
    const draft = await t.newPlan(source.id, ["Draft item"], { sessionId: chat.id });
    const started = await t.newPlan(source.id, ["Started item"], { sessionId: chat.id });
    await t.start(started.id);
    await t.drain();

    const deleted = await t.call(`/v1/chats/${chat.id}`, "DELETE");
    expect(deleted).toMatchObject({ status: 200, body: { chatId: chat.id, deletedPlanIds: [draft.id], keptPlanIds: [started.id] } });
    expect((await t.call(`/v1/chats/${chat.id}`)).status).toBe(404);
    expect((await t.call(`/v1/plans/${draft.id}`)).status).toBe(404);
    const kept = (await t.call(`/v1/plans/${started.id}`)).body;
    expect(kept.plan.status).toBe("done");
    expect(kept.plan.chatId).toBeUndefined();
    expect((await t.call(`/v1/plans/${started.id}/outputs`)).body.outputs).toHaveLength(1);
    expect(await t.engine.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").bind(chat.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect((await t.call(`/v1/chats/${chat.id}`, "DELETE")).status).toBe(404);
  });

  it("waits for a reply being written", async () => {
    const t = await setup();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    await t.engine.db.prepare("UPDATE sessions SET busy_since = ? WHERE id = ?").bind(new Date().toISOString(), chat.id).run();
    expect(await t.call(`/v1/chats/${chat.id}`, "DELETE")).toMatchObject({ status: 409, body: { error: "chat_busy" } });
  });

  it("renames a chat with PATCH", async () => {
    const t = await setup();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    expect((await t.call(`/v1/chats/${chat.id}`, "PATCH", { title: "Eigenvalues" })).body.chat.title).toBe("Eigenvalues");
    expect((await t.call(`/v1/chats/${chat.id}`, "PATCH", { title: null })).body.chat.title).toBeUndefined();
  });
});

describe("DELETE /v1/projects/:id", () => {
  it("deletes the project with its chats, plans, outputs and sources", async () => {
    const t = await setup();
    const upload = (await t.engine.deps.uploads.putUpload(new TextEncoder().encode("Rank and nullity."), "text/plain", "rank.txt"))!;
    const source = await t.addSource({ uploadId: upload.id });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    await t.drain();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    const inbox = (await t.call("/v1/sources", "POST", { text: "Kept in the Inbox." })).body.source;
    // A removed source is not counted: it is not shown in the project.
    const gone = await t.addSource({ text: "Removed before." });
    await t.call(`/v1/sources/${gone.id}`, "DELETE");

    // What it holds, asked first, is what deleting it reports.
    const asked = await t.call(`/v1/projects/${t.project.id}?counts=1`);
    expect(asked.body).toMatchObject({ project: { id: t.project.id }, counts: { chats: 1, plans: 1, outputs: 1, sources: 1 } });
    expect((await t.call(`/v1/projects/${t.project.id}`)).body.counts).toBeUndefined();
    const deleted = await t.call(`/v1/projects/${t.project.id}`, "DELETE");
    expect(deleted).toMatchObject({ status: 200, body: { projectId: t.project.id, deleted: asked.body.counts } });
    for (const path of [`/v1/projects/${t.project.id}`, `/v1/plans/${plan.id}`, `/v1/chats/${chat.id}`, `/v1/sources/${source.id}`]) {
      expect((await t.call(path)).status).toBe(404);
    }
    expect((await t.call("/v1/outputs")).body.outputs).toEqual([]);
    expect(t.engine.bucket.objects.has(uploadKeyForId(upload.id))).toBe(false);
    for (const table of ["plan_nodes", "plan_node_sources", "item_results", "messages", "source_chunks"]) {
      const row = await t.engine.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row, table).toEqual({ n: table === "source_chunks" ? 1 : 0 });
    }
    // The record of spend stays.
    expect((await t.engine.db.prepare("SELECT COUNT(*) AS n FROM usage").first<{ n: number }>())!.n).toBeGreaterThan(0);
    expect((await t.call("/v1/inbox")).body.sources.map((one: any) => one.id)).toEqual([inbox.id]);
  });

  it("leaves nothing of it, files its made things kept included, and touches nothing of another project", async () => {
    const t = await setup();
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const assets = new AssetStore(t.engine.bucket);
    const keep = async (text: string) => (await assets.putAsset(new TextEncoder().encode(text), { kind: "video", contentType: "video/mp4" }))!;
    const own = await keep("a video only this project made");
    const shared = await keep("a picture both projects show");

    // This project: a source, a started plan and what it made, a chat, and two made things pointing at kept files.
    const source = await t.addSource({ text: "Rank and nullity." });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    await t.drain();
    const chat = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", {})).body.chat;
    await t.engine.deps.repos.outputs.create({ ownerId, projectId: t.project.id, type: "byte", schemaVersion: 1, title: "Its video", payload: { render: { assetId: own.id, url: own.url } } });
    await t.engine.deps.repos.outputs.create({ ownerId, projectId: t.project.id, type: "byte", schemaVersion: 1, title: "Its picture", payload: { picture: shared.url } });

    // Another project: the same, one of its made things showing the shared file.
    const other = (await t.call("/v1/projects", "POST", { title: "Statistics" })).body.project;
    const otherSource = await t.addSource({ text: "Variance and spread." }, other.id);
    const otherPlan = (await t.call(`/v1/projects/${other.id}/plans`, "POST", { title: "Other unit" })).body.plan;
    await t.call(`/v1/plans/${otherPlan.id}/items`, "POST", { type: "byte", title: "B", level: 0, sources: [{ sourceId: otherSource.id }] });
    const otherChat = (await t.call(`/v1/projects/${other.id}/chats`, "POST", {})).body.chat;
    const otherMade = await t.engine.deps.repos.outputs.create({ ownerId, projectId: other.id, type: "byte", schemaVersion: 1, title: "Theirs", payload: { picture: shared.url } });
    const before = (await t.call(`/v1/projects/${other.id}?counts=1`)).body;

    expect((await t.call(`/v1/projects/${t.project.id}`, "DELETE")).status).toBe(200);

    const count = async (sql: string, ...binds: unknown[]) => (await t.engine.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
    for (const table of ["projects", "plans", "sessions", "outputs", "sources"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "projects" ? "id" : "project_id"} = ?`, t.project.id), table).toBe(0);
    }
    expect(await count("SELECT COUNT(*) AS n FROM plan_nodes WHERE plan_id = ?", plan.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", chat.id)).toBe(0);
    expect(t.engine.bucket.objects.has(assetKeyForId(own.id))).toBe(false);
    // A file another project's made thing shows stays.
    expect(t.engine.bucket.objects.has(assetKeyForId(shared.id))).toBe(true);

    expect((await t.call(`/v1/projects/${other.id}?counts=1`)).body).toEqual(before);
    expect((await t.call(`/v1/plans/${otherPlan.id}`)).status).toBe(200);
    expect((await t.call(`/v1/chats/${otherChat.id}`)).status).toBe(200);
    expect(await t.listed(other.id)).toEqual([otherSource.id]);
    expect((await t.call(`/v1/outputs/${otherMade.id}`)).body.output).toMatchObject({ title: "Theirs", payload: { picture: shared.url } });
  });

  it("refuses while a plan in it is running", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/running" });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    expect(await t.call(`/v1/projects/${t.project.id}`, "DELETE")).toMatchObject({ status: 409, body: { error: "project_busy" } });
    await t.call(`/v1/plans/${plan.id}/cancel`, "POST");
    expect((await t.call(`/v1/projects/${t.project.id}`, "DELETE")).status).toBe(200);
  });

  it("lists archived projects and restores one", async () => {
    const t = await setup();
    await t.call(`/v1/projects/${t.project.id}/archive`, "POST");
    expect((await t.call("/v1/projects?archived=only")).body.projects.map((one: any) => one.id)).toEqual([t.project.id]);
    expect((await t.call(`/v1/projects/${t.project.id}/unarchive`, "POST")).body.project.archivedAt).toBeUndefined();
    expect((await t.call("/v1/projects")).body.projects.map((one: any) => one.id)).toEqual([t.project.id]);
  });
});

describe("DELETE /v1/plans/:id", () => {
  const count = async (t: Awaited<ReturnType<typeof setup>>, sql: string, ...binds: unknown[]) => (await t.engine.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
  /** Everything kept of a plan, row by row. */
  const leftOf = async (t: Awaited<ReturnType<typeof setup>>, planId: string, itemIds: string[]) => {
    const marks = itemIds.map(() => "?").join(", ") || "''";
    return {
      plans: await count(t, "SELECT COUNT(*) AS n FROM plans WHERE id = ?", planId),
      items: await count(t, "SELECT COUNT(*) AS n FROM plan_nodes WHERE plan_id = ?", planId),
      itemSources: await count(t, `SELECT COUNT(*) AS n FROM plan_node_sources WHERE node_id IN (${marks})`, ...itemIds),
      results: await count(t, `SELECT COUNT(*) AS n FROM item_results WHERE node_id IN (${marks})`, ...itemIds),
      stages: await count(t, "SELECT COUNT(*) AS n FROM plan_stages WHERE plan_id = ?", planId),
      outputs: await count(t, `SELECT COUNT(*) AS n FROM outputs WHERE node_id IN (${marks})`, ...itemIds),
      jobs: await count(t, `SELECT COUNT(*) AS n FROM generation_jobs WHERE plan_id = ? OR node_id IN (${marks})`, planId, ...itemIds),
    };
  };
  const NOTHING = { plans: 0, items: 0, itemSources: 0, results: 0, stages: 0, outputs: 0, jobs: 0 };

  it("deletes a made thing with its item, its job, what it made and the files only it kept, and touches nothing else", async () => {
    const t = await setup();
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const assets = new AssetStore(t.engine.bucket);
    const keep = async (text: string) => (await assets.putAsset(new TextEncoder().encode(text), { kind: "video", contentType: "video/mp4" }))!;
    const own = await keep("a video only this thing made");
    const shared = await keep("a picture another thing shows too");
    const source = await t.addSource({ text: "Rank and nullity." });
    const plan = await t.newPlan(source.id);
    await t.call(`/v1/plans/${plan.id}/stages/0`, "PUT", { label: "Week 1" });
    await t.start(plan.id);
    await t.drain();
    const made = (await t.call(`/v1/plans/${plan.id}`)).body;
    const item = made.items[0];
    expect(item).toMatchObject({ status: "done" });
    await t.call(`/v1/plans/${plan.id}/items/${item.id}/done`, "POST", { done: true });
    // A second take of the item, showing both files.
    await t.engine.deps.repos.outputs.create({ ownerId, projectId: t.project.id, nodeId: item.id, type: "byte", schemaVersion: 1, title: "Its video", payload: { render: { assetId: own.id, url: own.url }, picture: shared.url } });

    // Another plan of the same project, made too, one of its things showing the shared file.
    const other = await t.newPlan(source.id, ["Other"]);
    await t.start(other.id);
    await t.drain();
    const otherItem = (await t.call(`/v1/plans/${other.id}`)).body.items[0];
    const otherMade = await t.engine.deps.repos.outputs.create({ ownerId, projectId: t.project.id, nodeId: otherItem.id, type: "byte", schemaVersion: 1, title: "Theirs", payload: { picture: shared.url } });
    const otherBefore = (await t.call(`/v1/plans/${other.id}`)).body;
    const otherOutputs = (await t.call(`/v1/plans/${other.id}/outputs`)).body.outputs;
    const usage = await count(t, "SELECT COUNT(*) AS n FROM usage");
    const projectBefore = (await t.call(`/v1/projects/${t.project.id}?counts=1`)).body.counts;
    expect(await leftOf(t, plan.id, [item.id])).toMatchObject({ plans: 1, items: 1, outputs: 2, jobs: 1, results: 1 });

    const deleted = await t.call(`/v1/plans/${plan.id}`, "DELETE");
    expect(deleted).toEqual({ status: 200, body: { planId: plan.id, deleted: { items: 1, outputs: 2, jobs: 1, files: 1 } } });

    expect(await leftOf(t, plan.id, [item.id])).toEqual(NOTHING);
    expect((await t.call(`/v1/plans/${plan.id}`)).status).toBe(404);
    expect((await t.call(`/v1/plans/${plan.id}`, "DELETE")).status).toBe(404);
    expect(t.engine.bucket.objects.has(assetKeyForId(own.id))).toBe(false);
    expect(t.engine.bucket.objects.has(assetKeyForId(shared.id))).toBe(true);
    // The Library and the project's counts no longer have it.
    expect((await t.call("/v1/outputs")).body.outputs.map((o: any) => o.planId)).toEqual(otherOutputs.map(() => other.id));
    expect((await t.call(`/v1/projects/${t.project.id}?counts=1`)).body.counts).toEqual({ ...projectBefore, plans: projectBefore.plans - 1, outputs: projectBefore.outputs - 2 });
    // The other plan, its things and the source are as they were; the record of spend stays.
    expect((await t.call(`/v1/plans/${other.id}`)).body).toEqual(otherBefore);
    expect((await t.call(`/v1/plans/${other.id}/outputs`)).body.outputs).toEqual(otherOutputs);
    expect((await t.call(`/v1/outputs/${otherMade.id}`)).body.output).toMatchObject({ title: "Theirs" });
    expect(await t.listed()).toEqual([source.id]);
    expect(await count(t, "SELECT COUNT(*) AS n FROM usage")).toBe(usage);
  });

  it("deletes a failed thing that made nothing, with its job and the steps its maker saved", async () => {
    const t = await setup();
    const source = await t.addSource({ text: "Kernels." });
    const plan = await t.newPlan(source.id, ["Broken"]);
    await t.start(plan.id);
    await t.drain();
    const view = (await t.call(`/v1/plans/${plan.id}`)).body;
    expect(view.plan.status).toBe("failed");
    expect(view.items[0].status).toBe("failed");
    expect(await count(t, "SELECT COUNT(*) AS n FROM generation_jobs WHERE plan_id = ? AND state_json != '{}'", plan.id)).toBe(1);

    const deleted = await t.call(`/v1/plans/${plan.id}`, "DELETE");
    expect(deleted).toEqual({ status: 200, body: { planId: plan.id, deleted: { items: 1, outputs: 0, jobs: 1, files: 0 } } });
    expect(await leftOf(t, plan.id, [view.items[0].id])).toEqual(NOTHING);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toEqual([]);
  });

  it("deletes a stopped thing, and the queue's late delivery of its job makes nothing", async () => {
    const t = await setup();
    const source = await t.addSource({ text: "Bases." });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    expect((await t.call(`/v1/plans/${plan.id}/cancel`, "POST")).body.plan.status).toBe("cancelled");
    const itemId = (await t.call(`/v1/plans/${plan.id}`)).body.items[0].id;
    expect((await t.call(`/v1/plans/${plan.id}`, "DELETE")).body.deleted).toEqual({ items: 1, outputs: 0, jobs: 1, files: 0 });
    await t.drain();
    expect(await leftOf(t, plan.id, [itemId])).toEqual(NOTHING);
    expect((await t.call("/v1/outputs")).body.outputs).toEqual([]);
  });

  it("deletes a whole plan once it is stopped, and refuses while it is still being made", async () => {
    const t = await setup();
    const source = await t.addSource({ text: "Determinants." });
    const plan = await t.newPlan(source.id, ["First", "Second", "Broken"]);
    await t.start(plan.id);
    // The first is made; the rest are still to come.
    await t.engine.deliver(t.queue.shift()!);
    const running = await t.call(`/v1/plans/${plan.id}`, "DELETE");
    expect(running).toMatchObject({ status: 409, body: { error: "plan_running", message: "This is still being made; stop it first" } });
    expect((await t.call(`/v1/plans/${plan.id}/outputs`)).body.outputs).toHaveLength(1);

    await t.call(`/v1/plans/${plan.id}/cancel`, "POST");
    const itemIds = (await t.call(`/v1/plans/${plan.id}`)).body.items.map((i: any) => i.id);
    const deleted = await t.call(`/v1/plans/${plan.id}`, "DELETE");
    expect(deleted.body.deleted).toMatchObject({ items: 3, outputs: 1 });
    expect(await leftOf(t, plan.id, itemIds)).toEqual(NOTHING);
  });

  it("refuses a made thing while something of it is being made again", async () => {
    const t = await setup();
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const source = await t.addSource({ text: "Traces." });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    await t.drain();
    const item = (await t.call(`/v1/plans/${plan.id}`)).body.items[0];
    // A remake of one part of what it made, queued on the item.
    const { job } = await t.engine.deps.jobs.create({ ownerId, idempotencyKey: "remake-1", type: "byte", nodeId: item.id });
    expect((await t.call(`/v1/plans/${plan.id}`, "DELETE")).status).toBe(409);
    await t.engine.db.prepare("UPDATE generation_jobs SET status = 'done' WHERE id = ?").bind(job.id).run();
    expect((await t.call(`/v1/plans/${plan.id}`, "DELETE")).body.deleted).toMatchObject({ items: 1, jobs: 2 });
  });

  it("deletes a plan never started, and a removed source only it read goes for good", async () => {
    const t = await setup();
    const source = await t.addSource({ text: "Orthogonality." });
    const plan = await t.newPlan(source.id);
    await t.start(plan.id);
    await t.call(`/v1/plans/${plan.id}/cancel`, "POST");
    // Removed while a started plan reads it: kept hidden.
    expect((await t.call(`/v1/sources/${source.id}`, "DELETE")).body.deleted).toBe(false);
    expect((await t.call(`/v1/plans/${plan.id}`, "DELETE")).status).toBe(200);
    expect(await t.engine.deps.repos.sources.get(source.id)).toBeUndefined();

    const draft = (await t.call(`/v1/projects/${t.project.id}/plans`, "POST", { title: "Not yet" })).body.plan;
    expect((await t.call(`/v1/plans/${draft.id}`, "DELETE")).body).toEqual({ planId: draft.id, deleted: { items: 0, outputs: 0, jobs: 0, files: 0 } });
  });

  it("answers another owner's plan as not found and leaves it", async () => {
    const t = await setup();
    const theirs = await t.engine.deps.repos.plans.create({ ownerId: "client:someone-else", projectId: t.project.id, title: "Theirs" });
    expect((await t.call(`/v1/plans/${theirs.id}`, "DELETE")).status).toBe(404);
    expect(await t.engine.deps.repos.plans.get(theirs.id)).toBeDefined();
    expect((await t.call("/v1/plans/missing", "DELETE")).status).toBe(404);
  });
});

describe("POST /v1/plans/:id/resume", () => {
  it("starts a stopped plan again from what is not made yet", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/resume" });
    const plan = await t.newPlan(source.id, ["First", "Second"]);
    await t.start(plan.id);
    // Only the first item is made; the second is queued when the plan is stopped.
    await t.engine.deliver(t.queue.shift()!);
    const stopped = await t.call(`/v1/plans/${plan.id}/cancel`, "POST");
    expect(stopped.body.plan.status).toBe("cancelled");
    expect(stopped.body.items.map((item: any) => item.status)).toEqual(["done", "cancelled"]);
    // The queue still delivers the cancelled job once; it makes nothing.
    await t.drain();
    expect((await t.call(`/v1/plans/${plan.id}/outputs`)).body.outputs).toHaveLength(1);

    const resumed = await t.call(`/v1/plans/${plan.id}/resume`, "POST");
    expect(resumed.status).toBe(200);
    expect(resumed.body.plan.status).toBe("running");
    expect(resumed.body.items.map((item: any) => item.status)).toEqual(["done", "queued"]);
    // The second item's job, cancelled with the plan, is queued again (one job per item).
    expect(t.queue).toHaveLength(1);
    await t.drain();
    const done = (await t.call(`/v1/plans/${plan.id}`)).body;
    expect(done.plan.status).toBe("done");
    expect((await t.call(`/v1/plans/${plan.id}/outputs`)).body.outputs).toHaveLength(2);
    // Resuming a running plan is a no-op; a finished or discarded one is refused.
    expect(await t.call(`/v1/plans/${plan.id}/resume`, "POST")).toMatchObject({ status: 409, body: { error: "plan_not_stopped" } });
  });

  it("answers a running plan as it is and refuses a discarded one", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/resume2" });
    const running = await t.newPlan(source.id);
    await t.start(running.id);
    expect(await t.call(`/v1/plans/${running.id}/resume`, "POST")).toMatchObject({ status: 200, body: { plan: { status: "running" } } });
    const discarded = await t.newPlan(source.id);
    const cancelled = await t.call(`/v1/plans/${discarded.id}/cancel`, "POST");
    expect(cancelled.body.plan.status).toBe("discarded");
    expect(cancelled.body.issues).toEqual([]);
    expect(await t.call(`/v1/plans/${discarded.id}/resume`, "POST")).toMatchObject({ status: 409, body: { error: "plan_not_stopped" } });
    expect(await t.call(`/v1/plans/${discarded.id}/start`, "POST")).toMatchObject({ status: 409, body: { error: "plan_finished" } });
  });

  it("reads a plan stored as cancelled before Start as discarded", async () => {
    const t = await setup();
    const source = await t.addSource({ url: "https://example.test/old" });
    const plan = await t.newPlan(source.id);
    await t.engine.db.prepare("UPDATE plans SET status = 'cancelled' WHERE id = ?").bind(plan.id).run();
    expect((await t.call(`/v1/plans/${plan.id}`)).body.plan.status).toBe("discarded");
  });
});
