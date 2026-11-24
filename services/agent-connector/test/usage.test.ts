/**
 * `GET /usage`: the usage log read back newest first, paged by line, with no cost, behind the connector's token, and
 * calm about a log that is not there yet or has a line that is not a turn.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AgentRegistry } from "../src/agents/registry.ts";
import { createConnector } from "../src/server.ts";
import { appendUsageLog, readUsageLog, type UsageLogEntry } from "../src/usage-log.ts";

const TOKEN = "connector-token-0123456789";
const SCENES = "scenes-token-0123456789";

function entry(n: number, over: Partial<UsageLogEntry> = {}): UsageLogEntry {
  return {
    time: new Date(Date.UTC(2026, 10, 22, 12, 0, n)).toISOString(),
    type: "quiz",
    targetId: `n${n}`,
    turnId: `t${n}`,
    agent: "claude",
    model: "haiku",
    effort: null,
    inputTokens: 10 * n,
    outputTokens: n,
    cacheReadTokens: 100,
    cacheWriteTokens: null,
    costUsd: 0.25,
    durationMs: 1000 * n,
    toolCalls: n,
    outcome: "done",
    ...over,
  };
}

function logWith(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-usage-"));
  const path = join(dir, "logs", "usage.jsonl");
  for (let n = 1; n <= count; n++) appendUsageLog(path, entry(n));
  return path;
}

async function serve(usageLog?: string): Promise<{ get: (path: string, token?: string) => Promise<Response>; server: Server }> {
  const { server } = createConnector({ token: TOKEN, scenes: { token: SCENES, roots: [] }, agents: new AgentRegistry(), defaults: {}, log: () => undefined, ...(usageLog ? { usageLog } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, get: (path, token = TOKEN) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } }) };
}

test("serves the newest turns first, every field but the cost, leaving out what was not reported", async () => {
  const { get, server } = await serve(logWith(3));
  try {
    const response = await get("/usage");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { turns: Array<Record<string, unknown>>; next?: number };
    assert.deepEqual(body.turns.map((turn) => turn.turnId), ["t3", "t2", "t1"]);
    assert.equal(body.next, undefined);
    assert.deepEqual(body.turns[0], { line: 3, time: entry(3).time, turnId: "t3", agent: "claude", type: "quiz", targetId: "n3", model: "haiku", inputTokens: 30, outputTokens: 3, cacheReadTokens: 100, durationMs: 3000, toolCalls: 3, outcome: "done" });
    for (const turn of body.turns) assert.equal("costUsd" in turn, false);
  } finally {
    server.close();
  }
});

test("pages back by line with limit and before", async () => {
  const { get, server } = await serve(logWith(5));
  try {
    const first = (await (await get("/usage?limit=2")).json()) as { turns: Array<{ turnId: string }>; next?: number };
    assert.deepEqual(first.turns.map((turn) => turn.turnId), ["t5", "t4"]);
    assert.equal(first.next, 4);
    const second = (await (await get(`/usage?limit=2&before=${first.next}`)).json()) as { turns: Array<{ turnId: string }>; next?: number };
    assert.deepEqual(second.turns.map((turn) => turn.turnId), ["t3", "t2"]);
    const last = (await (await get(`/usage?limit=2&before=${second.next}`)).json()) as { turns: Array<{ turnId: string }>; next?: number };
    assert.deepEqual(last.turns.map((turn) => turn.turnId), ["t1"]);
    assert.equal(last.next, undefined);
    for (const bad of ["limit=0", "limit=501", "limit=x", "before=0", "before=-1"]) assert.equal((await get(`/usage?${bad}`)).status, 400, bad);
  } finally {
    server.close();
  }
});

test("a missing log has no turns, a log that is off says so, and a bad line is passed over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-usage-"));
  const missing = await serve(join(dir, "nothing", "usage.jsonl"));
  try {
    assert.deepEqual(await (await missing.get("/usage")).json(), { turns: [] });
  } finally {
    missing.server.close();
  }
  const off = await serve();
  try {
    assert.deepEqual(await (await off.get("/usage")).json(), { turns: [], off: true });
  } finally {
    off.server.close();
  }
  const path = join(dir, "mixed.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry(1))}\nnot json\n[1,2]\n{"time":"never","turnId":"x","agent":"a"}\n{"turnId":"t9"}\n`);
  appendFileSync(path, `${JSON.stringify(entry(2, { outcome: "stopped", inputTokens: null, durationMs: -5 }))}\n{"time":"2026-11-22T12:00:09`);
  const read = await readUsageLog(path);
  assert.deepEqual(read.turns.map((turn) => [turn.turnId, turn.line, turn.outcome, turn.inputTokens, turn.durationMs]), [["t2", 6, "stopped", undefined, 0], ["t1", 1, "done", 10, 1000]]);
  assert.equal(read.next, undefined);
  // A page that ends on bad lines with a good one before them still offers the next page.
  const page = await readUsageLog(path, { limit: 1 });
  assert.deepEqual([page.turns[0]?.turnId, page.next], ["t2", 6]);
});

test("needs the connector's own token; the scenes service's narrower token may not read it", async () => {
  const { get, server } = await serve(logWith(1));
  try {
    assert.equal((await get("/usage", "wrong-token-0123456789")).status, 401);
    assert.equal((await get("/usage", SCENES)).status, 403);
  } finally {
    server.close();
  }
});
