import { describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import { nullUsageSink } from "../src/providers/usage";
import { FormatRegistry, UnknownFormatError, runEngine } from "../src/studio/registry";
import type {
  EngineContext,
  EngineOutput,
  FormatDefinition,
  FormatDescriptor,
  OutputEngine,
  ValidationReport,
} from "../src/studio/types";
import { isFormatId } from "../src/studio/types";
import { agentField, reviewerField } from "../src/engines/agent-fields";
import { createDefaultRegistry } from "../src/studio/default-registry";

type Settings = { count: number };
type Blueprint = { outline: string[] };
type Payload = { lines: string[] };

const valid: ValidationReport = { valid: true, issues: [] };
const invalid: ValidationReport = {
  valid: false,
  issues: [{ path: "lines", code: "empty", message: "no lines", severity: "error" }],
};

/** An engine whose output becomes valid after `repairsNeeded` repairs. */
function scriptedEngine(repairsNeeded: number, calls: string[]): OutputEngine<Settings, Blueprint, Payload> {
  let repairs = 0;
  const output = (): EngineOutput<Payload> => ({
    title: "t",
    summary: "s",
    payload: { lines: Array(repairs).fill("x") },
    citations: [],
  });
  return {
    type: "byte",
    schemaVersion: 1,
    async plan() {
      calls.push("plan");
      return { outline: ["a"] };
    },
    async generate() {
      calls.push("generate");
      return output();
    },
    async validate(_ctx, _output, blueprint) {
      calls.push(`validate:${blueprint.outline.join(",")}`);
      return repairs >= repairsNeeded ? valid : invalid;
    },
    async repair(_ctx, _output, _report, blueprint) {
      calls.push(`repair:${blueprint.outline.join(",")}`);
      repairs += 1;
      return output();
    },
  };
}

function definition(engine: OutputEngine<Settings, Blueprint, Payload>, maxRepairRounds = 2) {
  const def: FormatDefinition<Settings, Blueprint, Payload> = {
    descriptor: { ...descriptor("byte"), label: "Bits", defaults: { count: 1 } },
    engine,
    maxRepairRounds,
    parseSettings: () => ({ ok: true, settings: { count: 1 } }),
    estimateCost: () => ({ usd: 0, basis: "test" }),
  };
  return def;
}

function descriptor(id: string, extra: Partial<FormatDescriptor> = {}): FormatDescriptor {
  return { id, label: id, colorSlot: 1, icon: "test", settings: [], defaults: {}, ...extra };
}

function context(signal?: AbortSignal): EngineContext<Settings> {
  return {
    jobId: "job-1",
    node: { id: "n1", type: "byte", title: "Node", prompt: "", settings: { count: 1 } },
    sources: [],
    assumes: [],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async () => ({}) as never },
      assets: createNullAssetStore(),
      usage: nullUsageSink,
      fetch: async () => new Response(null, { status: 204 }),
      now: () => "2026-11-10T00:00:00.000Z",
      signal,
      progress: () => undefined,
    },
  };
}

describe("FormatRegistry", () => {
  it("returns what was registered, in order", () => {
    const registry = new FormatRegistry().register(definition(scriptedEngine(0, [])));
    expect(registry.ready()).toEqual(["byte"]);
    expect(registry.has("byte")).toBe(true);
    expect(registry.require("byte").descriptor.label).toBe("Bits");
  });

  it("refuses a second format with the same id", () => {
    const registry = new FormatRegistry().register(definition(scriptedEngine(0, [])));
    expect(() => registry.register(definition(scriptedEngine(0, [])))).toThrow(/already taken/);
    expect(() => registry.declare(descriptor("byte"))).toThrow(/already taken/);
  });

  it("refuses an engine built for another format", () => {
    const base = definition(scriptedEngine(0, []));
    const def = { ...base, descriptor: { ...base.descriptor, id: "read" } };
    expect(() => new FormatRegistry().register(def)).toThrow(/engine for "byte"/);
  });

  it("refuses defaults its own parser rejects", () => {
    const def = { ...definition(scriptedEngine(0, [])), parseSettings: () => ({ ok: false as const, issues: [] }) };
    expect(() => new FormatRegistry().register(def)).toThrow(/defaults do not parse/);
  });

  it("refuses bad ids, taken aliases and colour slots off the palette", () => {
    expect(() => new FormatRegistry().declare(descriptor("Bad id"))).toThrow(/not a valid format id/);
    expect(() => new FormatRegistry().declare(descriptor("x", { aliases: ["x"] }))).toThrow(/repeats an id/);
    expect(() => new FormatRegistry().declare(descriptor("x")).declare(descriptor("y", { aliases: ["x"] }))).toThrow(/already taken/);
    expect(() => new FormatRegistry().declare(descriptor("x", { colorSlot: 0 }))).toThrow(/colorSlot/);
    expect(() => new FormatRegistry().declare(descriptor("x", { colorSlot: 9 }))).toThrow(/colorSlot/);
  });

  it("refuses a setting whose options are not distinct codes, each with a label and a description", () => {
    const pick = (options: Array<{ value: string; label: string; description: string }>, kind: "choice" | "choices" = "choice") =>
      descriptor("x", { settings: [{ key: "pace", label: "Pace", kind, options }] });
    const slow = { value: "slow", label: "slow", description: "One idea at a time." };
    expect(() => new FormatRegistry().declare(pick([slow, { value: "fast", label: "fast", description: "" }]))).toThrow(/label and a description/);
    expect(() => new FormatRegistry().declare(pick([slow, { value: "fast", label: " ", description: "Quick." }], "choices"))).toThrow(/label and a description/);
    expect(() => new FormatRegistry().declare(pick([slow, slow]))).toThrow(/distinct values/);
    expect(() => new FormatRegistry().declare(pick([], "choices"))).toThrow(/distinct values/);
    expect(() => new FormatRegistry().declare(pick([slow, { value: "fast", label: "fast", description: "Quick." }], "choices"))).not.toThrow();
  });

  it("takes one maker's agent field and one reviewer field at most", () => {
    expect(() => new FormatRegistry().declare(descriptor("x", { settings: [agentField("chat"), { ...agentField("work"), key: "other" }] }))).toThrow(/role "make"/);
    expect(() => new FormatRegistry().declare(descriptor("x", { settings: [reviewerField(), { ...reviewerField(), key: "other" }] }))).toThrow(/role "review"/);
    expect(() => new FormatRegistry().declare(descriptor("x", { settings: [agentField("chat"), reviewerField()] }))).not.toThrow();
  });

  it("every registered format with an agent maker has exactly one maker's agent field", () => {
    const registry = createDefaultRegistry({});
    for (const view of registry.views()) {
      const makes = view.settings.filter((field) => field.kind === "agent" && field.role !== "review");
      expect(makes.length).toBeLessThanOrEqual(1);
    }
  });

  it("knows a declared format, but has no engine for it", () => {
    const registry = new FormatRegistry().declare(descriptor("video"));
    expect(registry.has("video")).toBe(true);
    expect(registry.descriptor("video")?.label).toBe("video");
    expect(registry.get("video")).toBeUndefined();
    expect(() => registry.require("video")).toThrow(UnknownFormatError);
    expect(registry.ready()).toEqual([]);
  });

  it("resolves aliases to the format they stand for", () => {
    const registry = new FormatRegistry()
      .register({ ...definition(scriptedEngine(0, [])), descriptor: { ...descriptor("byte", { aliases: ["read"] }), defaults: { count: 1 } } })
      .declare(descriptor("quiz", { aliases: ["check"] }));
    expect(registry.resolve("check")).toBe("quiz");
    expect(registry.descriptor("check")?.id).toBe("quiz");
    expect(registry.require("read").descriptor.id).toBe("byte");
    expect(registry.resolve("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("lists every format for clients, marking which can be made now", () => {
    const registry = new FormatRegistry().register(definition(scriptedEngine(0, []))).declare(descriptor("video"));
    expect(registry.views().map((view) => [view.id, view.ready])).toEqual([
      ["byte", true],
      ["video", false],
    ]);
  });

  it("fails loudly on a format nobody registered", () => {
    const registry = new FormatRegistry();
    expect(registry.get("video")).toBeUndefined();
    expect(() => registry.require("video")).toThrow(UnknownFormatError);
  });

  it("takes any camelCase id, not a fixed list", () => {
    expect(isFormatId("workedExample")).toBe(true);
    expect(isFormatId("somethingNew2")).toBe(true);
    expect(isFormatId("")).toBe(false);
    expect(isFormatId("Byte")).toBe(false);
    expect(isFormatId("two words")).toBe(false);
    expect(isFormatId(7)).toBe(false);
  });
});

describe("runEngine", () => {
  it("skips repair when the first output is valid", async () => {
    const calls: string[] = [];
    const result = await runEngine(definition(scriptedEngine(0, calls)), context());
    expect(calls).toEqual(["plan", "generate", "validate:a"]);
    expect(result.repairRounds).toBe(0);
    expect(result.report.valid).toBe(true);
  });

  it("repairs until valid", async () => {
    const calls: string[] = [];
    const result = await runEngine(definition(scriptedEngine(2, calls)), context());
    expect(calls).toEqual(["plan", "generate", "validate:a", "repair:a", "validate:a", "repair:a", "validate:a"]);
    expect(result.repairRounds).toBe(2);
    expect(result.output.payload.lines).toHaveLength(2);
  });

  it("produces once, after validation passes, and never for an output that stays invalid", async () => {
    const calls: string[] = [];
    const withProduce = (engine: OutputEngine<Settings, Blueprint, Payload>) => ({
      ...engine,
      type: engine.type,
      schemaVersion: engine.schemaVersion,
      plan: engine.plan.bind(engine),
      generate: engine.generate.bind(engine),
      validate: engine.validate.bind(engine),
      repair: engine.repair.bind(engine),
      produce: async (_ctx: EngineContext<Settings>, output: EngineOutput<Payload>) => {
        calls.push("produce");
        return { ...output, title: "produced" };
      },
    });
    const made = await runEngine(definition(withProduce(scriptedEngine(1, calls))), context());
    expect(calls).toEqual(["plan", "generate", "validate:a", "repair:a", "validate:a", "produce"]);
    expect(made.output.title).toBe("produced");

    calls.length = 0;
    const failed = await runEngine(definition(withProduce(scriptedEngine(5, calls)), 1), context());
    expect(failed.report.valid).toBe(false);
    expect(calls).not.toContain("produce");
  });

  it("stops at maxRepairRounds and returns the failing report", async () => {
    const result = await runEngine(definition(scriptedEngine(5, []), 1), context());
    expect(result.repairRounds).toBe(1);
    expect(result.report.valid).toBe(false);
  });

  it("reuses a saved blueprint instead of planning again, and hands it to every step", async () => {
    const calls: string[] = [];
    await runEngine(definition(scriptedEngine(1, calls)), context(), { blueprint: { outline: ["saved"] } });
    expect(calls).toEqual(["generate", "validate:saved", "repair:saved", "validate:saved"]);
  });

  it("hands a fresh blueprint to the caller for saving", async () => {
    const saved: Blueprint[] = [];
    await runEngine(definition(scriptedEngine(0, [])), context(), { onBlueprint: (b) => void saved.push(b) });
    expect(saved).toEqual([{ outline: ["a"] }]);
  });

  it("does not start work on a cancelled job", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(runEngine(definition(scriptedEngine(0, calls)), context(controller.signal))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("what formats say for times and the voice", () => {
  it("video and audio keep times apart by length in minutes and are voiced; the others are neither", async () => {
    const { audioDescriptor } = await import("../src/engines/audio/definition");
    const { videoDescriptor } = await import("../src/engines/video/definition");
    const { guideDescriptor } = await import("../src/engines/guide/definition");
    for (const descriptor of [audioDescriptor(), videoDescriptor()]) {
      expect(descriptor.timing).toEqual({ setting: "minutes", edges: [2, 4, 7, 12, 20] });
      expect(descriptor.voiced).toBe(true);
      expect(descriptor.settings.some((field) => field.key === descriptor.timing!.setting && field.kind === "number")).toBe(true);
    }
    expect(guideDescriptor().timing).toBeUndefined();
    expect(guideDescriptor().voiced).toBeUndefined();
  });
});
