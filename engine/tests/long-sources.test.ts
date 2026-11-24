/**
 * Long sources read whole (engine/docs/long-sources.md), with the scripted
 * provider and a long source made in the test: a set of flashcards over the
 * whole source reads all of it, a range reads exactly that range, and
 * estimates grow with what is read.
 */
import { describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import type { CardSet } from "../src/cards/contract";
import { createFlashcardsDefinition } from "../src/engines/flashcards/definition";
import { createQuizDefinition, parseQuizSettings, type QuizSettings } from "../src/engines/quiz/definition";
import type { ApiFlashcardsBlueprint } from "../src/engines/flashcards/engine";
import type { FlashcardSettings } from "../src/engines/flashcards/settings";
import { InMemoryUsageSink } from "../src/providers/usage";
import { buildPassages, cutNotes } from "../src/sources/passages";
import { runEngine } from "../src/studio/registry";
import type { EngineContext, NodeSource } from "../src/studio/types";
import type { FetchLike, StructuredGenerationRequest, StructuredProvider } from "../src/types";
import { factOf, longEnvelope, longNodeSource, longText } from "./support/long-source";
import { createTestEngine, FakeExtractor } from "./support/engine-harness";
import { capSourceText, MAX_SOURCE_CHARS, resolveExtractionOptions } from "../src/extract/context";
import { chunkText } from "../src/sources/chunk";
import { pickPassages } from "../src/chat/retrieval";
import { scripted } from "./support/quiz-script";

const passing = { checked: [], failures: [], warnings: [], mediaChecked: 0, chartErrors: [], valid: true };

/** The passages a prompt shows, by label. */
function shownPassages(prompt: string): Map<string, string> {
  const shown = new Map<string, string>();
  const pieces = prompt.split(/\n\[(P\d+)\] [^\n]*\n/);
  for (let index = 1; index < pieces.length; index += 2) shown.set(pieces[index], pieces[index + 1]);
  return shown;
}

/** The part numbers whose fact a text contains. */
function factsIn(text: string): number[] {
  return [...text.matchAll(/The marker for part (\d+) is/g)].map((match) => Number(match[1]));
}

interface Script {
  sections: Array<{ id: string; passages?: string | string[] }>;
}

/**
 * Plans the given sections; each section writes one card per fact it was
 * shown (quoting the fact on its back) or, with none, one card quoting its
 * first passage.
 */
function writer(script: Script): StructuredProvider & { calls: StructuredGenerationRequest[] } {
  const calls: StructuredGenerationRequest[] = [];
  return {
    name: "scripted",
    calls,
    async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
      calls.push(request);
      const prompt = request.userPrompt;
      if (prompt.includes("Plan the sections")) {
        return {
          type: "note",
          title: "A long source",
          subtitle: "Source",
          tags: [],
          sections: script.sections.map((section) => ({ id: section.id, title: section.id, purpose: `Teach ${section.id}`, suggestedBlocks: ["text"], ...(section.passages ? { passages: section.passages } : {}) })),
        } as T;
      }
      const sectionID = /Write only section ([\w-]+)/.exec(prompt)?.[1];
      if (sectionID) {
        const shown = [...shownPassages(prompt)];
        const cards = shown
          .flatMap(([label, text]) =>
            factsIn(text)
              .slice(0, 1)
              .map((n) => ({ kind: "recall", front: [{ type: "text", text: `What does part ${n} name?` }], back: [{ type: "text", text: `Part ${n} has a marker.` }], cites: [{ passage: label, quote: factOf(n), block: 1 }] })),
          )
          .slice(0, 6);
        const [label, text] = shown[0];
        return { sectionID, cards: cards.length > 0 ? cards : [{ kind: "explain", front: [{ type: "text", text: "Some matter." }], cites: [{ passage: label, quote: text.slice(0, 30), block: 0 }] }] } as T;
      }
      throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    },
  };
}

const researched: string[] = [];

/** A large set (40 cards) reads all of a long source; a small one (8) skims it. */
async function makeSet(nodeSources: NodeSource[], provider: StructuredProvider, cards = 40) {
  const definition = createFlashcardsDefinition({
    sleep: async () => undefined,
    verify: async () => passing,
    research: async (source) => {
      researched.push(source.text);
      return { claims: [], references: [] } as never;
    },
  });
  const parsed = definition.parseSettings({ cards });
  if (!parsed.ok) throw new Error("settings");
  const blueprints: ApiFlashcardsBlueprint[] = [];
  const ctx: EngineContext<FlashcardSettings> = {
    jobId: "job-long",
    node: { id: "node-1", type: "flashcards", title: "Node", prompt: "", settings: parsed.settings },
    sources: nodeSources,
    assumes: [],
    inputs: [],
    services: {
      provider,
      assets: createNullAssetStore(),
      usage: new InMemoryUsageSink(),
      fetch: (async () => new Response(null, { status: 200 })) as FetchLike,
      now: () => "2026-11-13T09:00:00.000Z",
      progress: () => undefined,
    },
  };
  const result = await runEngine(definition, ctx, { onBlueprint: (blueprint) => void blueprints.push(blueprint.made as ApiFlashcardsBlueprint) });
  return { ...result, set: result.output.payload as CardSet, blueprint: blueprints[0] };
}

describe("a set over a whole long source", () => {
  const book = longNodeSource({ chars: 400_000 });
  const passages = buildPassages([book]);
  const parts = Math.max(...factsIn(book.envelope.text));

  it("plans from a map, gives every passage to a section, and writes each section from its own part", async () => {
    // The planner names ranges for two sections and leaves the rest to the engine.
    const provider = writer({
      sections: [
        { id: "opening", passages: "P1-P20" },
        ...Array.from({ length: 14 }, (_, n) => ({ id: `s${n + 1}` })),
        { id: "ending", passages: [`P${passages.length - 9}-P${passages.length}`] },
      ],
    });
    const { set, blueprint, report } = await makeSet([book], provider);
    expect(report.valid).toBe(true);

    // Research read a spread of the source, not all of it.
    expect(researched.at(-1)!.length).toBeLessThanOrEqual(24_500);
    expect(factsIn(researched.at(-1)!).length).toBeGreaterThan(3);

    // The plan read a map of the whole source, not its passages.
    const plan = provider.calls.find((call) => call.userPrompt.includes("Plan the sections"))!.userPrompt;
    expect(plan).toContain("This is a map of all of it");
    expect(plan).toContain(`${passages[passages.length - 1].label} (`);
    expect(shownPassages(plan).size).toBe(0);
    expect(plan.length).toBeLessThan(60_000);

    // Together the sections cover every passage once, in order, and the named ranges are kept.
    const assigned = blueprint.structure!.sections.flatMap((section) => section.passages ?? []);
    expect(assigned).toEqual(passages.map((passage) => passage.id));
    expect(blueprint.structure!.sections[0].passages).toEqual(passages.slice(0, 20).map((passage) => passage.id));
    expect(blueprint.structure!.sections.at(-1)!.passages).toEqual(passages.slice(-10).map((passage) => passage.id));

    // Each section call read its own part and no more than a call reads.
    const sectionCalls = provider.calls.filter((call) => call.userPrompt.includes("Write only section"));
    expect(sectionCalls).toHaveLength(16);
    for (const call of sectionCalls) {
      const shown = [...shownPassages(call.userPrompt).values()].join("");
      expect(shown.length).toBeLessThanOrEqual(24_500);
    }

    // The set draws on all of the source: facts from the start, the middle and the very end.
    const cited = new Set(set.cards.flatMap((card) => card.cites.flatMap((cite) => factsIn(cite.quote ?? ""))));
    expect(cited.has(1)).toBe(true);
    expect(cited.has(Math.round(parts / 2)) || cited.has(Math.round(parts / 2) + 1) || cited.has(Math.round(parts / 2) - 1)).toBe(true);
    expect(cited.has(parts)).toBe(true);
    const tenths = new Set([...cited].map((n) => Math.floor(((n - 1) / parts) * 10)));
    expect(tenths.size).toBe(10);

    // A late cite points at the exact late chunk, and its quote is in that chunk word for word.
    const late = set.cards.flatMap((card) => card.cites).find((cite) => cite.quote === factOf(parts))!;
    const chunk = book.chunks.find((candidate) => candidate.id === late.chunkId)!;
    expect(chunk.text).toContain(late.quote);
    expect(chunk.ord).toBeGreaterThan(book.chunks.length * 0.95);
    expect(book.envelope.text.slice(late.locator!.charStart, late.locator!.charEnd)).toBe(chunk.text);
  });

  it("gives a section with a very long range a spread of it and says so", async () => {
    const provider = writer({ sections: [{ id: "all", passages: `P1-P${passages.length}` }] });
    const { set, report } = await makeSet([book], provider, 8);
    expect(report.valid).toBe(true);
    const call = provider.calls.find((entry) => entry.userPrompt.includes("Write only section"))!.userPrompt;
    expect(call).toContain("are a sample taken evenly across the");
    const at = [...shownPassages(call).keys()].map((label) => Number(label.slice(1)));
    expect(at[0]).toBe(1);
    expect(at.at(-1)).toBe(passages.length);
    const tenths = new Set(at.map((n) => Math.floor(((n - 1) / passages.length) * 10)));
    expect(tenths.size).toBe(10);
    expect(set.cards.length).toBeGreaterThan(0);
  });

  it("keeps a short source exactly as before: every section reads every passage, no map", async () => {
    const short = longNodeSource({ chars: 12_000 });
    const provider = writer({ sections: [{ id: "a", passages: "P1-P2" }, { id: "b" }] });
    const { blueprint } = await makeSet([short], provider, 8);
    const plan = provider.calls.find((call) => call.userPrompt.includes("Plan the sections"))!.userPrompt;
    expect(plan).not.toContain("map of all of it");
    expect(shownPassages(plan).size).toBe(buildPassages([short]).length);
    expect(blueprint.structure!.sections.every((section) => section.passages === undefined && section.range === undefined)).toBe(true);
    for (const call of provider.calls.filter((entry) => entry.userPrompt.includes("Write only section"))) {
      expect(shownPassages(call.userPrompt).size).toBe(buildPassages([short]).length);
    }
  });
});

describe("an item with a range of a long source", () => {
  it("reads exactly the passages in its range, and cites them where they are", async () => {
    const whole = longNodeSource({ chars: 400_000 });
    const from = whole.chunks[300].locator!.charStart!;
    const to = whole.chunks[309].locator!.charEnd!;
    const ranged: NodeSource = { ...whole, range: { charStart: from, charEnd: to } };
    const inRange = buildPassages([ranged]);
    expect(inRange.map((passage) => passage.id)).toEqual(whole.chunks.slice(300, 310).map((chunk) => chunk.id));

    const provider = writer({ sections: [{ id: "only" }] });
    const { set, report } = await makeSet([ranged], provider, 8);
    expect(report.valid).toBe(true);
    const expected = new Set(factsIn(inRange.map((passage) => passage.text).join("\n")));
    for (const call of provider.calls) {
      for (const text of shownPassages(call.userPrompt).values()) {
        for (const n of factsIn(text)) expect(expected.has(n)).toBe(true);
      }
    }
    const cites = set.cards.flatMap((card) => card.cites);
    expect(cites.length).toBeGreaterThan(0);
    for (const cite of cites) expect(whole.chunks.slice(300, 310).map((chunk) => chunk.id)).toContain(cite.chunkId);
  });

  it("reads exactly the pages asked for when the source has pages", () => {
    const paged = longNodeSource({ chars: 120_000, pages: true, partChars: 3_000 });
    const pages = buildPassages([{ ...paged, range: { page: 30, endPage: 32 } }]);
    expect(new Set(pages.map((passage) => passage.locator?.page))).toEqual(new Set([30, 31, 32]));
    expect(pages.flatMap((passage) => factsIn(passage.text))).toEqual([30, 31, 32]);
  });
});

describe("what a set over a long source is estimated to cost", () => {
  const priced = createFlashcardsDefinition({ price: { inputPerMillion: 0.3, outputPerMillion: 1.2 } });
  const cost = (cards: number, sourceChars: number) => priced.estimateCost({ settings: { cards, kinds: [], exemplarSummaries: [] }, sourceChars, sourceCount: 1 });

  it("grows with how much of the source the item reads", () => {
    const page = cost(40, 3_000).usd!;
    const paper = cost(40, 24_000).usd!;
    const book = cost(40, 400_000).usd!;
    expect(paper).toBeGreaterThan(page);
    // A large set over a whole book reads all of it: priced well above a paper, never like a page.
    expect(book).toBeGreaterThan(paper * 1.8);
    expect(book).toBeGreaterThan(page * 2.5);
    expect(cost(40, 400_000).basis).toMatch(/~34 sections, reads 100% of 400k characters/);
    // A small set over the same book skims it and says how much it reads.
    expect(cost(8, 400_000).usd!).toBeLessThan(book);
    expect(cost(8, 400_000).basis).toMatch(/reads 24% of 400k characters/);
    // An item over a range of the book is priced by the range.
    expect(cost(40, 30_000).usd!).toBeLessThan(book / 2);
  });
});

describe("a quiz across a long source", () => {
  it("plans from passages spread across the whole source and cites late passages exactly", async () => {
    const book = longNodeSource({ chars: 400_000 });
    const all = buildPassages([book]);
    const usage = new InMemoryUsageSink();
    let planPrompt = "";
    const { provider, ofStep } = scripted(usage, {
      plan: (request) => {
        planPrompt = request.userPrompt;
        // One target per shown passage that states a fact, as a planner told to spread its questions would.
        const withFacts = [...shownPassages(request.userPrompt)].filter(([, text]) => factsIn(text).length > 0);
        const picked = withFacts.filter((_, index) => index % Math.ceil(withFacts.length / 10) === 0);
        return {
          title: "Markers",
          targets: picked.map(([label, text]) => ({ topic: `Part ${factsIn(text)[0]}`, objective: `The marker of part ${factsIn(text)[0]}`, kind: "choice", passages: [label] })),
        };
      },
      write: (request) => {
        const shown = shownPassages(request.userPrompt);
        const targets = [...request.userPrompt.matchAll(/^- (t\d+) \[[^\]]*\] topic "[^"]*": .*\(passages (P\d+)\)$/gm)];
        return {
          questions: targets.map(([, ref, label]) => {
            const n = factsIn(shown.get(label)!)[0];
            return {
              target: ref,
              topic: `Part ${n}`,
              prompt: `What is the marker for part ${n}?`,
              options: [`tern${n}quill`, `tern${n + 1}reed`, `tern${n + 2}stone`],
              answer: 0,
              feedback: { correct: `It is tern${n}quill.`, incorrect: `Part ${n} names tern${n}quill.` },
              cites: [{ passage: label, quote: factOf(n) }],
            };
          }),
        };
      },
    });
    const definition = createQuizDefinition({ sleep: async () => undefined, maxProviderAttempts: 2 });
    const parsed = parseQuizSettings({});
    if (!parsed.ok) throw new Error("settings");
    const ctx: EngineContext<QuizSettings> = {
      jobId: "job-quiz",
      node: { id: "node-q", type: "quiz", title: "Quiz", prompt: "Quiz the whole source.", settings: parsed.settings },
      sources: [book],
      assumes: [],
      inputs: [],
      services: { provider, assets: createNullAssetStore(), usage, fetch: async () => new Response(null), now: () => "2026-11-13T09:00:00.000Z", progress: () => undefined },
    };
    const result = await runEngine(definition, ctx);
    expect(result.report.valid).toBe(true);

    // The planner saw a sample from the start to the very end, within its budget, and was told it is a sample.
    const shown = [...shownPassages(planPrompt).keys()].map((label) => Number(label.slice(1)));
    expect(shown[0]).toBe(1);
    expect(shown.at(-1)).toBe(all.length);
    expect(new Set(shown.map((n) => Math.floor(((n - 1) / all.length) * 10))).size).toBe(10);
    expect([...shownPassages(planPrompt).values()].join("").length).toBeLessThanOrEqual(48_500);
    expect(planPrompt).toContain(`of ${all.length}, taken evenly across everything this quiz covers`);
    expect(result.report.issues.map((issue) => issue.code)).toContain("passages_omitted");

    // Questions test the whole source, and each cite is the exact late or early chunk, quoted word for word.
    const parts = Math.max(...factsIn(book.envelope.text));
    const tested = result.output.payload.questions.flatMap((question) => question.cites.flatMap((cite) => factsIn(cite.quote ?? "")));
    expect(Math.min(...tested)).toBeLessThan(parts * 0.15);
    expect(Math.max(...tested)).toBeGreaterThan(parts * 0.85);
    for (const question of result.output.payload.questions) {
      for (const cite of question.cites) {
        const chunk = book.chunks.find((candidate) => candidate.id === cite.chunkId)!;
        expect(chunk.text).toContain(cite.quote);
      }
    }
    // Writing read only the tested passages.
    for (const call of ofStep("write")) expect([...shownPassages(call.userPrompt).values()].join("").length).toBeLessThan(12_000);
  });

  it("is estimated by what its plan reads, not by the whole source", () => {
    const priced = createQuizDefinition({ price: { inputPerMillion: 0.3, outputPerMillion: 1.2 } });
    const parsed = parseQuizSettings({ questions: 10 });
    if (!parsed.ok) throw new Error("settings");
    const cost = (sourceChars: number) => priced.estimateCost({ settings: parsed.settings, sourceChars, sourceCount: 1 }).usd!;
    expect(cost(48_000)).toBeGreaterThan(cost(12_000));
    // Past the plan's budget the plan reads a spread, so a book costs what that budget costs.
    expect(cost(400_000)).toBe(cost(48_000));
  });
});

describe("storing a long source", () => {
  const url = "https://example.com/book";

  it("keeps the whole text and every chunk, located, up to the bound", async () => {
    const text = longText({ chars: 390_000 });
    const engine = createTestEngine({ extractor: new FakeExtractor({ [url]: { text } }) });
    const { sources } = engine.deps;
    const added = await sources.add({ ownerId: "owner", url });
    const extracted = await sources.ensureExtracted(added.source);
    expect(extracted.envelope.text).toBe(text);
    expect(extracted.envelope.limitations).toEqual([]);
    expect(extracted.chunks.length).toBeGreaterThan(300);
    expect(extracted.chunks.map((chunk) => chunk.text).join("\n\n")).toBe(text);
    const last = extracted.chunks.at(-1)!;
    expect(text.slice(last.locator!.charStart, last.locator!.charEnd)).toBe(last.text);
    // Ids are written once and read back the same.
    const again = await sources.ensureExtracted(added.source);
    expect(again.chunks.map((chunk) => chunk.id)).toEqual(extracted.chunks.map((chunk) => chunk.id));
  });

  it("takes pasted text up to the same bound and refuses more", async () => {
    const { sources } = createTestEngine().deps;
    const text = longText({ chars: 395_000 }).slice(0, MAX_SOURCE_CHARS);
    const added = await sources.add({ ownerId: "owner", text });
    const extracted = await sources.ensureExtracted(added.source);
    expect(extracted.envelope.text).toBe(text);
    await expect(sources.add({ ownerId: "owner", text: "x".repeat(MAX_SOURCE_CHARS + 1) })).rejects.toMatchObject({ code: "source_too_large" });
  });

  it("cuts a source above the bound once, at a sentence end, and says how much is used", () => {
    expect(resolveExtractionOptions()).toMatchObject({ maxTextChars: 400_000, readTextChars: 1_000_000 });
    const text = longText({ chars: 600_000 });
    const cut = capSourceText({ ...longEnvelope({ chars: 1 }), text }, MAX_SOURCE_CHARS, 1_000_000);
    expect(cut.text.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
    expect(cut.text.length).toBeGreaterThan(MAX_SOURCE_CHARS * 0.8);
    expect(cut.text.endsWith(".")).toBe(true);
    expect(cut.limitations.at(-1)).toMatch(new RegExp(`^Only the first ${cut.text.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters of this source are used \\(about \\d+%\\)`));
    expect(cut.metadata).toMatchObject({ textCut: "true", textChars: String(text.length), textUsedChars: String(cut.text.length) });
  });

  it("leaves a source stored before as it was: cut, marked, not read again", async () => {
    const extractor = new FakeExtractor({ [url]: { text: "should not be read" } });
    const engine = createTestEngine({ extractor });
    const { sources, repos } = engine.deps;
    const added = await sources.add({ ownerId: "owner", url });
    // What the 24,000-character cut stored.
    const old = { ...longEnvelope({ chars: 24_000 }), limitations: ["Only the first 23,891 of 81,370 characters of this source are used (about 29%); the rest is not read by anything made from it."], metadata: { textChars: "81370", textUsedChars: "23891", textCut: "true" } };
    await repos.sources.updateExtraction(added.source.contentHash, { status: "ready", accessLevel: "full", envelope: old });
    await repos.sources.replaceChunks(added.source.contentHash, chunkText(old.text));
    const extracted = await sources.ensureExtracted(added.source);
    expect(extractor.calls).toHaveLength(0);
    expect(extracted.extracted).toBe(false);
    expect(extracted.envelope.limitations).toEqual(old.limitations);
    // Its writers are still told the passages are only part of it.
    expect(cutNotes([{ sourceId: added.source.id, envelope: extracted.envelope, chunks: extracted.chunks }])[0]).toContain("only the first 23,891 of 81,370 characters");
  });
});

describe("the chat over a long source", () => {
  it("finds an answer that sits at the very end", () => {
    const book = longNodeSource({ chars: 400_000 });
    const parts = Math.max(...factsIn(book.envelope.text));
    const pick = pickPassages([book], `What is the marker for part ${parts}?`, 12_000);
    expect(pick.total).toBe(book.chunks.length);
    const found = pick.passages.find((passage) => passage.text.includes(factOf(parts)));
    expect(found).toBeDefined();
    expect(book.chunks.find((chunk) => chunk.id === found!.chunkId)!.ord).toBeGreaterThan(book.chunks.length * 0.95);
  });
});
