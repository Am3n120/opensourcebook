import type { Item, PlanView } from "../api/types";
import { fakeEngine, itemStopRoutes, redesignRoutes, sampleMakeTimes } from "./fakeEngine";

test("the redesign's sample routes answer through the client", async () => {
  const { client } = fakeEngine(redesignRoutes);
  expect((await client.formats()).some((f) => f.timing && f.voiced)).toBe(true);
  expect((await client.providers()).providers.map((p) => p.label)).toEqual(["Zeta Agent", "Alpha Code"]);
  expect(await client.makeTimes("chat")).toEqual(sampleMakeTimes.filter((t) => t.scope === "chat"));
  expect((await client.putProviderPicks({ chat: { agent: "alpha" } })).picks.chat).toEqual({ agent: "alpha" });
  expect((await client.voice()).services[0]?.keyHint).toBe("a1b2");
  expect((await client.setVoiceKey("hosted-a", "k")).keySet).toBe(true);
  expect((await client.voiceOptions("hosted-a")).length).toBeGreaterThan(0);
  expect((await client.setSetup(true)).done).toBe(true);
  expect((await client.uploadTypes()).types.map((t) => t.group)).toContain("PDF");
  expect((await client.closeProposal("c1", "m1", 0)).message.id).toBe("m1");
});

test("the sample routes answer in the engine's own shapes", async () => {
  const { client } = fakeEngine(redesignRoutes);
  // File endings come without the dot, as the engine lists them.
  expect((await client.uploadTypes()).types.flatMap((t) => t.extensions).every((e) => !e.startsWith("."))).toBe(true);
  // Choosing a voice answers the setup with that voice's id and label.
  expect((await client.setVoice({ service: "hosted-a", voice: "v2" })).voice).toEqual({ id: "v2", label: "Bright" });
  expect((await client.setVoice({ service: null })).service).toBeUndefined();
});

test("stopping one item of a running plan answers the plan view with only that item stopped, and retry lets it go on", async () => {
  const item = (id: string, status: Item["status"]): Item => ({ id, level: 1, ord: 0, type: "quiz", title: id, settings: {}, enabled: true, status, sources: [], done: false });
  const plan: PlanView = { plan: { id: "p1", projectId: "pr1", status: "running", version: 1, createdAt: "", updatedAt: "" }, stages: [], items: [item("a", "running"), item("b", "pending"), item("c", "done")], edges: [], counts: { total: 3, done: 0 }, estimateUsd: 0, issues: [] };
  const { client } = fakeEngine(itemStopRoutes(plan));
  const stopped = await client.stopItem("p1", "a");
  expect(stopped.plan.status).toBe("running");
  expect(stopped.items.map((i) => i.status)).toEqual(["cancelled", "pending", "done"]);
  // Only an item being made stops: a pending or done one is refused, as the engine refuses it.
  await expect(client.stopItem("p1", "c")).rejects.toMatchObject({ status: 409, code: "item_not_running" });
  await expect(client.stopItem("p1", "b")).rejects.toMatchObject({ status: 409, code: "item_not_running" });
  // Go on is retry: queued again, the plan running.
  const again = await client.retryItem("p1", "a");
  expect(again.items[0]?.status).toBe("queued");
  expect(again.plan.status).toBe("running");
});

test("stopping the last item being made stops the plan", async () => {
  const item = (id: string, status: Item["status"]): Item => ({ id, level: 1, ord: 0, type: "quiz", title: id, settings: {}, enabled: true, status, sources: [], done: false });
  const plan: PlanView = { plan: { id: "p1", projectId: "pr1", status: "running", version: 1, createdAt: "", updatedAt: "" }, stages: [], items: [item("a", "running"), item("c", "done")], edges: [], counts: { total: 2, done: 1 }, estimateUsd: 0, issues: [] };
  const { client } = fakeEngine(itemStopRoutes(plan));
  const stopped = await client.stopItem("p1", "a");
  expect(stopped.plan.status).toBe("cancelled");
  expect(stopped.items[0]?.status).toBe("cancelled");
});
