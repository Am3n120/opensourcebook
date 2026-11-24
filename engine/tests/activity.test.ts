/** GET /v1/activity: what is being made now, the connector's finished turns placed by what they were for, and totals. */
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { ownerIdForToken } from "../src/http";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { FetchLike } from "../src/types";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const DAY = "2026-11-22T00:00:00.000Z";

interface LogTurn {
  line: number;
  time: string;
  turnId: string;
  agent: string;
  type?: string;
  targetId?: string;
  [key: string]: unknown;
}

/** A connector that serves `turns` (oldest first, as the log is written) from GET /usage the way the real one pages them. */
function connector(turns: LogTurn[], options: { off?: boolean; down?: boolean } = {}) {
  const asked: string[] = [];
  const fetch: FetchLike = async (input) => {
    if (options.down) throw new TypeError("fetch failed: connection refused");
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/status") return Response.json({ agents: [{ id: "claude", label: "Claude Code", installed: true }], running: 0 });
    if (url.pathname === "/usage") {
      if (options.off) return Response.json({ turns: [], off: true });
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = Number(url.searchParams.get("before") ?? Number.POSITIVE_INFINITY);
      const older = turns.filter((turn) => turn.line < before).reverse();
      const page = older.slice(0, limit);
      return Response.json({ turns: page, ...(older.length > limit ? { next: page.at(-1)!.line } : {}) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  return { fetch, asked };
}

function turn(line: number, time: string, over: Partial<LogTurn> = {}): LogTurn {
  return { line, time, turnId: `t${line}`, agent: "claude", model: "haiku", inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, durationMs: 4000, toolCalls: 3, outcome: "done", ...over };
}

async function world(turns: (ids: { chatId: string; nodeId: string; jobId: string; otherChat: string }) => LogTurn[], options: { off?: boolean; down?: boolean; noAgent?: boolean } = {}) {
  let fake: ReturnType<typeof connector> | undefined;
  const engine = createTestEngine({ registry: createDefaultRegistry(), ...(options.noAgent ? {} : { agent: { fetch: (input, init) => fake!.fetch(input, init) } }) });
  const owner = await ownerIdForToken("test-client-token-0123456789");
  const { repos } = engine.deps;
  const project = await repos.projects.create({ ownerId: owner, title: "Cell biology" });
  const chat = await repos.sessions.create({ ownerId: owner, projectId: project.id, title: "Mitosis questions" });
  const plan = await repos.plans.create({ ownerId: owner, projectId: project.id });
  const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "quiz", title: "Check the phases" });
  const video = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 1, type: "video", title: "The spindle", settings: { agent: "agent:claude:opus", effort: "high" } });
  const { job } = await engine.deps.jobs.create({ ownerId: owner, idempotencyKey: "video-job-key", kind: "output", type: "video", projectId: project.id, planId: plan.id, nodeId: video.id, input: { title: "The spindle", settings: { agent: "agent:claude:opus", effort: "high" } } });
  await engine.deps.jobs.compareAndSet(job.id, job.version, { status: "running", stage: "writing", progress: 0.3, startedAt: "2026-11-22T09:00:00.000Z", state: { step: "Drawing scene 3 of 7" } });
  const other = await repos.sessions.create({ ownerId: "someone-else", title: "Not yours" });
  fake = connector(turns({ chatId: chat.id, nodeId: node.id, jobId: job.id, otherChat: other.id }), options);
  const get = async (query = "") => bodyOf(await handleRequest(authed(`/v1/activity${query}`), engine.deps));
  return { engine, get, project, chat, plan, node, video, job, fake };
}

describe("GET /v1/activity", () => {
  it("needs the client token", async () => {
    const engine = createTestEngine();
    expect((await handleRequest(new Request("https://engine.test/v1/activity"), engine.deps)).status).toBe(401);
  });

  it("joins what is being made now with the finished turns, each placed by what it was for, with no cost", async () => {
    const w = await world((ids) => [
      turn(1, "2026-11-21T10:00:00.000Z", { type: "chat", targetId: ids.chatId }),
      turn(2, "2026-11-22T08:00:00.000Z", { type: "quiz", targetId: ids.nodeId, costUsd: 3 }),
      turn(3, "2026-11-22T09:30:00.000Z", { type: "video", targetId: `${ids.jobId}-2`, model: "opus", effort: "high", durationMs: 600_000, toolCalls: 41, outcome: "stopped" }),
      turn(4, "2026-11-22T09:40:00.000Z", { type: "video-review", targetId: ids.jobId }),
      turn(5, "2026-11-22T09:50:00.000Z", { type: "chat", targetId: ids.otherChat }),
    ]);
    const body = await w.get(`?dayStart=${DAY}`);
    expect(body.connector).toBe("ready");
    expect(body.making).toEqual([
      {
        jobId: w.job.id,
        shape: "video",
        title: "The spindle",
        project: { id: w.project.id, title: "Cell biology" },
        open: { projectId: w.project.id, planId: w.plan.id },
        status: "running",
        step: "Drawing scene 3 of 7",
        progress: 0.3,
        since: "2026-11-22T09:00:00.000Z",
        seconds: expect.any(Number),
        maker: { agent: "claude", model: "opus", effort: "high" },
      },
    ]);
    // Another owner's chat is left out; the rest come newest first.
    expect(body.turns.map((t: { turnId: string }) => t.turnId)).toEqual(["t4", "t3", "t2", "t1"]);
    expect(body.turns[1]).toEqual({
      turnId: "t3",
      at: "2026-11-22T09:30:00.000Z",
      shape: "video",
      title: "The spindle",
      project: { id: w.project.id, title: "Cell biology" },
      open: { projectId: w.project.id, planId: w.plan.id },
      agent: "claude",
      agentLabel: "Claude Code",
      model: "opus",
      effort: "high",
      seconds: 600,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 1000,
      toolCalls: 41,
      outcome: "stopped",
    });
    expect(body.turns[0]).toMatchObject({ shape: "video", review: true, title: "The spindle" });
    expect(body.turns[2]).toMatchObject({ shape: "quiz", title: "Check the phases", open: { projectId: w.project.id, planId: w.plan.id } });
    expect(body.turns[3]).toMatchObject({ shape: "chat", title: "Mitosis questions", open: { projectId: w.project.id, chatId: w.chat.id } });
    expect(JSON.stringify(body)).not.toMatch(/cost|usd/i);
    // Today is the 22nd: three turns; the week has the 21st's too.
    expect(body.totals.today).toEqual({ turns: 3, seconds: 608, inputTokens: 300, outputTokens: 30, cacheReadTokens: 3000, cacheWriteTokens: 0 });
    expect(body.totals.week.turns).toBe(4);
    expect(body.shapes).toEqual([{ id: "chat", label: "chat" }, { id: "quiz", label: "quiz" }, { id: "video", label: "video" }]);
    expect(body.projects).toEqual([{ id: w.project.id, title: "Cell biology" }]);
  });

  it("filters by shape and by project, totals included, and pages with a cursor", async () => {
    const w = await world((ids) => Array.from({ length: 7 }, (_, i) => turn(i + 1, `2026-11-22T0${i}:00:00.000Z`, i % 2 ? { type: "chat", targetId: ids.chatId } : { type: "quiz", targetId: ids.nodeId })));
    const quizzes = await w.get(`?shape=quiz&limit=2&dayStart=${DAY}`);
    expect(quizzes.turns.map((t: { turnId: string }) => t.turnId)).toEqual(["t7", "t5"]);
    expect(quizzes.totals.today.turns).toBe(4);
    expect(quizzes.making).toEqual([]);
    const next = await w.get(`?shape=quiz&limit=2&cursor=${quizzes.nextCursor}&dayStart=${DAY}`);
    expect(next.turns.map((t: { turnId: string }) => t.turnId)).toEqual(["t3", "t1"]);
    expect(next.nextCursor).toBeUndefined();
    const elsewhere = await w.get("?project=nothing-here");
    expect(elsewhere.turns).toEqual([]);
    expect(elsewhere.making).toEqual([]);
    // The lists to filter by are never narrowed by the filter itself.
    expect(elsewhere.projects).toEqual([{ id: w.project.id, title: "Cell biology" }]);
    const ofProject = await w.get(`?project=${w.project.id}&limit=200`);
    expect(ofProject.turns).toHaveLength(7);
    expect(ofProject.making).toHaveLength(1);
  });

  it("keeps a turn whose target is gone, without a link", async () => {
    const w = await world(() => [turn(1, "2026-11-22T08:00:00.000Z", { type: "flashcards", targetId: "deleted-node" }), turn(2, "2026-11-22T08:10:00.000Z")]);
    const body = await w.get();
    expect(body.turns).toHaveLength(2);
    expect(body.turns[1]).toMatchObject({ shape: "flashcards" });
    expect(body.turns[1].open).toBeUndefined();
    expect(body.turns[0].shape).toBeUndefined();
  });

  it("says plainly when the connector is not set up, cannot be reached, or keeps no log, and still lists what is being made", async () => {
    const none = await world(() => [], { noAgent: true });
    const plain = await none.get();
    expect(plain).toMatchObject({ connector: "notSetUp", turns: [] });
    expect(plain.making).toHaveLength(1);
    expect(plain.totals).toBeUndefined();

    const down = await world(() => [], { down: true });
    const unreachable = await handleRequest(authed("/v1/activity"), down.engine.deps);
    expect(unreachable.status).toBe(200);
    expect(await bodyOf(unreachable)).toMatchObject({ connector: "unreachable", turns: [] });

    const off = await world(() => [], { off: true });
    expect(await off.get()).toMatchObject({ connector: "ready", log: "off", turns: [], totals: { today: { turns: 0 } } });
  });

  it("refuses a query it cannot read", async () => {
    const w = await world(() => []);
    for (const bad of ["limit=0", "limit=201", "cursor=abc", "shape=a%20b", "dayStart=yesterday"]) {
      const response = await handleRequest(authed(`/v1/activity?${bad}`), w.engine.deps);
      expect(response.status, bad).toBe(400);
      expect((await bodyOf(response)).error).toBe("invalid_request");
    }
  });
});
