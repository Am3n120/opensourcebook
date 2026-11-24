/**
 * /v1/projects, project sources, the Inbox and filing, over the real
 * routes and SQL (docs/api.md).
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";

function setup() {
  const engine = createTestEngine();
  const call = (path: string, method = "GET", body?: unknown) => handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
  const create = async (body: unknown) => bodyOf(await call("/v1/projects", "POST", body));
  return { engine, call, create };
}

describe("POST /v1/projects", () => {
  it("creates a project the caller owns and leaves the owner hash out", async () => {
    const t = setup();
    const response = await t.call("/v1/projects", "POST", { title: "  Calculus I ", icon: "book", colorHex: 0x336699, category: "math", settings: { a: 1 } });
    expect(response.status).toBe(201);
    const { project } = await bodyOf(response);
    expect(project).toMatchObject({ title: "Calculus I", icon: "book", colorHex: 0x336699, category: "math", settings: { a: 1 } });
    expect(project.ownerId).toBeUndefined();
    const stored = await t.engine.deps.repos.projects.get(project.id);
    expect(stored!.ownerId).toBe(await ownerIdForToken(CLIENT_TOKEN));
  });

  it("refuses a missing or blank title and wrong field types", async () => {
    const t = setup();
    for (const body of [{}, { title: "  " }, { title: 3 }, { title: "x".repeat(201) }, { title: "A", colorHex: -1 }, { title: "A", colorHex: 1.5 }, { title: "A", settings: [] }]) {
      const response = await t.call("/v1/projects", "POST", body);
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBe("invalid_request");
    }
    expect((await t.call("/v1/projects", "POST", "nope")).status).toBe(400);
  });

  it("needs the token", async () => {
    const t = setup();
    const response = await handleRequest(new Request("https://engine.test/v1/projects", { method: "POST", body: "{}" }), t.engine.deps);
    expect(response.status).toBe(401);
  });
});

describe("GET /v1/projects", () => {
  it("lists live projects, most recently updated first, in pages", async () => {
    const t = setup();
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      ids.push((await t.create({ title })).project.id);
      t.engine.clock.advance(1000);
    }
    const first = await bodyOf(await t.call("/v1/projects?limit=2"));
    expect(first.projects.map((project: any) => project.title)).toEqual(["Three", "Two"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await bodyOf(await t.call(`/v1/projects?limit=2&cursor=${first.nextCursor}`));
    expect(second.projects.map((project: any) => project.title)).toEqual(["One"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("filters archived projects and checks its query", async () => {
    const t = setup();
    const live = (await t.create({ title: "Live" })).project;
    const old = (await t.create({ title: "Old" })).project;
    await t.call(`/v1/projects/${old.id}/archive`, "POST");
    const titles = async (query: string) => (await bodyOf(await t.call(`/v1/projects${query}`))).projects.map((project: any) => project.title).sort();
    expect(await titles("")).toEqual([live.title]);
    expect(await titles("?archived=only")).toEqual([old.title]);
    expect(await titles("?archived=include")).toEqual(["Live", "Old"]);
    for (const query of ["?archived=yes", "?limit=0", "?limit=201", "?limit=x", "?cursor=garbage"]) {
      expect((await t.call(`/v1/projects${query}`)).status).toBe(400);
    }
  });

  it("shows only the caller's projects", async () => {
    const t = setup();
    await t.engine.deps.repos.projects.create({ ownerId: "client:someone-else", title: "Theirs" });
    await t.create({ title: "Mine" });
    const body = await bodyOf(await t.call("/v1/projects"));
    expect(body.projects.map((project: any) => project.title)).toEqual(["Mine"]);
  });
});

describe("GET, PATCH /v1/projects/:id and archiving", () => {
  it("reads, renames, clears fields and keeps the rest", async () => {
    const t = setup();
    const { project } = await t.create({ title: "Draft name", icon: "book", category: "math" });
    expect((await bodyOf(await t.call(`/v1/projects/${project.id}`))).project.title).toBe("Draft name");
    const renamed = await t.call(`/v1/projects/${project.id}`, "PATCH", { title: "Calculus", icon: null });
    expect(renamed.status).toBe(200);
    const body = (await bodyOf(renamed)).project;
    expect(body).toMatchObject({ title: "Calculus", category: "math" });
    expect(body.icon).toBeUndefined();
    expect((await t.call(`/v1/projects/${project.id}`, "PATCH", { title: "" })).status).toBe(400);
  });

  it("archives and unarchives idempotently, keeping the first archive time", async () => {
    const t = setup();
    const { project } = await t.create({ title: "P" });
    const archived = (await bodyOf(await t.call(`/v1/projects/${project.id}/archive`, "POST"))).project;
    expect(archived.archivedAt).toEqual(expect.any(String));
    t.engine.clock.advance(5000);
    const again = (await bodyOf(await t.call(`/v1/projects/${project.id}/archive`, "POST"))).project;
    expect(again.archivedAt).toBe(archived.archivedAt);
    const back = (await bodyOf(await t.call(`/v1/projects/${project.id}/unarchive`, "POST"))).project;
    expect(back.archivedAt).toBeUndefined();
    expect((await t.call(`/v1/projects/${project.id}/unarchive`, "POST")).status).toBe(200);
  });

  it("hides another owner's project", async () => {
    const t = setup();
    const theirs = await t.engine.deps.repos.projects.create({ ownerId: "client:someone-else", title: "Theirs" });
    for (const [path, method, body] of [
      [`/v1/projects/${theirs.id}`, "GET"],
      [`/v1/projects/${theirs.id}`, "PATCH", { title: "Mine now" }],
      [`/v1/projects/${theirs.id}/archive`, "POST"],
      [`/v1/projects/${theirs.id}/sources`, "GET"],
      ["/v1/projects/missing", "GET"],
    ] as const) {
      expect((await t.call(path, method, body)).status).toBe(404);
    }
    expect((await t.engine.deps.repos.projects.get(theirs.id))!.title).toBe("Theirs");
  });
});

describe("sources, the Inbox and filing", () => {
  it("lists a project's sources oldest first and the Inbox newest first, with status", async () => {
    const t = setup();
    const { project } = await t.create({ title: "P" });
    for (const text of ["First note.", "Second note."]) {
      expect((await t.call("/v1/sources", "POST", { text, projectId: project.id })).status).toBe(201);
      t.engine.clock.advance(1000);
    }
    for (const text of ["Inbox one.", "Inbox two."]) {
      await t.call("/v1/sources", "POST", { text, title: text });
      t.engine.clock.advance(1000);
    }
    const inProject = await bodyOf(await t.call(`/v1/projects/${project.id}/sources`));
    expect(inProject.sources).toHaveLength(2);
    expect(inProject.sources[0]).toMatchObject({ projectId: project.id, status: "ready" });
    expect(inProject.sources[0].ownerId).toBeUndefined();
    expect(inProject.sources[0].contentHash).toBeUndefined();
    expect(inProject.sources[0].createdAt < inProject.sources[1].createdAt).toBe(true);

    const inbox = await bodyOf(await t.call("/v1/inbox?limit=1"));
    expect(inbox.sources.map((source: any) => source.title)).toEqual(["Inbox two."]);
    const rest = await bodyOf(await t.call(`/v1/inbox?limit=1&cursor=${inbox.nextCursor}`));
    expect(rest.sources.map((source: any) => source.title)).toEqual(["Inbox one."]);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("files an Inbox source into a project and back", async () => {
    const t = setup();
    const { project } = await t.create({ title: "P" });
    const { source } = await bodyOf(await t.call("/v1/sources", "POST", { text: "Loose note." }));
    const filed = await t.call(`/v1/sources/${source.id}/file`, "POST", { projectId: project.id });
    expect(filed.status).toBe(200);
    expect((await bodyOf(filed)).source).toMatchObject({ id: source.id, projectId: project.id, status: "ready" });
    expect((await bodyOf(await t.call("/v1/inbox"))).sources).toEqual([]);
    expect((await bodyOf(await t.call(`/v1/projects/${project.id}/sources`))).sources).toHaveLength(1);
    expect((await t.call(`/v1/sources/${source.id}/file`, "POST", { projectId: project.id })).status).toBe(200);

    const back = (await bodyOf(await t.call(`/v1/sources/${source.id}/file`, "POST", { projectId: null }))).source;
    expect(back.projectId).toBeUndefined();
    expect((await bodyOf(await t.call("/v1/inbox"))).sources).toHaveLength(1);
  });

  it("refuses a bad body, a foreign project or source and an archived project", async () => {
    const t = setup();
    const { project } = await t.create({ title: "P" });
    const { source } = await bodyOf(await t.call("/v1/sources", "POST", { text: "Loose note." }));
    const theirs = await t.engine.deps.repos.projects.create({ ownerId: "client:someone-else", title: "Theirs" });
    const file = (id: string, body: unknown) => t.call(`/v1/sources/${id}/file`, "POST", body);
    expect((await file(source.id, {})).status).toBe(400);
    expect((await file(source.id, { projectId: 7 })).status).toBe(400);
    expect(await bodyOf(await file(source.id, { projectId: theirs.id }))).toMatchObject({ error: "project_not_found" });
    expect((await file("missing", { projectId: project.id })).status).toBe(404);

    await t.call(`/v1/projects/${project.id}/archive`, "POST");
    const refused = await file(source.id, { projectId: project.id });
    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).error).toBe("project_archived");
    const added = await t.call("/v1/sources", "POST", { text: "Another.", projectId: project.id });
    expect(added.status).toBe(409);
  });
});
