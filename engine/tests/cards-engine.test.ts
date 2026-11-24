/**
 * Open Sourcebook's own writer of a set of flashcards (the "Model API key" maker) driven
 * by runEngine: plan, sections in parallel, a fallback card, repair card by
 * card, media salvage, grounding, research, the cost estimate and tags.
 * What was a job-store assertion (stage, progress) is an assertion on the
 * progress the engine reports; a set that stays invalid is an invalid report
 * handed back to the runner.
 */
import { describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import type { StructuredGenerationRequest, StructuredProvider } from "../src/types";
import type { Card, CardBlock, CardSet } from "../src/cards/contract";
import { InMemoryUsageSink } from "../src/providers/usage";
import { FormatRegistry, runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, EngineProgress, JsonValue, NodeSource, PriorOutput } from "../src/studio/types";
import type { FetchLike, SourceEnvelope } from "../src/types";
import type { URLVerificationReport } from "../src/types/verification";
import { createFlashcardsDefinition, type FlashcardsDefinitionOptions } from "../src/engines/flashcards/definition";
import type { ApiFlashcardsBlueprint } from "../src/engines/flashcards/engine";
import type { FlashcardSettings } from "../src/engines/flashcards/settings";
import type { MadeBlueprint } from "../src/engines/makers";
import { allBlocks, decideDepth, enrichTags, normalizeMetricsStats, stripMarksFromPlainText } from "../src/engines/flashcards/pipeline";
import { PipelineError, isRetryablePipelineError } from "../src/engines/retry";
import { URLVerifier } from "../src/verify";
import { cardKinds } from "../src/cards/kinds";

const source: SourceEnvelope = {
  originalText: "A source with enough evidence to teach one compact concept.",
  kind: "text",
  text: "A source with enough evidence to teach one compact concept.",
  references: [],
  metadata: {},
  accessLevel: "full",
  depthCap: "light",
  limitations: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

const assetSource: SourceEnvelope = {
  ...source,
  kind: "pdf",
  originalURL: "https://www.youtube.com/watch?v=abc123",
  references: [{ url: "https://www.youtube.com/watch?v=abc123", label: "source" }],
  assets: [
    { id: "fig1", kind: "figure", url: "/v1/assets/fig1", caption: "Architecture diagram", page: 12, contentType: "image/png" },
    { id: "img1", kind: "image", url: "/v1/assets/img1", contentType: "image/png" },
    { id: "img2", kind: "image", url: "/v1/assets/img2", contentType: "image/png" },
    { id: "frame1", kind: "frame", url: "/v1/assets/frame1", timestampMs: 12_000, contentType: "image/jpeg" },
  ],
};

const figure = { type: "figure", url: "/v1/assets/fig1", caption: "Architecture diagram", credit: "Page 12" };
const gallery = { type: "gallery", images: [{ url: "/v1/assets/img1" }, { url: "/v1/assets/img2", caption: "Detail" }] };
const clip = { type: "clip", url: "https://www.youtube.com/watch?v=abc123", startSeconds: 12, endSeconds: 34, title: "Key moment", posterURL: "/v1/assets/frame1", platform: "youtube" };

/** A picture card around a media block. */
const pictureCard = (media: unknown, question = "What does it show?") => ({ kind: "picture", front: [media, { type: "text", text: question }], back: [{ type: "text", text: "The parts of the system." }] });
const assetCards = [pictureCard(figure), pictureCard(gallery, "What do these show?"), pictureCard(clip, "What happens here?")];

const passingVerification: URLVerificationReport = { checked: [], failures: [], warnings: [], mediaChecked: 0, chartErrors: [], valid: true };

/** A front-and-back card with one line on each side. */
function recall(question: string, answer: string, cites: unknown[] = [{ passage: "P1" }]) {
  return { kind: "recall", front: [{ type: "text", text: question }], back: [{ type: "text", text: answer }], cites };
}

/** A card that is only read: blocks on its front, nothing to turn over. */
function explain(blocks: unknown[], cites: unknown[] = []) {
  return { kind: "explain", front: blocks, cites };
}

function setWithCards(cards: Array<Pick<Card, "kind" | "front"> & Partial<Card>>): CardSet {
  return {
    schemaVersion: 3,
    id: "123e4567-e89b-42d3-a456-426614174000",
    title: "Evidence note",
    subtitle: "Source",
    sourceKind: "note",
    tags: ["test"],
    cards: cards.map((card, index) => ({ id: `c${index + 1}`, cites: [], ...card })),
  };
}

function blocksOf(set: CardSet): CardBlock[] {
  return allBlocks(set);
}

interface PlanSection {
  id: string;
  title?: string;
}

/** A provider that answers plan, section and repair prompts from handlers. */
function scriptedProvider(handlers: {
  plan?: (request: StructuredGenerationRequest) => unknown;
  section?: (sectionID: string, request: StructuredGenerationRequest) => unknown | Promise<unknown>;
  repair?: (request: StructuredGenerationRequest) => unknown;
}): StructuredProvider & { calls: StructuredGenerationRequest[] } {
  const calls: StructuredGenerationRequest[] = [];
  return {
    name: "scripted",
    calls,
    async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
      calls.push(request);
      if (request.userPrompt.includes("Plan the sections")) {
        if (!handlers.plan) throw new Error("unexpected plan call");
        return handlers.plan(request) as T;
      }
      if (request.userPrompt.includes("Write only section")) {
        const sectionID = /Write only section ([\w-]+)/.exec(request.userPrompt)?.[1] ?? "";
        if (!handlers.section) throw new Error("unexpected section call");
        return (await handlers.section(sectionID, request)) as T;
      }
      if (request.userPrompt.includes("Repair this card")) {
        if (!handlers.repair) throw new Error("unexpected repair call");
        return handlers.repair(request) as T;
      }
      throw new Error("unexpected prompt");
    },
  };
}

/** The card a repair prompt was given. */
function cardIn(request: StructuredGenerationRequest): Record<string, unknown> {
  return JSON.parse(request.userPrompt.slice(request.userPrompt.lastIndexOf("Card JSON:\n") + "Card JSON:\n".length));
}

/** A card repair that hands back the card it was given, unchanged. */
function echoCard(request: StructuredGenerationRequest): unknown {
  return { cards: [cardIn(request)] };
}

function planOf(sections: PlanSection[], type = "note"): unknown {
  return {
    type,
    title: type === "paper" ? "Evidence paper" : "Evidence note",
    subtitle: "Source",
    tags: ["test"],
    sections: sections.map(({ id, title }) => ({ id, title: title ?? id, purpose: `Recall ${id}`, suggestedBlocks: ["recall"] })),
  };
}

const firstCard = recall("What does the source have enough of?", "Evidence to teach one compact concept.", [{ passage: "P1", quote: "enough evidence to teach", block: 1 }]);

const singleSection = scriptedProvider({
  plan: () => planOf([{ id: "main", title: "Main" }]),
  section: () => ({ sectionID: "main", cards: [firstCard] }),
});

/** One card per section, saying the section's id. */
const sectionCard = (sectionID: string) => ({ sectionID, cards: [explain([{ type: "text", text: `Body ${sectionID}` }])] });

interface RunInput {
  sources?: SourceEnvelope[];
  nodeSources?: NodeSource[];
  provider?: StructuredProvider;
  settings?: unknown;
  options?: FlashcardsDefinitionOptions;
  prompt?: string;
  assumes?: PriorOutput[];
  blueprint?: ApiFlashcardsBlueprint;
  signal?: AbortSignal;
  checkpoint?: EngineCheckpoint;
}

async function run(input: RunInput = {}) {
  const definition = createFlashcardsDefinition({
    sleep: async () => undefined,
    verify: async () => passingVerification,
    ...input.options,
  });
  const parsed = definition.parseSettings(input.settings ?? { cards: 4 });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const progress: EngineProgress[] = [];
  const blueprints: ApiFlashcardsBlueprint[] = [];
  const usage = new InMemoryUsageSink();
  const ctx: EngineContext<FlashcardSettings> = {
    jobId: "job-1",
    node: { id: "node-1", type: definition.descriptor.id, title: "Node", prompt: input.prompt ?? "", settings: parsed.settings },
    sources:
      input.nodeSources ??
      (input.sources ?? [source]).map((envelope, index) => ({ sourceId: `src-${index + 1}`, envelope, chunks: [] })),
    assumes: input.assumes ?? [],
    inputs: [],
    services: {
      provider: input.provider ?? singleSection,
      assets: createNullAssetStore(),
      usage,
      fetch: (async () => new Response(null, { status: 200 })) as FetchLike,
      now: () => "2026-11-10T09:00:00.000Z",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      progress: (update) => void progress.push(update),
    },
  };
  const result = await runEngine(definition, ctx, {
    // A blueprint saved before makers existed is Open Sourcebook's own writer's.
    ...(input.blueprint ? { blueprint: input.blueprint as unknown as MadeBlueprint } : {}),
    onBlueprint: (blueprint) => void blueprints.push(blueprint.made as ApiFlashcardsBlueprint),
  });
  return { ...result, set: result.output.payload as CardSet, progress, blueprints };
}

async function failure(promise: Promise<unknown>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) return error;
    throw error;
  }
  throw new Error("expected a PipelineError");
}

const settingsOf = (settings: Partial<FlashcardSettings> = {}): FlashcardSettings => ({ cards: 4, kinds: cardKinds.ids(), exemplarSummaries: [], ...settings });

describe("depth", () => {
  it("caps explicit depth at the extraction ceiling, lifted one tier when research backs the request", () => {
    // The shared source fixture carries depthCap "light".
    expect(decideDepth("light", source)).toBe("light"); // light requests carry no research, no lift
    expect(decideDepth("standard", source)).toBe("medium"); // research lifts light → medium
    expect(decideDepth("deep", source)).toBe("medium"); // one tier only, never the full request
    expect(decideDepth("deep", { ...source, depthCap: "tiny" })).toBe("light");
    expect(decideDepth("deep", { ...source, depthCap: "medium" })).toBe("deep");
    expect(decideDepth("standard", { ...source, depthCap: "veryDeep" })).toBe("medium"); // never exceed the request
    expect(decideDepth("deep", { ...source, depthCap: "saveOnly" })).toBe("saveOnly"); // honesty ceiling holds
    expect(decideDepth("auto", { ...source, text: "" })).toBe("saveOnly");
  });

  it("lifts the auto depth cap one tier only when the evidence itself is research-enabled", () => {
    const rich = "Evidence paragraph. ".repeat(400); // 8,000 chars → medium evidence
    expect(decideDepth("auto", { ...source, depthCap: "light", text: rich })).toBe("medium");
    const thin = "Short note. ".repeat(50); // 600 chars → light evidence, no lift
    expect(decideDepth("auto", { ...source, depthCap: "tiny", text: thin })).toBe("tiny");
  });
});

describe("Open Sourcebook's own writer", () => {
  it("runs plan, generate and validate through runEngine", async () => {
    const result = await run();
    expect(result.report).toEqual({ valid: true, issues: [] });
    expect(result.repairRounds).toBe(0);
    expect(result.set.schemaVersion).toBe(3);
    expect(result.set.cards).toEqual([
      {
        id: "c1",
        kind: "recall",
        section: "Main",
        front: [{ type: "text", text: "What does the source have enough of?" }],
        back: [{ type: "text", text: "Evidence to teach one compact concept." }],
        cites: [{ sourceId: "src-1", spot: "passage", locator: { charStart: 0, charEnd: source.text.length }, quote: "enough evidence to teach", block: 1 }],
      },
    ]);
    expect(result.output).toMatchObject({
      title: "Evidence note",
      summary: expect.stringContaining("What does the source have enough of?"),
      citations: [{ sourceId: "src-1", locator: { charStart: 0 }, quote: "enough evidence to teach", anchor: "cards[0].back[0]" }],
      assets: [],
    });
  });

  it("asks the planner and each section for the number of cards and the kinds the item takes", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "first" }, { id: "second" }]),
      section: (sectionID) => ({ sectionID, cards: [recall(`What is ${sectionID}?`, "It is one.")] }),
    });
    await run({ provider, settings: { cards: 6, kinds: ["recall", "cloze"] } });
    const [plan, ...sections] = provider.calls;
    expect(plan.userPrompt).toContain("The set has 6 cards: the number the person asked for.");
    expect(plan.userPrompt).toContain(cardKinds.catalog(["recall", "cloze"]));
    expect(plan.userPrompt).not.toContain("- explain (");
    for (const call of sections) expect(call.userPrompt).toContain("About 3 cards for this section (the set has 6 in all)");
  });

  it("fits the number of cards to the sources when the item sets none", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "main" }]), section: () => ({ sectionID: "main", cards: [firstCard] }) });
    const result = await run({ provider, settings: { cards: 0 } });
    expect(provider.calls[0].userPrompt).toContain("About 4 cards fits sources of this size");
    expect(result.blueprints[0].cards).toBe(4);
    // A count fit to the sources is a guess, so the set says nothing about its size.
    expect(result.set.sizeNote).toBeUndefined();
  });

  it("saves the section plan as the blueprint and skips planning when one is given", async () => {
    const first = await run();
    expect(first.blueprints).toHaveLength(1);
    const saved = JSON.parse(JSON.stringify(first.blueprints[0])) as ApiFlashcardsBlueprint;
    expect(saved).toMatchObject({ requestedDepth: "light", depth: "light", cards: 4, structure: { sections: [{ id: "main" }] } });

    const provider = scriptedProvider({ section: () => ({ sectionID: "main", cards: [recall("Resumed?", "Yes.")] }) });
    const resumed = await run({ provider, blueprint: saved });
    expect(resumed.blueprints).toEqual([]);
    expect(provider.calls.map((call) => call.task)).toEqual(["section"]);
    expect(resumed.set.cards.map((card) => card.front)).toEqual([[{ type: "text", text: "Resumed?" }]]);
  });

  it("refuses a saved blueprint it cannot use", async () => {
    const error = await failure(run({ blueprint: { requestedDepth: "light", depth: "light" } as ApiFlashcardsBlueprint }));
    expect(error.code).toBe("INVALID_BLUEPRINT");
    expect(isRetryablePipelineError(error)).toBe(false);
  });

  it("emits monotonic writing progress for each completed section", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "first" }, { id: "second" }, { id: "third" }]), section: sectionCard });
    const result = await run({ provider });
    const writing = result.progress.filter((update) => update.stage === "writing").map((update) => update.progress);
    expect(writing.length).toBe(4);
    expect(writing.every((progress) => progress >= 0.3 && progress <= 0.75)).toBe(true);
    expect(writing).toEqual([...writing].sort((a, b) => a - b));
    expect(writing.at(-1)).toBeCloseTo(0.75);
    expect(result.progress.map((update) => update.progress)).toEqual([...result.progress.map((update) => update.progress)].sort((a, b) => a - b));
    expect(result.set.cards).toHaveLength(3);
  });

  it("makes no set from a source with no readable text, and says why, with no model call", async () => {
    const sourceURL = "https://blocked.example/article";
    const blocked: SourceEnvelope = {
      ...source,
      originalText: "",
      originalURL: sourceURL,
      text: "",
      kind: "web",
      references: [{ url: sourceURL, domain: "blocked.example", label: "source" }],
      accessLevel: "none",
      depthCap: "saveOnly",
    };
    const provider = scriptedProvider({});
    const error = await failure(run({ sources: [blocked], settings: { cards: 20 }, provider }));
    expect(error.code).toBe("NO_SOURCE_TEXT");
    expect(isRetryablePipelineError(error)).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("makes no set from a source that gave only its title and details", async () => {
    const video: SourceEnvelope = {
      ...source,
      kind: "youtube",
      originalURL: "https://www.youtube.com/watch?v=abc123",
      references: [{ url: "https://www.youtube.com/watch?v=abc123", label: "source" }],
      text: "But what is a neural network? | Deep learning chapter 1",
      accessLevel: "metadata",
      depthCap: "tiny",
    };
    const provider = scriptedProvider({});
    const error = await failure(run({ sources: [video], settings: { cards: 0 }, provider }));
    expect(error.code).toBe("NO_SOURCE_TEXT");
    expect(provider.calls).toHaveLength(0);
  });

  it("sends dead links found by verification to repair", async () => {
    const deadURL = "https://supplemental.example/dead";
    const withLink: SourceEnvelope = { ...source, references: [{ url: deadURL, label: "source" }] };
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [explain([{ type: "text", text: "Body" }, { type: "linkCard", url: deadURL, title: "Dead", domain: "supplemental.example" }])] }),
      repair: () => ({ cards: [explain([{ type: "text", text: "Body" }])] }),
    });
    const fetchImpl: FetchLike = async () => new Response(null, { status: 404 });
    const result = await run({
      sources: [withLink],
      provider,
      options: { verify: (set, _services, warningURLs) => new URLVerifier({ fetchImpl, warningURLs }).verify(set) },
    });
    expect(result.repairRounds).toBe(1);
    const repairPrompt = provider.calls.find((call) => call.task === "repair")!.userPrompt;
    expect(repairPrompt).toContain(deadURL);
    expect(repairPrompt).toContain("unreachable_url");
    expect(result.report.valid).toBe(true);
    expect(blocksOf(result.set)).toEqual([{ type: "text", text: "Body" }]);
  });

  it("keeps a warning when a link to the original source does not answer the check", async () => {
    const sourceURL = "https://slow.example/page";
    const page: SourceEnvelope = { ...source, originalURL: sourceURL, references: [{ url: sourceURL, label: "source" }] };
    const fetchImpl: FetchLike = async (input) => new Response(null, { status: String(input) === sourceURL ? 403 : 404 });
    const verifications: URLVerificationReport[] = [];
    const result = await run({
      sources: [page],
      provider: scriptedProvider({
        plan: () => planOf([{ id: "main" }]),
        section: () => ({ sectionID: "main", cards: [firstCard, explain([{ type: "linkCard", url: sourceURL, title: "The page", domain: "slow.example" }])] }),
      }),
      options: {
        verify: async (set, _services, warningURLs) => {
          const report = await new URLVerifier({ fetchImpl, warningURLs }).verify(set);
          verifications.push(report);
          return report;
        },
      },
    });
    expect(result.report.valid).toBe(true);
    expect(verifications[0].checked).toEqual([expect.objectContaining({ url: sourceURL, ok: false, status: 403 })]);
    expect(result.report.issues).toEqual([expect.objectContaining({ severity: "warning", code: "verification_warning", message: expect.stringContaining("403") })]);
  });

  it("generates sections in parallel while preserving plan order and the concurrency bound", async () => {
    const sectionIDs = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const delays: Record<string, number> = { s1: 30, s2: 10, s3: 20, s4: 5, s5: 8, s6: 3 };
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = scriptedProvider({
      plan: () => planOf(sectionIDs.map((id) => ({ id }))),
      section: async (sectionID) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delays[sectionID] ?? 0));
        inFlight -= 1;
        return sectionCard(sectionID);
      },
    });
    const result = await run({ provider });
    expect(maxInFlight).toBe(4); // default sectionConcurrency
    expect(blocksOf(result.set).map((block) => (block as { text?: string }).text)).toEqual(sectionIDs.map((id) => `Body ${id}`));
    expect(result.set.cards.map((card) => card.id)).toEqual(sectionIDs.map((_, index) => `c${index + 1}`));
  });

  it("honours a custom sectionConcurrency", async () => {
    const sectionIDs = ["s1", "s2", "s3", "s4", "s5"];
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = scriptedProvider({
      plan: () => planOf(sectionIDs.map((id) => ({ id }))),
      section: async (sectionID) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return sectionCard(sectionID);
      },
    });
    const result = await run({ provider, options: { sectionConcurrency: 2 } });
    expect(maxInFlight).toBe(2);
    expect(blocksOf(result.set).map((block) => (block as { text?: string }).text)).toEqual(sectionIDs.map((id) => `Body ${id}`));
  });

  it("delivers a fallback card when one section exhausts its retries", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "first", title: "First" }, { id: "second", title: "Second" }, { id: "third", title: "Third" }]),
      section: (sectionID) => {
        if (sectionID === "second") throw new Error("provider exploded");
        return sectionCard(sectionID);
      },
    });
    const result = await run({ provider, options: { maxProviderAttempts: 2 } });
    expect(result.report.valid).toBe(true);
    expect(blocksOf(result.set)).toEqual([
      { type: "text", text: "Body first" },
      { type: "text", text: expect.stringContaining("could not be written") },
      { type: "text", text: "Body third" },
    ]);
    expect(provider.calls.filter((call) => call.task === "section")).toHaveLength(4);
    // The fallback is a card that is only read, in its section's place.
    expect(result.set.cards[1]).toMatchObject({ kind: "explain", section: "Second" });
  });

  it("rejects a section that returns no cards and gives it the fallback", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "first" }, { id: "second", title: "Second" }]),
      section: (sectionID) => (sectionID === "second" ? { sectionID, bits: [{ blocks: [{ type: "text", text: "Old shape" }] }] } : sectionCard(sectionID)),
    });
    const result = await run({ provider, options: { maxProviderAttempts: 1 } });
    expect(result.set.cards[1]).toMatchObject({ kind: "explain", section: "Second" });
  });

  it("retries planning when the structure plan comes back with no sections", async () => {
    let planAttempts = 0;
    const provider = scriptedProvider({
      plan: () => {
        planAttempts += 1;
        return planAttempts < 3 ? { type: "note", title: "Junk plan", sections: [] } : planOf([{ id: "main" }]);
      },
      section: () => ({ sectionID: "main", cards: [recall("Recovered?", "Yes.")] }),
    });
    const result = await run({ provider, options: { maxProviderAttempts: 3 } });
    expect(planAttempts).toBe(3);
    expect(result.set.cards).toHaveLength(1);
  });

  it("fails retryable when planning never yields sections", async () => {
    let planAttempts = 0;
    const provider = scriptedProvider({
      plan: () => {
        planAttempts += 1;
        return { type: "note", title: "Junk plan", sections: [] };
      },
    });
    const error = await failure(run({ provider, options: { maxProviderAttempts: 3 } }));
    expect(error.code).toBe("EMPTY_STRUCTURE");
    expect(isRetryablePipelineError(error)).toBe(true);
    expect(planAttempts).toBe(3);
  });

  it("fails with EMPTY_STRUCTURE only when every section fails", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "first" }, { id: "second" }]),
      section: () => {
        throw new Error("provider exploded");
      },
    });
    const error = await failure(run({ provider, options: { maxProviderAttempts: 2 } }));
    expect(error.code).toBe("EMPTY_STRUCTURE");
    expect(error.message).toContain("First failure: provider exploded");
  });

  it("stops writing sections once the job is cancelled", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider({
      plan: () => planOf(["a", "b", "c", "d", "e", "f"].map((id) => ({ id }))),
      section: (sectionID) => {
        controller.abort(new Error("cancelled"));
        return sectionCard(sectionID);
      },
    });
    await expect(run({ provider, options: { sectionConcurrency: 2 }, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(provider.calls.filter((call) => call.task === "section")).toHaveLength(2);
  });
});

describe("media", () => {
  it("accepts harvested asset URLs in figure, gallery, and clip blocks", async () => {
    const sectionPrompts: string[] = [];
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }], "paper"),
      section: (_id, request) => {
        sectionPrompts.push(request.userPrompt);
        return { sectionID: "main", cards: assetCards };
      },
    });
    const result = await run({ provider, sources: [assetSource] });
    expect(result.repairRounds).toBe(0);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards.map((card) => card.front[0])).toEqual([figure, gallery, clip]);
    expect(sectionPrompts[0]).toContain("[asset] kind=figure page=12 url=/v1/assets/fig1 caption=Architecture diagram");
    expect(result.output.assets?.map((asset) => asset.id)).toEqual(["fig1", "img1", "img2", "frame1"]);
  });

  it("enforces one appearance per asset across cards, figure and linkPreview", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }], "paper"),
      section: () => ({
        sectionID: "main",
        cards: [
          pictureCard({ type: "figure", url: "/v1/assets/img1", caption: "First figure", credit: "Page 1" }),
          { kind: "recall", front: [{ type: "figure", url: "/v1/assets/img1", caption: "Repeated figure", credit: "Page 1" }, { type: "text", text: "What else?" }], back: [{ type: "text", text: "More." }], cites: [] },
          explain([{ type: "linkPreview", url: "https://www.youtube.com/watch?v=abc123", title: "Source", domain: "youtube.com", imageURL: "/v1/assets/img1" }]),
        ],
      }),
    });
    const result = await run({ provider, sources: [assetSource] });
    // First appearance wins, even when the repeat sits on another card: the
    // first figure keeps the asset, the repeated figure is dropped, and the
    // linkPreview loses only its (optional) imageURL.
    expect(result.repairRounds).toBe(0);
    expect(result.set.cards[0].front[0]).toMatchObject({ type: "figure", url: "/v1/assets/img1", caption: "First figure" });
    expect(result.set.cards[1].front).toEqual([{ type: "text", text: "What else?" }]);
    expect(result.set.cards[2].front[0].type).toBe("linkPreview");
    expect((result.set.cards[2].front[0] as { imageURL?: string }).imageURL).toBeUndefined();
  });

  it("salvages a set whose only remaining errors after a repair round are unverifiable media", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }], "paper"),
      section: () => ({
        sectionID: "main",
        cards: [
          explain([{ type: "text", text: "Supported explanation" }, { type: "figure", url: "/v1/assets/not-harvested" }]),
          recall("Which pictures?", "These.", [{ passage: "P1" }]),
        ].map((card, index) =>
          index === 1 ? { ...card, back: [{ type: "text", text: "These." }, { type: "gallery", images: [{ url: "/v1/assets/img1" }, { url: "/v1/assets/not-harvested-2" }, { url: "/v1/assets/img2" }] }] } : card,
        ),
      }),
      repair: echoCard,
    });
    const result = await run({ provider, sources: [assetSource] });
    // One model round (one call for each of the two failing cards), then the
    // figure is stripped wholesale and the gallery survives with the
    // offending image pruned. A second round could not make the missing
    // assets exist.
    expect(provider.calls.filter((call) => call.task === "repair")).toHaveLength(2);
    expect(result.repairRounds).toBe(1);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards[0].front).toEqual([{ type: "text", text: "Supported explanation" }]);
    expect(result.set.cards[1].back).toEqual([{ type: "text", text: "These." }, { type: "gallery", images: [{ url: "/v1/assets/img1" }, { url: "/v1/assets/img2" }] }]);
    expect(result.set.cards.map((card) => card.id)).toEqual(["c1", "c2"]);
  });

  it("rejects clip blocks whose URLs are not evidence", async () => {
    const offending = explain([
      { type: "text", text: "Supported explanation" },
      { type: "clip", url: "https://evil.example/video", startSeconds: 0, endSeconds: 12, posterURL: "/v1/assets/not-harvested" },
    ]);
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }], "paper"),
      section: () => ({ sectionID: "main", cards: [offending] }),
      repair: () => ({ cards: [offending] }),
    });
    const result = await run({ provider, sources: [assetSource] });
    expect(result.report.valid).toBe(true);
    expect(blocksOf(result.set)).toEqual([{ type: "text", text: "Supported explanation" }]);
  });

  it("refuses to salvage non-media blocks and hands back an invalid report", async () => {
    const offending = explain([
      { type: "text", text: "Supported explanation" },
      { type: "linkCard", url: "https://evil.example/x", title: "Evil", domain: "evil.example" },
    ]);
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [offending] }),
      repair: () => ({ cards: [offending] }),
    });
    const result = await run({ provider });
    expect(result.repairRounds).toBe(2);
    expect(result.report.valid).toBe(false);
    expect(result.report.issues.filter((issue) => issue.severity === "error")).toEqual([
      expect.objectContaining({ path: "$.cards[0].front[1].url", code: "unapproved_url", severity: "error" }),
    ]);
  });

  it("cites a picture by its asset and page, and a clip by its moment in the recording", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }], "paper"),
      section: () => ({ sectionID: "main", cards: assetCards }),
    });
    const result = await run({ provider, sources: [assetSource] });
    expect(result.set.cards.map((card) => card.kind)).toEqual(["picture", "picture", "picture"]);
    expect(result.set.cards.map((card) => card.cites)).toEqual([
      [{ sourceId: "src-1", spot: "image", assetId: "fig1", locator: { page: 12 }, block: 0 }],
      [
        { sourceId: "src-1", spot: "image", assetId: "img1", block: 0 },
        { sourceId: "src-1", spot: "image", assetId: "img2", block: 0 },
      ],
      [{ sourceId: "src-1", spot: "moment", locator: { startMs: 12_000, endMs: 34_000 }, block: 0 }],
    ]);
  });
});

describe("repair works card by card", () => {
  const half = "word ".repeat(100).trim();
  const small = (n: number) => recall(`What is point ${n}?`, `Point number ${n}.`);
  const overBack = (tag = "") => ({ kind: "recall", front: [{ type: "text", text: `${tag}What are both halves?` }], back: [{ type: "text", text: half }, { type: "text", text: half }], cites: [{ passage: "P1" }] });

  it("repairs a schema error and keeps the set's id and the card's id", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [small(0), { kind: "recall", front: [{ type: "text" }], back: [{ type: "text", text: "A." }], cites: [] }] }),
      repair: () => ({ cards: [{ ...recall("Fixed?", "Fixed."), id: "c99" }] }),
    });
    const before: string[] = [];
    const result = await run({
      provider,
      options: { verify: async (set) => (before.push(set.id), passingVerification) },
    });
    expect(provider.calls.filter((call) => call.task === "repair")).toHaveLength(1);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards.map((card) => [card.id, card.front])).toEqual([
      ["c1", [{ type: "text", text: "What is point 0?" }]],
      ["c2", [{ type: "text", text: "Fixed?" }]],
    ]);
    expect(before).toEqual([result.set.id]);
  });

  it("sends only the failing card of a large set to the model, and keeps every other card and every id", async () => {
    const cards = Array.from({ length: 30 }, (_, n) => (n === 12 ? overBack() : small(n)));
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main", title: "Main" }]),
      section: () => ({ sectionID: "main", cards }),
      repair: (request) => {
        expect(request.userPrompt).toContain("side_over_budget");
        expect(request.userPrompt).toContain('"path":"back"');
        expect(request.userPrompt).not.toContain("Point number 3.");
        return { cards: [recall("What is the first half?", half), recall("What is the second half?", half)] };
      },
    });
    const result = await run({ provider, settings: { cards: 30 }, options: { research: async () => ({ summary: "", claims: [], references: [], limitations: [] }) } });
    expect(provider.calls.filter((call) => call.task === "repair")).toHaveLength(1);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards).toHaveLength(31);
    expect(result.set.cards[11].back).toEqual([{ type: "text", text: "Point number 11." }]);
    expect(result.set.cards[14].back).toEqual([{ type: "text", text: "Point number 13." }]);
    expect(result.set.cards.every((card) => card.section === "Main")).toBe(true);
    // The person's progress is kept by card id: every card keeps its own, the split one keeps it on its first half, and its second gets a new one.
    const ids = result.set.cards.map((card) => card.id);
    expect(ids.slice(0, 13)).toEqual(Array.from({ length: 13 }, (_, n) => `c${n + 1}`));
    expect(ids[13]).toBe("c31");
    expect(ids.slice(14)).toEqual(Array.from({ length: 17 }, (_, n) => `c${n + 14}`));
  });

  it("tells the repair which values a field allows", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main", title: "Main" }]),
      section: () => ({ sectionID: "main", cards: [explain([{ type: "callout", style: "note", text: "Mind this." }], [{ passage: "P1" }])] }),
      repair: (request) => {
        expect(request.userPrompt).toMatch(/expected info \| success \| warning/);
        expect(request.userPrompt).toContain("got note");
        return { cards: [explain([{ type: "callout", style: "info", text: "Mind this." }], [{ passage: "P1" }])] };
      },
    });
    const result = await run({ provider });
    expect(result.report.valid).toBe(true);
  });

  it("sends a card that does not do what its kind needs to repair", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [{ kind: "recall", front: [{ type: "text", text: "What is the concept?" }], cites: [{ passage: "P1" }] }] }),
      repair: (request) => {
        expect(request.userPrompt).toContain("kind_needs");
        return { cards: [recall("What is the concept?", "One compact concept.")] };
      },
    });
    const result = await run({ provider });
    expect(result.repairRounds).toBe(1);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards[0].back).toEqual([{ type: "text", text: "One compact concept." }]);
  });

  it("holds every card to the kinds the item takes", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [{ kind: "cloze", front: [{ type: "cloze", text: "The source teaches one [[compact]] concept." }], cites: [{ passage: "P1" }] }] }),
      repair: (request) => {
        expect(request.userPrompt).toContain("kind_not_allowed");
        expect(request.userPrompt).not.toContain("- cloze (");
        return { cards: [recall("What kind of concept does the source teach?", "A compact one.")] };
      },
    });
    const result = await run({ provider, settings: { cards: 4, kinds: ["recall"] } });
    expect(result.repairRounds).toBe(1);
    expect(result.report.valid).toBe(true);
    expect(result.set.cards.map((card) => card.kind)).toEqual(["recall"]);
  });

  it("keeps a card as it was when its repair call fails, and still repairs the others", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [overBack("first: "), small(1), overBack("second: ")] }),
      repair: (request) => {
        if (request.userPrompt.includes('"text":"first: ')) throw new Error("provider timed out");
        return { cards: [recall("What are both halves?", "second, shorter")] };
      },
    });
    const result = await run({ provider, options: { maxProviderAttempts: 1 } });
    expect(result.report.valid).toBe(false);
    expect(result.report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path)).toEqual(["$.cards[0].back"]);
    expect(result.set.cards[2].back).toEqual([{ type: "text", text: "second, shorter" }]);
    expect(result.set.cards[2].id).toBe("c3");
  });

  it("fills an empty title from the plan without a model call", async () => {
    const provider = scriptedProvider({
      plan: () => ({ ...(planOf([{ id: "main" }]) as object), title: "Planned title" }),
      section: () => ({ sectionID: "main", cards: [small(1)] }),
    });
    const definition = createFlashcardsDefinition({ sleep: async () => undefined, verify: async () => passingVerification });
    const first = await run({ provider });
    const broken = { ...first.output, payload: { ...first.set, title: "" } };
    const report = { valid: false, issues: [{ path: "$.title", code: "required", message: "title is required", severity: "error" as const }] };
    const repaired = await definition.engine.repair(
      {
        jobId: "job-1",
        node: { id: "node-1", type: "flashcards", title: "Node", prompt: "", settings: settingsOf() },
        sources: [{ sourceId: "src-1", envelope: source, chunks: [] }],
        assumes: [],
        inputs: [],
        services: { provider, assets: createNullAssetStore(), usage: new InMemoryUsageSink(), fetch: (async () => new Response(null)) as FetchLike, now: () => "", progress: () => undefined },
      },
      broken,
      report,
      { maker: "api", made: first.blueprints[0] },
    );
    expect(repaired.payload.title).toBe("Planned title");
    expect(provider.calls.filter((call) => call.task === "repair")).toHaveLength(0);
  });
});

describe("the size of the set", () => {
  it("says so, in the set's own words, when it came out clearly smaller than the number asked for", async () => {
    const result = await run({ settings: { cards: 20 }, options: { research: async () => ({ summary: "", claims: [], references: [], limitations: [] }) } });
    expect(result.set.cards).toHaveLength(1);
    expect(result.set.sizeNote).toBe("You asked for 20 cards; the sources held enough for 1.");
  });

  it("says nothing when the set is about the size asked for", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("One?", "1."), recall("Two?", "2."), recall("Three?", "3.")] }),
    });
    const result = await run({ provider, settings: { cards: 4 } });
    expect(result.set.sizeNote).toBeUndefined();
  });
});

describe("research", () => {
  it("researches for a large set, keeps it in the blueprint and lets its references through", async () => {
    const researched: string[] = [];
    const supplemental = "https://context.example/background";
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [explain([{ type: "text", text: "Body" }, { type: "linkCard", url: supplemental, title: "Background", domain: "context.example" }])] }),
    });
    const result = await run({
      provider,
      settings: { cards: 20 },
      options: {
        research: async (envelope) => {
          researched.push(envelope.text);
          return { summary: "context", claims: [], limitations: [], references: [{ url: supplemental, label: "supplemental", reason: "background" }] };
        },
      },
    });
    expect(researched).toEqual([source.text]);
    expect(result.blueprints[0].research?.references[0].url).toBe(supplemental);
    expect(result.report.valid).toBe(true);
    expect(provider.calls[0].userPrompt).toContain(supplemental);
  });

  it("does not research for a small set", async () => {
    let researched = 0;
    await run({ options: { research: async () => (researched++, { summary: "", claims: [], references: [], limitations: [] }) } });
    expect(researched).toBe(0);
  });
});

describe("grounding", () => {
  it("sends a quote that is not in its passage to repair, and keeps one that is", async () => {
    let repairs = 0;
    const card = (quote: string) => recall("What does the source teach?", "One compact concept.", [{ passage: "P1", quote, block: 1 }]);
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [card("a quote the source never said")] }),
      repair: (request) => {
        repairs += 1;
        expect(request.userPrompt).toContain("quote_not_in_passage");
        return { cards: [card("one compact concept")] };
      },
    });
    const result = await run({ provider });
    expect(repairs).toBe(1);
    expect(result.report).toEqual({ valid: true, issues: [] });
    expect(result.set.cards[0].cites).toEqual([
      { sourceId: "src-1", spot: "passage", locator: { charStart: 0, charEnd: source.text.length }, quote: "one compact concept", block: 1 },
    ]);
  });

  it("drops a cite to a passage the item does not have", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("Idea?", "Idea.", [{ passage: "P9" }, { passage: "P1" }])] }),
    });
    const result = await run({ provider });
    expect(result.set.cards[0].cites).toEqual([{ sourceId: "src-1", spot: "passage", locator: { charStart: 0, charEnd: source.text.length } }]);
  });

  it("sends a card that names a passage label or 'the passage' to repair", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("What does P1 teach?", "The passage teaches one compact concept.")] }),
      repair: (request) => {
        expect(request.userPrompt).toContain("names_prompt_label");
        return { cards: [recall("What does the source teach?", "One compact concept.")] };
      },
    });
    const result = await run({ provider });
    expect(result.repairRounds).toBe(1);
    expect(result.report.valid).toBe(true);
  });

  it("lets a label or word through when the source itself uses it", async () => {
    const own: SourceEnvelope = { ...source, text: "The P1 visa and the Northwest Passage.", originalText: "The P1 visa and the Northwest Passage." };
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("Is a P1 visa a passage?", "No.")] }),
    });
    const result = await run({ provider, sources: [own] });
    expect(result.repairRounds).toBe(0);
  });

  it("takes a label word used as ordinary vocabulary, which the source never uses, and still sends a pointer at the passages to repair", async () => {
    const ordinary = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({
        sectionID: "main",
        cards: [recall("What does final passage of a bill need?", "A simple majority."), recall("What did traders find?", "A passage through the mountains."), recall("Where does a river start?", "At the source of the river."), recall("Whose words open the speech?", "A quote from Lincoln.")],
      }),
    });
    const kept = await run({ provider: ordinary });
    expect(kept.repairRounds).toBe(0);
    expect(kept.report.issues.filter((issue) => issue.code === "names_prompt_label")).toEqual([]);

    const pointing = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("What does the excerpt above say about final passage?", "As passage 2 says, a simple majority.")] }),
      repair: (request) => {
        asked.push(request.userPrompt);
        return { cards: [recall("What does final passage of a bill need?", "A simple majority.")] };
      },
    });
    const asked: string[] = [];
    const repaired = await run({ provider: pointing });
    expect(asked[0]).toContain("names_prompt_label");
    expect(asked[0]).toMatch(/the excerpt above/);
    expect(asked[0]).toMatch(/passage 2/);
    expect(repaired.repairRounds).toBe(1);
    expect(repaired.report.valid).toBe(true);
  });
});

function memoryCheckpoint(): EngineCheckpoint & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return { entries, get: (key) => entries.get(key), put: async (key, value) => void entries.set(key, structuredClone(value)) };
}

describe("a retry continues from finished work", () => {
  const definition = createFlashcardsDefinition({ sleep: async () => undefined, verify: async () => passingVerification, maxProviderAttempts: 1 });
  const retryContext = (provider: StructuredProvider, checkpoint: EngineCheckpoint, signal?: AbortSignal): EngineContext<FlashcardSettings> => ({
    jobId: "job-1",
    node: { id: "node-1", type: "flashcards", title: "Node", prompt: "", settings: settingsOf() },
    sources: [{ sourceId: "src-1", envelope: source, chunks: [] }],
    assumes: [],
    inputs: [],
    services: {
      provider,
      assets: createNullAssetStore(),
      usage: new InMemoryUsageSink(),
      fetch: (async () => new Response(null)) as FetchLike,
      now: () => "",
      progress: () => undefined,
      checkpoint,
      ...(signal ? { signal } : {}),
    },
  });
  const cardFor = (id: string) => recall(`What is section ${id}?`, `Section ${id}.`);

  it("keeps each written section, so a retry writes only the ones not done", async () => {
    const checkpoint = memoryCheckpoint();
    const written: string[] = [];
    const controller = new AbortController();
    const first = scriptedProvider({
      plan: () => planOf([{ id: "a" }, { id: "b" }, { id: "c" }]),
      section: async (id) => {
        if (id === "c") {
          await Promise.resolve();
          controller.abort(new Error("attempt lost"));
          throw new Error("provider timed out");
        }
        written.push(id);
        return { sectionID: id, cards: [cardFor(id)] };
      },
    });
    const blueprints: MadeBlueprint[] = [];
    await expect(runEngine(definition, retryContext(first, checkpoint, controller.signal), { onBlueprint: (blueprint) => void blueprints.push(blueprint) })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...checkpoint.entries.keys()].sort()).toEqual(["section:a", "section:b"]);

    const second = scriptedProvider({ section: (id) => (written.push(id), { sectionID: id, cards: [cardFor(id)] }) });
    const result = await runEngine(definition, retryContext(second, checkpoint), { blueprint: blueprints[0] });
    expect(written).toEqual(["a", "b", "c"]);
    expect(second.calls).toHaveLength(1);
    expect(result.output.payload.cards.map((card) => card.back)).toEqual(["a", "b", "c"].map((id) => [{ type: "text", text: `Section ${id}.` }]));
  });

  it("a retry after a failed repair starts from the saved draft, not from the sections", async () => {
    const checkpoint = memoryCheckpoint();
    const half = "word ".repeat(100).trim();
    const controller = new AbortController();
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [{ kind: "recall", front: [{ type: "text", text: "Both halves?" }], back: [{ type: "text", text: half }, { type: "text", text: half }], cites: [{ passage: "P1" }] }] }),
      repair: () => {
        controller.abort(new Error("attempt lost"));
        throw new Error("provider timed out");
      },
    });
    const blueprints: MadeBlueprint[] = [];
    await expect(runEngine(definition, retryContext(provider, checkpoint, controller.signal), { onBlueprint: (blueprint) => void blueprints.push(blueprint) })).rejects.toThrow();
    expect(checkpoint.entries.has("draft")).toBe(true);

    const retry = scriptedProvider({ repair: () => ({ cards: [recall("First half?", half), recall("Second half?", half)] }) });
    const result = await runEngine(definition, retryContext(retry, checkpoint), { blueprint: blueprints[0] });
    expect(retry.calls.every((call) => call.userPrompt.includes("Repair this card"))).toBe(true);
    expect(result.report.valid).toBe(true);
    expect(result.output.payload.cards.map((card) => card.id)).toEqual(["c1", "c2"]);
  });
});

describe("a source that was cut", () => {
  it("tells the planner, every section writer and repair how much of the source the passages are", async () => {
    const cut: SourceEnvelope = { ...source, title: "Printing press", metadata: { textCut: "true", textChars: "61532", textUsedChars: "23998" } };
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("What is it?", "One compact concept.")] }),
    });
    await run({ provider, sources: [cut] });
    const note = '"Printing press" was cut: its passages are only the first 23,998 of 61,532 characters.';
    expect(provider.calls.length).toBeGreaterThan(1);
    for (const call of provider.calls) expect(call.userPrompt).toContain(note);
  });
});

describe("node context and sources", () => {
  it("passes the node brief and assumed outputs into planning and writing", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "main" }]), section: () => sectionCard("main") });
    await run({
      provider,
      prompt: "Only the second theorem.",
      assumes: [{ nodeId: "n0", outputId: "o0", type: "video", title: "Overview", summary: "Covers the setup." }],
    });
    for (const call of provider.calls) {
      expect(call.userPrompt).toContain("Only the second theorem.");
      expect(call.userPrompt).toContain('- video "Overview": Covers the setup.');
    }
  });

  it("merges several sources and names each one", async () => {
    const second: SourceEnvelope = {
      ...source,
      title: "Second",
      text: "More evidence.",
      originalURL: "https://two.example/",
      references: [{ url: "https://two.example/", label: "source" }],
      depthCap: "deep",
    };
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [explain([{ type: "linkCard", url: "https://two.example/", title: "Two", domain: "two.example" }])] }),
    });
    const result = await run({ provider, sources: [source, second] });
    expect(result.report.valid).toBe(true);
    expect(result.output.citations).toEqual([{ sourceId: "src-1" }, { sourceId: "src-2" }]);
    expect(provider.calls[0].userPrompt).toContain("(Second)");
    expect(provider.calls[0].userPrompt).toContain("More evidence.");
  });

  it("reads only the chunks inside a node's range", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "main" }]), section: () => sectionCard("main") });
    await run({
      provider,
      nodeSources: [
        {
          sourceId: "pdf",
          envelope: { ...source, text: "PAGE ONE TEXT\nPAGE TWO TEXT" },
          chunks: [
            { id: "c1", ord: 0, text: "PAGE ONE TEXT", locator: { page: 1 } },
            { id: "c2", ord: 1, text: "PAGE TWO TEXT", locator: { page: 2 } },
          ],
          range: { page: 2 },
        },
      ],
    });
    expect(provider.calls[0].userPrompt).toContain("PAGE TWO TEXT");
    expect(provider.calls[0].userPrompt).not.toContain("PAGE ONE TEXT");
  });

  it("reads the chunks inside a page span", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "main" }]), section: () => sectionCard("main") });
    await run({
      provider,
      nodeSources: [
        {
          sourceId: "pdf",
          envelope: { ...source, text: "P1 P2 P3-4 P5" },
          chunks: [
            { id: "c1", ord: 0, text: "PAGE ONE", locator: { page: 1 } },
            { id: "c2", ord: 1, text: "PAGE TWO", locator: { page: 2 } },
            { id: "c3", ord: 2, text: "PAGES THREE TO FOUR", locator: { page: 3, endPage: 4 } },
            { id: "c4", ord: 3, text: "PAGE FIVE", locator: { page: 5 } },
          ],
          range: { page: 2, endPage: 3 },
        },
      ],
    });
    const prompt = provider.calls[0].userPrompt;
    expect(prompt).toContain("PAGE TWO");
    expect(prompt).toContain("PAGES THREE TO FOUR");
    expect(prompt).not.toContain("PAGE ONE");
    expect(prompt).not.toContain("PAGE FIVE");
  });

  it("reads the chunks inside a slide span", async () => {
    const provider = scriptedProvider({ plan: () => planOf([{ id: "main" }]), section: () => sectionCard("main") });
    await run({
      provider,
      nodeSources: [
        {
          sourceId: "deck",
          envelope: { ...source, text: "S1 S2 S3" },
          chunks: [
            { id: "s1", ord: 0, text: "SLIDE ONE", locator: { slide: 1 } },
            { id: "s2", ord: 1, text: "SLIDE TWO", locator: { slide: 2 } },
            { id: "s3", ord: 2, text: "SLIDE THREE", locator: { slide: 3 } },
          ],
          range: { slide: 2, endSlide: 3 },
        },
      ],
    });
    const prompt = provider.calls[0].userPrompt;
    expect(prompt).toContain("SLIDE TWO");
    expect(prompt).toContain("SLIDE THREE");
    expect(prompt).not.toContain("SLIDE ONE");
  });

  it("validates and repairs from the blueprint it is handed, with no state left over from generate", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main" }]),
      section: () => ({ sectionID: "main", cards: [recall("Q?", "A.")] }),
      repair: () => ({ cards: [recall("Fixed?", "Fixed.", [])] }),
    });
    const first = await run({ provider });
    const blueprint: MadeBlueprint = { maker: "api", made: first.blueprints[0] };
    // A fresh engine and a fresh context: nothing from the run above.
    const definition = createFlashcardsDefinition({ sleep: async () => undefined, verify: async () => passingVerification });
    const ctx: EngineContext<FlashcardSettings> = {
      jobId: "job-2",
      node: { id: "node-1", type: "flashcards", title: "Node", prompt: "", settings: settingsOf() },
      sources: [{ sourceId: "src-1", envelope: source, chunks: [] }],
      assumes: [],
      inputs: [],
      services: {
        provider,
        assets: createNullAssetStore(),
        usage: new InMemoryUsageSink(),
        fetch: (async () => new Response(null, { status: 200 })) as FetchLike,
        now: () => "2026-11-10T09:00:00.000Z",
        progress: () => undefined,
      },
    };
    const broken = { ...first.output, payload: { ...first.output.payload, cards: [{ id: "c1", kind: "recall", front: [{ type: "text" }], back: [{ type: "text", text: "A." }], cites: [] }] } as unknown as CardSet };
    const report = await definition.engine.validate(ctx, broken, blueprint);
    expect(report.valid).toBe(false);
    const repaired = await definition.engine.repair(ctx, broken, report, blueprint);
    // The repair answer cites nothing, which is a warning, never a block.
    expect(await definition.engine.validate(ctx, repaired, blueprint)).toEqual({
      valid: true,
      issues: [expect.objectContaining({ code: "uncited_card", severity: "warning" })],
    });
  });

  it("needs at least one source", async () => {
    await expect(run({ sources: [] })).rejects.toThrow("at least one source");
  });
});

describe("registration", () => {
  it("registers one flashcards format that its old ids resolve to, made by Open Sourcebook's own writer", () => {
    const definition = createFlashcardsDefinition();
    const registry = new FormatRegistry().register(definition);
    expect(registry.ready()).toEqual(["flashcards"]);
    expect(registry.require("flashcards").engine.type).toBe("flashcards");
    expect(registry.require("flashcards").engine.schemaVersion).toBe(3);
    for (const old of ["byte", "bits", "read"]) expect(registry.resolve(old)).toBe("flashcards");
    expect(registry.require("byte").maxRepairRounds).toBe(2);
  });

  it("estimates cost from the number of cards and the source size, and flags it unpriced when no price is set", () => {
    const priced = createFlashcardsDefinition({ price: { inputPerMillion: 1, outputPerMillion: 4 } });
    const cost = (cards: number, sourceChars: number, sourceCount = 1) => priced.estimateCost({ settings: settingsOf({ cards }), sourceChars, sourceCount });
    const small = cost(8, 4_000);
    const large = cost(40, 120_000, 2);
    expect(small.usd).toBeGreaterThan(0);
    // Sections of a long source read their own share of it, not all of it each.
    expect(large.usd).toBeGreaterThan(small.usd! * 3);
    expect(small.basis).toMatch(/^light depth, ~4 sections, 7 calls, ~\d+k tokens$/);
    expect(large.basis).toMatch(/^deep depth, ~13 sections, reads 100% of 120k characters, 22 calls/);
    // A count fit to the sources is sized by them.
    expect(cost(0, 40_000).basis).toMatch(/^veryDeep/);
    expect(cost(8, 0)).toMatchObject({ usd: 0 });

    // Sanity check against the first real run (deepseek-v4-flash, 24,000-character
    // sources): a small set's writing cost about $0.04 and one medium attempt
    // about $0.08. The estimate should land near, not match to the cent.
    const flash = createFlashcardsDefinition({ price: { inputPerMillion: 0.3, outputPerMillion: 1.2 } });
    const light = flash.estimateCost({ settings: settingsOf({ cards: 8 }), sourceChars: 24_000, sourceCount: 1 }).usd!;
    const medium = flash.estimateCost({ settings: settingsOf({ cards: 20 }), sourceChars: 24_000, sourceCount: 1 }).usd!;
    expect(light).toBeGreaterThan(0.02);
    expect(light).toBeLessThan(0.08);
    expect(medium).toBeGreaterThan(0.04);
    expect(medium).toBeLessThan(0.16);

    const unpriced = createFlashcardsDefinition().estimateCost({ settings: settingsOf({ cards: 8 }), sourceChars: 4_000, sourceCount: 1 });
    expect(unpriced.usd).toBeUndefined();
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.basis).toContain("no model price set");
  });
});

describe("tags", () => {
  const setOf = (blocks: unknown[]) => setWithCards([{ kind: "explain", front: blocks as CardBlock[] }]);

  it("enriches tags deterministically from type, domain, and content keywords", () => {
    const paper = setOf([{ type: "text", text: "We train large language models on curated data." }]);
    paper.sourceKind = "paper";
    paper.sourceDomain = "arxiv.org";
    paper.tags = ["PAPER", "preprint"];
    expect(enrichTags(paper, { ...source, kind: "pdf", sourceDomain: "arxiv.org" })).toEqual(["paper", "arxiv", "ai", "preprint"]);
  });

  it("keeps model tags after derived ones, dedupes case-insensitively, and caps at eight", () => {
    const set = setOf([{ type: "text", text: "Plain prose without signals." }]);
    set.sourceDomain = "Example.COM";
    set.tags = ["One", "two", "THREE", "four", "five", "six", "seven", "eight", "nine", "one"];
    expect(enrichTags(set, { ...source, sourceDomain: "example.com" })).toEqual(["example.com", "One", "two", "THREE", "four", "five", "six", "seven"]);
  });

  it("tags recipes as cooking and strips a leading www from domains", () => {
    const set = setOf([{ type: "text", text: "Fold the flour into the eggs." }]);
    set.sourceKind = "recipe";
    set.tags = [];
    expect(enrichTags(set, { ...source, sourceDomain: "www.bbcgoodfood.com" })).toEqual(["cooking", "bbcgoodfood.com"]);
  });

  it("tags a video set only when it carries clips", () => {
    const withClips = setOf([{ type: "clip", url: "https://www.youtube.com/watch?v=abc123", startSeconds: 1, endSeconds: 9 }]);
    withClips.sourceKind = "video";
    withClips.tags = [];
    expect(enrichTags(withClips, source)).toEqual(["video"]);
    const withoutClips = setOf([{ type: "text", text: "A calm summary of the talk." }]);
    withoutClips.sourceKind = "video";
    withoutClips.tags = [];
    expect(enrichTags(withoutClips, source)).toEqual([]);
  });
});

describe("normalizeMetricsStats", () => {
  it("assigns ids and folds detail into delta", () => {
    const blocks = [
      { type: "metrics", stats: [{ label: "BLEU", value: "28.4", detail: "+2.0 vs prior" }, { id: "kept", label: "Params", value: "65M" }] },
      { type: "reveal", title: "More", blocks: [{ type: "metrics", stats: [{ label: "x", value: "1", detail: "d" }] }] },
    ] as never;
    normalizeMetricsStats(blocks);
    const stats = (blocks[0] as { stats: Array<Record<string, unknown>> }).stats;
    expect(stats[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stats[0].delta).toBe("+2.0 vs prior");
    expect(stats[0].detail).toBeUndefined();
    expect(stats[1].id).toBe("kept");
    expect((blocks[1] as { blocks: Array<{ stats: Array<Record<string, unknown>> }> }).blocks[0].stats[0].delta).toBe("d");
  });
});

describe("section labels", () => {
  it("drops a heading that only repeats the card's section, since players show the section above it", async () => {
    const provider = scriptedProvider({
      plan: () => planOf([{ id: "main", title: "Four technologies, one system" }]),
      section: () => ({
        sectionID: "main",
        cards: [
          { kind: "recall", front: [{ type: "heading", text: "Four Technologies — one system" }, { type: "text", text: "What does the source teach?" }], back: [{ type: "text", text: "One compact concept." }], cites: [{ passage: "P1", quote: "one compact concept", block: 2 }] },
          { kind: "recall", front: [{ type: "heading", text: "A market waiting for books" }, { type: "text", text: "Two?" }], back: [{ type: "text", text: "Two." }], cites: [{ passage: "P1" }] },
        ],
      }),
    });
    const result = await run({ provider });
    expect(result.set.cards[0].front).toEqual([{ type: "text", text: "What does the source teach?" }]);
    expect(result.set.cards[0].cites[0]).toMatchObject({ quote: "one compact concept", block: 1 });
    expect(result.set.cards[1].front[0]).toEqual({ type: "heading", text: "A market waiting for books" });
    expect(provider.calls.find((call) => call.task === "section")!.userPrompt).toContain("never repeat it as a heading");
  });
});

describe("inline marks", () => {
  it("drops marks from kickers and headings and keeps them in body text", () => {
    const blocks = [
      { type: "heading", text: "The **sequential** bottleneck" },
      { type: "kicker", text: "*Why* it matters" },
      { type: "text", text: "Printed on **paper** at 2 * 3 sheets" },
    ] as never[];
    stripMarksFromPlainText(blocks);
    expect(blocks).toEqual([
      { type: "heading", text: "The sequential bottleneck" },
      { type: "kicker", text: "Why it matters" },
      { type: "text", text: "Printed on **paper** at 2 * 3 sheets" },
    ]);
  });
});
