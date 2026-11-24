import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { isFree, pickPorts } from "../ports.ts";

test("each program keeps its usual port when it is free", async () => {
  const ports = await pickPorts([{ name: "a", port: 5000 }, { name: "b", port: 6000 }], async () => true);
  assert.deepEqual(ports, { a: 5000, b: 6000 });
});

test("a taken port moves to the next free one, and two programs never share one", async () => {
  const taken = new Set([5000, 5001]);
  const ports = await pickPorts([{ name: "a", port: 5000 }, { name: "b", port: 5002 }, { name: "c", port: 5002 }], async (p) => !taken.has(p));
  assert.deepEqual(ports, { a: 5002, b: 5003, c: 5004 });
});

test("no free port within 100 is a plain error", async () => {
  await assert.rejects(pickPorts([{ name: "engine", port: 5000 }], async () => false), /No free port for engine between 5000 and 5100/);
});

test("a port something listens on is seen as taken, for real", async () => {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await isFree(port), false);
    const ports = await pickPorts([{ name: "x", port }]);
    assert.notEqual(ports.x, port);
    assert.equal(await isFree(ports.x!), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await isFree(port), true);
});
