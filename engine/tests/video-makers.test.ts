/**
 * The registry of video makers behind the one video format: how a maker is
 * picked, that the pick is saved on the job's blueprint, that every step
 * and the repair rounds are the picked maker's, and that a missing maker
 * fails with that said instead of becoming another one.
 */
import { describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { videoDefinitionFor } from "../src/engines/video/definition";
import { OPEN_PICK, VideoMakerRegistry, type VideoMaker } from "../src/engines/video/makers";
import { failureCodeOf, failureWords } from "../src/jobs/failure-words";
import { JobFailure } from "../src/jobs/lifecycle";
import { catalog } from "../src/chat/planning/prompts";
import { createDefaultConditions } from "../src/studio/conditions";
import { unmakeableNodes } from "../src/studio/plan-runner";
import { FormatRegistry, runEngine } from "../src/studio/registry";
import type { PlanNode } from "../src/studio/repositories/plans";
import type { EngineContext } from "../src/studio/types";
import { ASPECTS, VIDEO_SCHEMA_VERSION, type Video } from "../src/video/contract";
import type { VideoSettings } from "../src/engines/video/definition";
import { FakeR2Bucket } from "./support/fake-r2";

interface Log {
  steps: string[];
}

/** A maker that records its steps; invalid until it has repaired `invalidRounds` times. */
function maker(id: string, log: Log, options: { invalidRounds?: number; maxRepairRounds?: number } = {}): VideoMaker<{ by: string }> {
  let repaired = 0;
  const video = (): Video => ({ schemaVersion: VIDEO_SCHEMA_VERSION, title: id, idea: "", aspect: { ...ASPECTS.portrait }, scenes: [] });
  return {
    id,
    label: `Maker ${id}`,
    description: `Makes videos as ${id}.`,
    about: `videos by ${id}`,
    maxRepairRounds: options.maxRepairRounds ?? 1,
    styles: () => [],
    estimateCost: () => ({ usd: 0, basis: id }),
    engine: {
      type: "video",
      schemaVersion: VIDEO_SCHEMA_VERSION,
      async plan(ctx) {
        log.steps.push(`${id}:plan:${ctx.node.settings.maker}`);
        return { by: id };
      },
      async generate(_ctx, blueprint) {
        log.steps.push(`${id}:generate:${blueprint.by}`);
        return { title: id, summary: id, payload: video(), citations: [] };
      },
      async validate() {
        log.steps.push(`${id}:validate`);
        const valid = repaired >= (options.invalidRounds ?? 0);
        return { valid, issues: valid ? [] : [{ path: "$", code: "x", message: "not yet", severity: "error" }] };
      },
      async repair(_ctx, output) {
        repaired += 1;
        log.steps.push(`${id}:repair`);
        return output;
      },
      async produce(_ctx, output) {
        log.steps.push(`${id}:produce`);
        return output;
      },
    },
  };
}

function ctx(settings: VideoSettings): EngineContext<VideoSettings> {
  return {
    jobId: "job-1",
    node: { id: "node-1", type: "video", title: "T", prompt: "", settings },
    sources: [],
    assumes: [],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async <T>() => ({}) as T },
      assets: new AssetStore(new FakeR2Bucket()),
      usage: { record: () => undefined },
      fetch: async () => new Response(null),
      now: () => "2026-11-15T09:00:00.000Z",
      progress: () => undefined,
    },
  };
}

describe("video makers", () => {
  it("refuse a maker with a bad or taken id, or no words for the form", () => {
    const log = { steps: [] };
    const registry = new VideoMakerRegistry().register(maker("one", log));
    expect(() => registry.register(maker("one", log))).toThrow(/already registered/);
    expect(() => registry.register(maker("Two", log))).toThrow(/not a valid/);
    expect(() => registry.register(maker(OPEN_PICK, log))).toThrow(/not a valid/);
    expect(() => registry.register({ ...maker("three", log), label: " " })).toThrow(/label and a description/);
  });

  it("leave the pick to the default maker: the one asked for by id, else the first registered", () => {
    const log = { steps: [] };
    const both = (defaultId?: string) => new VideoMakerRegistry(defaultId).register(maker("one", log)).register(maker("two", log));
    expect(both().default()?.id).toBe("one");
    expect(both("two").default()?.id).toBe("two");
    expect(both("gone").default()?.id).toBe("one");
    expect(both("gone").defaultMissing).toBe("gone");
    expect(both("two").resolve({})).toEqual({ maker: expect.objectContaining({ id: "two" }) });
    expect(both().resolve({ maker: OPEN_PICK })).toEqual({ maker: expect.objectContaining({ id: "one" }) });
    expect(both().resolve({ maker: "two" })).toEqual({ maker: expect.objectContaining({ id: "two" }) });
    expect(both().resolve({ maker: "gone" })).toEqual({ missing: "gone" });
  });

  it("run every step with the picked maker, save the pick, and use its repair rounds", async () => {
    const log: Log = { steps: [] };
    const registry = new VideoMakerRegistry().register(maker("one", log, { maxRepairRounds: 3 })).register(maker("two", log, { invalidRounds: 1, maxRepairRounds: 1 }));
    const definition = videoDefinitionFor(registry);
    expect(definition.maxRepairRounds).toBe(3);
    let saved: unknown;
    const result = await runEngine(definition, ctx({ minutes: 0, aspect: "portrait", maker: "two" }), { onBlueprint: (blueprint) => void (saved = blueprint) });
    expect(result.report.valid).toBe(true);
    expect(saved).toEqual({ maker: "two", made: { by: "two" } });
    expect(log.steps).toEqual(["two:plan:two", "two:generate:two", "two:validate", "two:repair", "two:validate", "two:produce"]);
    expect(definition.repairRoundsFor?.(saved as never)).toBe(1);
  });

  it("make a retry with the maker saved on the job, even after the default changed", async () => {
    const log: Log = { steps: [] };
    const definition = videoDefinitionFor(new VideoMakerRegistry("two").register(maker("one", log)).register(maker("two", log)));
    await runEngine(definition, ctx({ minutes: 0, aspect: "portrait" }), { blueprint: { maker: "one", made: { by: "one" } } });
    expect(log.steps[0]).toBe("one:generate:one");
  });

  it("never give a blueprint saved before makers existed (the storyboard maker's) to another maker: it is planned again", async () => {
    const log: Log = { steps: [] };
    const definition = videoDefinitionFor(new VideoMakerRegistry().register(maker("one", log)));
    expect(definition.keepsBlueprint!({ by: "old" })).toBe(false);
    expect(definition.keepsBlueprint!({ maker: "one", made: {} })).toBe(true);
    const failure = await runEngine(definition, ctx({ minutes: 0, aspect: "portrait" }), { blueprint: { by: "old" } as never }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobFailure);
    expect(log.steps).toEqual([]);
  });

  it("offer no maker or style setting while one maker without styles is set up", () => {
    const descriptor = videoDefinitionFor(new VideoMakerRegistry().register(maker("one", { steps: [] }))).descriptor;
    expect(descriptor.settings.map((field) => field.key)).toEqual(["minutes", "aspect"]);
    expect(descriptor.defaults).toEqual({ minutes: 0, aspect: "portrait" });
  });

  it("build the maker and style settings from the makers, the style shown only for a maker that has styles", () => {
    const log = { steps: [] };
    const styles = [
      { id: "chalk", label: "Chalk", description: "White lines on green.", preview: "/v1/video-makers/two/styles/chalk/preview" },
      { id: "ink", label: "Ink", description: "Black ink on paper." },
    ];
    const two = { ...maker("two", log), styles: () => styles };
    const make = (defaultId?: string) => {
      const registry = new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry(defaultId).register(maker("one", log)).register(two)));
      return registry.descriptor("video")!;
    };
    const descriptor = make();
    const [, , makerField, styleField] = descriptor.settings;
    expect(makerField).toMatchObject({ key: "maker", label: "Maker", kind: "choice" });
    expect(makerField!.kind === "choice" && makerField!.options.map((option) => [option.value, option.label])).toEqual([
      ["auto", "Whichever is ready"],
      ["one", "Maker one"],
      ["two", "Maker two"],
    ]);
    expect(makerField!.kind === "choice" && makerField!.options[0]!.description).toContain("now that is Maker one");
    expect(styleField).toMatchObject({ key: "style", label: "Style", showWhen: { key: "maker", in: ["two"] } });
    expect(styleField!.kind === "choice" && styleField!.options.map((option) => [option.value, option.preview])).toEqual([
      ["auto", undefined],
      ["chalk", "/v1/video-makers/two/styles/chalk/preview"],
      ["ink", undefined],
    ]);
    expect(descriptor.defaults).toEqual({ minutes: 0, aspect: "portrait", maker: "auto", style: "auto" });
    // With the styled maker as the default, leaving the maker to Open Sourcebook shows the style too.
    expect(make("two").settings[3]!.showWhen).toEqual({ key: "maker", in: ["auto", "two"] });
    // The planner is told when a setting is read.
    expect(catalog(new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry().register(maker("one", log)).register(two))), createDefaultConditions())).toContain(
      "style (How the video looks., read only when maker is two)",
    );
  });

  it("refuse a setting shown for another setting it does not have, or a picture that is not a path on this engine", () => {
    const base = videoDefinitionFor(new VideoMakerRegistry().register(maker("one", { steps: [] })));
    const withField = (field: Record<string, unknown>) => ({ ...base, descriptor: { ...base.descriptor, settings: [...base.descriptor.settings, field as never] } });
    expect(() => new FormatRegistry().register(withField({ key: "x", label: "X", kind: "toggle", showWhen: { key: "nope", in: ["a"] } }))).toThrow(/not another of its settings/);
    expect(() => new FormatRegistry().register(withField({ key: "x", label: "X", kind: "toggle", showWhen: { key: "aspect", in: ["round"] } }))).toThrow(/does not offer/);
    expect(() => new FormatRegistry().register(withField({ key: "x", label: "X", kind: "toggle", showWhen: { key: "aspect", in: [] } }))).toThrow(/no values/);
    const picture = (preview: string) => withField({ key: "x", label: "X", kind: "choice", options: [{ value: "a", label: "A", description: "a", preview }] });
    expect(() => new FormatRegistry().register(picture("https://elsewhere.example/a.jpg"))).toThrow(/path on this engine/);
    expect(() => new FormatRegistry().register(picture("/v1/video-makers/one/styles/a/preview"))).not.toThrow();
  });

  it("say before Start when an item's maker is not set up here or cannot make it now", () => {
    const log = { steps: [] };
    const down = { ...maker("two", log), issues: () => ["Maker two is not running on this computer: start it, or pick another maker"] };
    const registry = new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry().register(maker("one", log)).register(down)));
    const node = (id: string, settings: Record<string, unknown>) =>
      ({ id, planId: "p", level: 0, ord: 0, type: "video", title: `Item ${id}`, prompt: "", settings, enabled: true, status: "pending", createdAt: "", updatedAt: "" }) as PlanNode;
    const issues = unmakeableNodes([node("a", {}), node("b", { maker: "two" }), node("c", { maker: "gone" })], registry);
    expect(issues.map((issue) => [issue.code, issue.itemId, issue.message])).toEqual([
      ["cannot_make_now", "b", '"Item b": Maker two is not running on this computer: start it, or pick another maker'],
      ["cannot_make_now", "c", '"Item c": its maker "gone" is not set up here: pick another maker'],
    ]);
    expect(issues[0]!.short).toBe("Maker two is not running on this computer: start it, or pick another maker");
  });

  it("fail a stored item whose maker is not set up here with that said, never as another maker", async () => {
    const log: Log = { steps: [] };
    const definition = videoDefinitionFor(new VideoMakerRegistry().register(maker("one", log)));
    const failure = await runEngine(definition, ctx({ minutes: 0, aspect: "portrait", maker: "gone" })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobFailure);
    expect((failure as JobFailure).retryable).toBe(false);
    expect(failureCodeOf(failure)).toBe("maker_missing");
    expect(failureWords({ state: { failure: "maker_missing" }, attempt: 1, status: "failed" }, "video")).toBe(
      "The maker this video asks for is not set up here. Pick another maker, then try again.",
    );
    const later = await runEngine(definition, ctx({ minutes: 0, aspect: "portrait" }), { blueprint: { maker: "gone", made: {} } }).catch((error: unknown) => error);
    expect(failureCodeOf(later)).toBe("maker_missing");
    expect(log.steps).toEqual([]);
    expect(definition.estimateCost({ settings: { minutes: 0, aspect: "portrait", maker: "gone" }, sourceChars: 10, sourceCount: 1 })).toEqual({
      unpriced: true,
      basis: 'video maker "gone" is not set up here',
    });
  });
});

describe("the video's reviewer", () => {
  const log: Log = { steps: [] };
  const withAgent = (): VideoMakerRegistry => {
    const registry = new VideoMakerRegistry();
    registry.register({ ...maker("drawn", log), usesAgent: true });
    return registry;
  };

  it("is offered beside the maker's agent, and can be off", () => {
    const definition = videoDefinitionFor(withAgent());
    expect(definition.descriptor.settings.filter((field) => field.kind === "agent")).toMatchObject([
      { key: "agent", role: "make" },
      { key: "reviewer", role: "review", offValue: "off", effortKey: "reviewEffort" },
    ]);
    const parsed = definition.parseSettings({ reviewer: "off" });
    expect(parsed.ok && parsed.settings.reviewer).toBe("off");
    expect(definition.parseSettings({ reviewer: "nobody" }).ok).toBe(false);
  });

  it("is not offered when no maker runs the person's agent", () => {
    const registry = new VideoMakerRegistry();
    registry.register(maker("plain", log));
    expect(videoDefinitionFor(registry).descriptor.settings.some((field) => field.key === "reviewer")).toBe(false);
  });

  it("settles from the video's review default, off included, never from the maker's", () => {
    const definition = videoDefinitionFor(withAgent());
    const open = definition.parseSettings({});
    if (!open.ok) throw new Error("bad settings");
    const settle = (picks: Record<string, { agent?: string; model?: string; effort?: string; off?: boolean }>) => definition.settle!(open.settings, { sourceChars: 0, sourceCount: 0, picks });
    expect(settle({ "video.review": { off: true } })).toMatchObject({ reviewer: "off" });
    expect(settle({ "video.review": { agent: "claude", model: "haiku", effort: "low" } })).toMatchObject({ reviewer: "agent:claude:haiku", reviewEffort: "low" });
    expect(settle({ video: { agent: "codex" } })).not.toHaveProperty("reviewer");
  });
});
