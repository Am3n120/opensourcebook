import { describe, expect, it } from "vitest";
import { BLOCKS_NOT_ON_A_CARD, SIDE_BUDGET } from "../src/cards/contract";
import { cardKinds } from "../src/cards/kinds";
import { blockCatalog } from "../src/cards/shapes";
import {
  buildAssetManifestGuidance,
  buildCardRepairPrompt,
  buildCardRules,
  buildDeliverySystemPrompt,
  buildMetadataFromSource,
  buildSectionPrompt,
  buildSourceBlockGuidance,
  buildStructurePrompt,
  type CardTarget,
} from "../src/engines/flashcards/prompts";
import type { SourceEnvelope } from "../src/types";

const source: SourceEnvelope = {
  originalText: "Docs text with a fenced code example.",
  kind: "web",
  text: "Docs text with a fenced code example.",
  references: [],
  metadata: {},
  accessLevel: "full",
  depthCap: "deep",
  limitations: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

const plan = {
  type: "article" as const,
  title: "T",
  subtitle: "S",
  tags: [],
  sections: [{ id: "main", title: "Main", purpose: "Recall the main point", suggestedBlocks: ["recall"] }],
};

const every: CardTarget = { cards: 12, asked: true, kinds: cardKinds.ids() };

describe("what every call is told", () => {
  it("the system prompt forbids fenced code and markdown headings inside bodies", () => {
    const prompt = buildDeliverySystemPrompt();
    expect(prompt).toContain("triple-backtick");
    expect(prompt).toContain('"type":"code"');
    expect(prompt).toContain("heading block");
    expect(prompt).toContain("background block");
  });

  it("every writing prompt describes cards from the set's own contract", () => {
    const prompts = [
      buildStructurePrompt(source, "medium", every, undefined),
      buildSectionPrompt(source, plan, "main", every, undefined),
      buildCardRepairPrompt({ kind: "recall", front: [], cites: [] }, [], source, every.kinds),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("One job per card");
      expect(prompt).toContain("retrieve, not recognise");
      expect(prompt).toContain("short enough to check yourself against");
      expect(prompt).toContain(`at most ${SIDE_BUDGET} units`);
      expect(prompt).toContain("counted over the front and then the back");
      expect(prompt).toContain("background block");
      expect(prompt).toContain(blockCatalog());
      expect(prompt).toContain(cardKinds.catalog());
      for (const type of BLOCKS_NOT_ON_A_CARD) expect(prompt).toContain(type);
      // Nothing of the format this replaced.
      expect(prompt).not.toMatch(/\bbits?\b|\bbyte\b/);
    }
  });

  it("names only the kinds the item takes, from the registry", () => {
    const rules = buildCardRules(["recall", "cloze"]);
    expect(rules).toContain(cardKinds.catalog(["recall", "cloze"]));
    expect(rules).not.toContain("- explain (");
    expect(rules).not.toContain("- ask (");
    // An unknown or empty list means every kind.
    expect(buildCardRules([])).toContain(cardKinds.catalog());
    expect(buildCardRules(["nonsense"])).toContain(cardKinds.catalog());
    const section = buildSectionPrompt(source, plan, "main", { cards: 4, asked: true, kinds: ["cloze"] }, undefined);
    expect(section).toContain('"cards":[{"kind":"cloze"');
  });

  it("documents the generic web oEmbed block rule", () => {
    const prompt = buildStructurePrompt({ ...source, metadata: { extraction: "readability+oembed", oembedJSON: JSON.stringify({ type: "rich", version: "1.0", html: "<iframe></iframe>" }) } }, "light", every, undefined);
    expect(prompt).toContain("platform web");
    expect(prompt).toContain("exact HTML string");
  });
});

describe("the size of the set", () => {
  it("gives the planner the number the person asked for, and never asks it to pad", () => {
    const prompt = buildStructurePrompt(source, "medium", { cards: 24, asked: true, kinds: every.kinds }, undefined);
    expect(prompt).toContain("Plan the sections of a set of flashcards");
    expect(prompt).toContain("The set has 24 cards: the number the person asked for.");
    expect(prompt).toContain("never pad");
  });

  it("gives a count fit to the sources as a guess, not a quota", () => {
    const prompt = buildStructurePrompt(source, "light", { cards: 8, asked: false, kinds: every.kinds }, undefined);
    expect(prompt).toContain("About 8 cards fits sources of this size");
    expect(prompt).not.toContain("the number the person asked for");
  });

  it("gives a section writer its share of the set", () => {
    const prompt = buildSectionPrompt(source, plan, "main", { cards: 30, asked: true, kinds: every.kinds, section: 6 }, undefined);
    expect(prompt).toContain("Write only section main of a set of flashcards");
    expect(prompt).toContain("About 6 cards for this section (the set has 30 in all)");
    expect(prompt).toContain('Return JSON {"sectionID":"main","cards":[{"kind":"recall","front":[...],"back":[...],"cites":[{"passage":"P1","quote":"...","block":1}]}]}');
    expect(prompt).toContain("never repeat it as a heading");
  });
});

describe("passages and repair", () => {
  it("sends the source as labelled passages to cite, and its text only once", () => {
    const passages = [{ id: "c1", label: "P1", sourceId: "s1", chunkId: "c1", text: "Docs text with a fenced code example." }];
    const prompt = buildSectionPrompt(source, plan, "main", every, undefined, [], {}, { passages });
    expect(prompt).toContain("[P1]");
    expect(prompt.split("Docs text with a fenced code example.")).toHaveLength(2);
    expect(prompt).toContain('{"passage":"P3"}');
  });

  it("gives a card's repair only that card, its errors and the passages it cites", () => {
    const card = { kind: "recall", front: [{ type: "text", text: "Broken?" }], back: [{ type: "text", text: "Fixed." }], cites: [{ passage: "P2" }] };
    const passages = [{ id: "c2", label: "P2", sourceId: "s", text: "Only this passage." }];
    const prompt = buildCardRepairPrompt(card, [{ path: "back", code: "side_over_budget", message: "split" }], source, ["recall"], { passages }, { section: "Intro", before: "What is it?" });
    expect(prompt).toContain('"path":"back"');
    expect(prompt).toContain(JSON.stringify(card));
    expect(prompt).toContain("Only this passage.");
    expect(prompt).toContain('It is in the section "Intro".');
    expect(prompt).toContain("The card before it asks: What is it?");
    expect(prompt).toContain('Return JSON {"cards":[...]}');
    expect(prompt).toContain("Repair this card");
  });
});

describe("source guidance", () => {
  it("asks each kind of source for cards on what it holds", () => {
    expect(buildSourceBlockGuidance({ ...source, kind: "paper" })).toContain("findings with their real numbers");
    expect(buildSourceBlockGuidance({ ...source, kind: "recipe" })).toContain("steps card");
    // Blocks that never sit on a card are not asked for.
    for (const kind of ["recipe", "paper", "spreadsheet", "web", "youtube"] as const) {
      const guidance = buildSourceBlockGuidance({ ...source, kind });
      for (const type of ["servingsScaler", "timer", "flashcards", "reveal"]) expect(guidance).not.toContain(type);
    }
  });

  it("lists harvested assets and says a picture appears once in the set", () => {
    const manifest = buildAssetManifestGuidance({ ...source, assets: [{ id: "fig1", kind: "figure", url: "/v1/assets/fig1", caption: "Diagram", page: 3, contentType: "image/png" }] });
    expect(manifest).toContain("[asset] kind=figure page=3 url=/v1/assets/fig1 caption=Diagram");
    expect(manifest).toContain("AT MOST ONE block in the whole set");
    expect(buildAssetManifestGuidance(source)).toBe("");
  });

  it("derives fallback metadata from the source", () => {
    expect(buildMetadataFromSource({ ...source, title: undefined, text: "First line here. Second." }, "article")).toMatchObject({
      type: "article",
      title: "First line here",
      subtitle: "Saved source",
    });
    expect(buildMetadataFromSource({ ...source, kind: "recipe", author: "Ana", sourceDomain: "food.example" }, "note")).toMatchObject({
      type: "recipe",
      subtitle: "Ana · food.example",
    });
  });
});
