/** The make-times table and its repository: one row per job, the middle of the newest runs, the exact key only. */
import { describe, expect, it } from "vitest";
import { createStudioRepositories } from "../src/studio/repositories";
import { TIME_RUNS, median } from "../src/studio/repositories/make-times";
import { handleRequest } from "../src/index";
import { ownerIdForToken } from "../src/http";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { createSqliteD1 } from "./support/sqlite-d1";
import { madeInFrom } from "../src/wiring";

function setup() {
  let n = 0;
  const repos = createStudioRepositories(createSqliteD1(), { now: () => new Date(Date.UTC(2026, 10, 22, 12, 0, n++)).toISOString() });
  return repos.makeTimes;
}

const base = { ownerId: "owner", scope: "video", agent: "claude", model: "opus", effort: "high", bucket: "le4" } as const;

describe("make times", () => {
  it("says nothing for a key that has no run", async () => {
    const times = setup();
    expect(await times.summary("owner")).toEqual([]);
    await times.record({ ...base, seconds: 100, jobId: "j1" });
    expect(await times.summary("owner", "quiz")).toEqual([]);
  });

  it("records one row per job", async () => {
    const times = setup();
    expect(await times.record({ ...base, seconds: 100, jobId: "j1" })).toBe(true);
    expect(await times.record({ ...base, seconds: 999, jobId: "j1" })).toBe(false);
    const [only] = await times.summary("owner");
    expect(only).toMatchObject({ runs: 1, seconds: 100 });
  });

  it("refuses seconds that are not a time", async () => {
    const times = setup();
    for (const seconds of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(await times.record({ ...base, seconds, jobId: `j${seconds}` })).toBe(false);
    expect(await times.summary("owner")).toEqual([]);
  });

  it("is the middle of the runs, with the even case between the two", async () => {
    const times = setup();
    for (const [i, seconds] of [30, 10, 20].entries()) await times.record({ ...base, seconds, jobId: `j${i}` });
    expect((await times.summary("owner"))[0]).toMatchObject({ runs: 3, seconds: 20 });
    await times.record({ ...base, seconds: 40, jobId: "j9" });
    expect((await times.summary("owner"))[0]).toMatchObject({ runs: 4, seconds: 25 });
    expect(median([5])).toBe(5);
  });

  it("uses only the newest runs", async () => {
    const times = setup();
    await times.record({ ...base, seconds: 1000, jobId: "old" });
    for (let i = 0; i < TIME_RUNS; i++) await times.record({ ...base, seconds: 10, jobId: `new${i}` });
    const [only] = await times.summary("owner");
    expect(only).toMatchObject({ runs: TIME_RUNS, seconds: 10 });
  });

  it("keeps every key apart: no run counts for another model, effort, agent, length or owner", async () => {
    const times = setup();
    await times.record({ ...base, seconds: 100, jobId: "a" });
    await times.record({ ...base, model: "sonnet", seconds: 50, jobId: "b" });
    await times.record({ ...base, effort: "low", seconds: 40, jobId: "c" });
    await times.record({ ...base, agent: "codex", seconds: 30, jobId: "d" });
    await times.record({ ...base, bucket: "gt20", seconds: 900, jobId: "e" });
    await times.record({ ...base, ownerId: "other", seconds: 5, jobId: "f" });
    const rows = await times.summary("owner", "video");
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.runs === 1)).toBe(true);
    expect(rows.find((row) => row.model === "opus" && row.effort === "high" && row.agent === "claude" && row.bucket === "le4")?.seconds).toBe(100);
  });

  it("leaves out what a pick or a shape does not have, never null", async () => {
    const times = setup();
    await times.record({ ownerId: "owner", scope: "chat", agent: "claude", seconds: 7, jobId: "t1" });
    const [row] = await times.summary("owner", "chat");
    expect(row).toEqual({ scope: "chat", agent: "claude", runs: 1, seconds: 7, lastAt: row!.lastAt });
  });
});

describe("GET /v1/make-times", () => {
  it("needs the client token", async () => {
    const engine = createTestEngine();
    const response = await handleRequest(new Request("https://engine.test/v1/make-times"), engine.deps);
    expect(response.status).toBe(401);
  });

  it("lists only runs of this computer's owner, and with no run answers an empty list, never a guess", async () => {
    const engine = createTestEngine();
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    expect(await bodyOf(await handleRequest(authed("/v1/make-times"), engine.deps))).toEqual({ times: [] });
    await engine.deps.repos.makeTimes.record({ ownerId: owner, scope: "video", agent: "claude", model: "opus", bucket: "le4", seconds: 90, jobId: "j1" });
    await engine.deps.repos.makeTimes.record({ ownerId: "someone-else", scope: "video", agent: "claude", model: "opus", bucket: "le4", seconds: 5, jobId: "j2" });
    const body = await bodyOf(await handleRequest(authed("/v1/make-times"), engine.deps));
    expect(body.times).toEqual([{ scope: "video", agent: "claude", model: "opus", bucket: "le4", runs: 1, seconds: 90, lastAt: expect.any(String) }]);
  });

  it("narrows to one scope and refuses a scope that cannot be one", async () => {
    const engine = createTestEngine();
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    const { makeTimes } = engine.deps.repos;
    await makeTimes.record({ ownerId: owner, scope: "video", agent: "claude", seconds: 90, jobId: "j1" });
    await makeTimes.record({ ownerId: owner, scope: "chat", agent: "claude", seconds: 8, jobId: "j2" });
    const chat = await bodyOf(await handleRequest(authed("/v1/make-times?scope=chat"), engine.deps));
    expect(chat.times.map((time: { scope: string }) => time.scope)).toEqual(["chat"]);
    const bad = await handleRequest(authed("/v1/make-times?scope=a%20b"), engine.deps);
    expect(bad.status).toBe(400);
    expect((await bodyOf(bad)).error).toBe("invalid_request");
  });
});

describe("the video maker's expected end", () => {
  it("comes from past runs with the exact pick and length, and is absent otherwise", async () => {
    let n = 0;
    const repos = createStudioRepositories(createSqliteD1(), { now: () => new Date(Date.UTC(2026, 10, 22, 12, 0, n++)).toISOString() });
    const shape = { timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] } };
    const madeIn = madeInFrom(repos, "video", () => shape);
    await repos.makeTimes.record({ ...base, seconds: 300, jobId: "j1" });
    await repos.makeTimes.record({ ...base, seconds: 500, jobId: "j2" });
    const pick = { agent: "claude", model: "opus", effort: "high" };
    const minutes = (value: number) => ({ minutes: value, aspect: "portrait" }) as never;
    expect(await madeIn(pick, minutes(3), "owner")).toBe(400);
    // Another length, model, effort, agent or owner has no time.
    expect(await madeIn(pick, minutes(10), "owner")).toBeUndefined();
    expect(await madeIn({ ...pick, model: "sonnet" }, minutes(3), "owner")).toBeUndefined();
    expect(await madeIn({ agent: "claude", model: "opus" }, minutes(3), "owner")).toBeUndefined();
    expect(await madeIn({ ...pick, agent: "codex" }, minutes(3), "owner")).toBeUndefined();
    expect(await madeIn(pick, minutes(3), "someone-else")).toBeUndefined();
    expect(await madeIn(pick, minutes(3))).toBeUndefined();
  });
});
