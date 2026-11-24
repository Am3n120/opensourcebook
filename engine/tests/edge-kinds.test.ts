import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { EdgeKindRegistry, createDefaultEdgeKinds } from "../src/studio/edge-kinds";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

describe("GET /v1/edge-kinds", () => {
  it("lists the kinds of link the plan runner reads, in words", async () => {
    const engine = createTestEngine({ registry: new FormatRegistry() });
    const response = await handleRequest(authed("/v1/edge-kinds"), engine.deps);
    expect(response.status).toBe(200);
    const { edgeKinds } = await bodyOf(response);
    expect(edgeKinds.map((kind: { id: string }) => kind.id)).toEqual(["assumes", "fix_of"]);
    for (const kind of edgeKinds) {
      expect(Object.keys(kind).sort()).toEqual(["about", "id", "label"]);
      expect(kind.label.charAt(0)).toBe(kind.label.charAt(0).toUpperCase());
      expect(kind.about).not.toContain("\n");
    }
  });

  it("serves the runner's own registry, so a kind registered there shows up", async () => {
    const engine = createTestEngine({ registry: new FormatRegistry() });
    const edgeKinds = createDefaultEdgeKinds().register({ id: "recapOf", label: "Recaps", about: "Goes over the earlier item again, shorter.", reads: "assumes" });
    engine.deps.plans = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry: new FormatRegistry(), schedule: async () => {}, edgeKinds });
    const body = await bodyOf(await handleRequest(authed("/v1/edge-kinds"), engine.deps));
    expect(body.edgeKinds.at(-1)).toEqual({ id: "recapOf", label: "Recaps", about: "Goes over the earlier item again, shorter." });
  });

  it("needs the client token", async () => {
    const engine = createTestEngine({ registry: new FormatRegistry() });
    expect((await handleRequest(new Request("https://engine.test/v1/edge-kinds"), engine.deps)).status).toBe(401);
  });
});

describe("edge kind registry", () => {
  it("reads a kind nobody registered as an input, and refuses a bad or repeated one", () => {
    const kinds = createDefaultEdgeKinds();
    expect(kinds.reads("assumes")).toBe("assumes");
    expect(kinds.reads("fix_of")).toBe("input");
    expect(kinds.reads("practiceFor")).toBe("input");
    expect(() => kinds.register({ id: "fix_of", label: "Again", about: "Again.", reads: "input" })).toThrow();
    expect(() => new EdgeKindRegistry().register({ id: "Bad Kind", label: "Bad", about: "Bad.", reads: "input" })).toThrow();
    expect(() => new EdgeKindRegistry().register({ id: "quiet", label: " ", about: "No label.", reads: "input" })).toThrow();
  });
});
