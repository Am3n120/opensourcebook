/**
 * The flashcards contract (engine/docs/flashcards.md): the validator, the
 * size of a side, the kinds of card and what each needs, how a card is
 * marked, and the read-time upgrade of stored bytes and pages. The example in
 * the doc itself must validate.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ByteBlock, PagePayload } from "../src/cards/blocks";
import { CARD_SET_SCHEMA_VERSION, SIDE_BUDGET, blockCost, cardBlocks, markOf, sideCost, type Card, type CardSet } from "../src/cards/contract";
import { CardKindRegistry, cardKinds, CARD_KINDS } from "../src/cards/kinds";
import { cardsToPage, isPagePayload, packBits, pageToByte, splitText, toCardSet, type LegacyByte } from "../src/cards/upgrade";
import { validateCardSet } from "../src/cards/validate";
import { upgradeStoredSet } from "../src/engines/flashcards/definition";

type CardInput = Partial<Card> & { front: unknown[] };

function setOf(cards: CardInput[]): CardSet {
  return {
    schemaVersion: 3,
    id: "0f6f2a3e-5a43-4a51-9d1c-3c2b9e1f7a10",
    title: "One-sided limits",
    subtitle: "Week 3 notes",
    sourceKind: "note",
    tags: [],
    cards: cards.map((card, index) => ({
      id: card.id ?? `c${index + 1}`,
      kind: card.kind ?? "recall",
      front: card.front as ByteBlock[],
      ...(card.back ? { back: card.back as ByteBlock[] } : {}),
      cites: card.cites ?? [{ sourceId: "s1", spot: "passage" }],
    })),
  };
}

function codes(value: unknown): string[] {
  return validateCardSet(value).errors.map((error) => `${error.path} ${error.code}`);
}

const q: ByteBlock = { type: "text", text: "What is a one-sided limit?" };
const a: ByteBlock = { type: "text", text: "The value approached from one side only." };
const chart = { type: "barChart", title: "Scores", items: [{ label: "A", value: 1, displayValue: "1" }, { label: "B", value: 2, displayValue: "2" }] } as ByteBlock;
const figure = { type: "figure", url: "/v1/assets/fig1", caption: "A figure" } as ByteBlock;
const table = { type: "table", headers: ["Side", "Left", "Right"], rows: [["From", "below", "above"]] } as ByteBlock;

describe("the contract file", () => {
  it("has an example that validates", () => {
    const doc = readFileSync(new URL("../docs/flashcards.md", import.meta.url), "utf8");
    const example = /## Example[\s\S]*?```json\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(example).toBeDefined();
    const check = validateCardSet(JSON.parse(example!));
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
  });
});

describe("validateCardSet", () => {
  it("accepts a set of one card and of many", () => {
    expect(codes(setOf([{ front: [q], back: [a] }]))).toEqual([]);
    expect(codes(setOf([{ front: [q], back: [a] }, { kind: "cloze", front: [{ type: "cloze", text: "A limit from the [[left]] uses smaller x." }] }]))).toEqual([]);
  });

  it("needs version 3, a UUID, at least one card and unique card ids", () => {
    expect(codes({ ...setOf([{ front: [q], back: [a] }]), schemaVersion: 2 })).toContain("$.schemaVersion enum");
    expect(codes({ ...setOf([{ front: [q], back: [a] }]), id: "nope" })).toContain("$.id uuid");
    expect(codes(setOf([]))).toContain("$.cards min_items");
    expect(codes(setOf([{ id: "c1", front: [q], back: [a] }, { id: "c1", front: [q], back: [a] }]))).toContain("$.cards[1].id duplicate");
  });

  it("knows its kinds from the registry and keeps to the ones an item allows", () => {
    expect(codes(setOf([{ kind: "plain", front: [q] }]))).toContain("$.cards[0].kind unknown_kind");
    const allowed = validateCardSet(setOf([{ front: [q], back: [a] }]), { allowedKinds: ["cloze"] });
    expect(allowed.errors.map((error) => error.code)).toContain("kind_not_allowed");
  });

  it("keeps page layout, decks, reveals and tools off a card", () => {
    for (const block of [{ type: "divider" } as ByteBlock, { type: "flashcards", cards: [{ front: "Q", back: "A" }] }, { type: "reveal", blocks: [a] }, { type: "timer", label: "t", seconds: 3 }] as ByteBlock[]) {
      expect(codes(setOf([{ kind: "explain", front: [q, block] }])).some((code) => code.endsWith("not_on_a_card"))).toBe(true);
    }
  });

  it("allows one main block per side, up to six blocks, within one screen", () => {
    expect(codes(setOf([{ kind: "explain", front: [chart, figure] }]))).toContain("$.cards[0].front too_many_features");
    expect(codes(setOf([{ kind: "compare", front: [q], back: [table, chart] }]))).toContain("$.cards[0].back too_many_features");
    expect(codes(setOf([{ kind: "explain", front: Array.from({ length: 7 }, () => q) }]))).toContain("$.cards[0].front range");
    expect(codes(setOf([{ front: [q], back: [{ type: "text", text: "x".repeat(SIDE_BUDGET + 1) }] }]))).toContain("$.cards[0].back side_over_budget");
  });

  it("checks cites, counting blocks over the front then the back, and warns when a marked card cites nothing", () => {
    expect(codes(setOf([{ front: [q], back: [a], cites: [{ sourceId: "s1", spot: "passage", block: 1 }] }]))).toEqual([]);
    expect(codes(setOf([{ front: [q], back: [a], cites: [{ sourceId: "s1", spot: "passage", block: 2 }] }]))).toContain("$.cards[0].cites[0].block range");
    expect(validateCardSet(setOf([{ front: [q], back: [a], cites: [] }])).warnings.map((w) => w.code)).toEqual(["uncited_card"]);
    expect(validateCardSet(setOf([{ kind: "explain", front: [q], cites: [] }])).warnings).toEqual([]);
  });
});

describe("kinds of card", () => {
  const check = (kind: string, card: Pick<Card, "front" | "back">) => cardKinds.get(kind)!.check(card);

  it("are each one entry with words for a person and an example that passes its own check", () => {
    expect(cardKinds.ids()).toEqual(CARD_KINDS.map((kind) => kind.id));
    for (const kind of cardKinds.list()) {
      expect(kind.label.trim()).not.toBe("");
      expect(kind.description.trim()).not.toBe("");
      const example = setOf([{ kind: kind.id, ...(kind.example as { front: unknown[]; back?: unknown[] }) } as CardInput]);
      expect(codes(example), kind.id).toEqual([]);
      expect(markOf(kind.example as unknown as Card), kind.id).toBe(kind.mark);
    }
  });

  it("say what a card of theirs is missing", () => {
    expect(check("recall", { front: [q] as ByteBlock[] })[0]).toMatch(/give it a back/);
    expect(check("cloze", { front: [q] as ByteBlock[] })[0]).toMatch(/exactly one cloze/);
    expect(check("compare", { front: [q], back: [a] } as never).join(" ")).toMatch(/comparison/);
    expect(check("steps", { front: [q], back: [a] } as never).join(" ")).toMatch(/steps in order/);
    expect(check("formula", { front: [q], back: [a] } as never).join(" ")).toMatch(/formula/);
    expect(check("picture", { front: [q], back: [a] } as never).join(" ")).toMatch(/picture from the source/);
    expect(check("ask", { front: [q] } as never)[0]).toMatch(/exactly one block that asks/);
    expect(check("explain", { front: [q], back: [a] } as never)[0]).toMatch(/only shows/);
  });

  it("take a new kind as one entry, offered in its own words", () => {
    const kinds = new CardKindRegistry([...CARD_KINDS, { id: "typed", label: "Type the answer", description: "Type the answer before turning over.", mark: "self", example: { front: [{ type: "text", text: "..." }], back: [{ type: "text", text: "..." }] }, check: () => [] }]);
    expect(kinds.options().at(-1)).toEqual({ value: "typed", label: "Type the answer", description: "Type the answer before turning over." });
    expect(kinds.catalog(["typed"])).toMatch(/^- typed \(type the answer\)/);
    expect(validateCardSet(setOf([{ kind: "typed", front: [q], back: [a] }]), { kinds }).errors).toEqual([]);
    expect(() => kinds.register({ ...CARD_KINDS[0]! })).toThrow(/already registered/);
  });

  it("are marked from their sides alone: an answer, the person, or not at all", () => {
    expect(markOf({ front: [q], back: [a] } as never)).toBe("self");
    expect(markOf({ front: [{ type: "cloze", text: "[[x]]" }] } as never)).toBe("self");
    expect(markOf({ front: [{ type: "quiz", question: "?", options: ["a", "b"], correctIndex: 0 }] } as never)).toBe("answer");
    expect(markOf({ front: [q] } as never)).toBe("none");
  });

  it("cloze needs its gap in double brackets", () => {
    expect(codes(setOf([{ kind: "cloze", front: [{ type: "cloze", text: "No gap here" }] }]))).toContain("$.cards[0].front[0].text format");
  });
});

describe("side cost", () => {
  it("counts shown characters, lines and area, never URLs", () => {
    expect(blockCost({ type: "text", text: "short" })).toBe(40);
    expect(blockCost({ type: "numbered", items: ["a", "b", "c"] })).toBe(40 + 2 * 40);
    expect(blockCost(figure)).toBe(40 + 350);
    expect(sideCost([q, a] as ByteBlock[])).toBe(blockCost(q as ByteBlock) + blockCost(a as ByteBlock));
    expect(cardBlocks({ front: [q], back: [a] } as never)).toEqual([q, a]);
  });
});

describe("packBits (cutting an old page into screens)", () => {
  it("starts a screen at each heading and splits at the budget", () => {
    const bits = packBits([{ type: "heading", text: "One" }, { type: "text", text: "First idea." }, { type: "heading", text: "Two" }, chart, figure]);
    expect(bits.map((bit) => bit.blocks.map((block) => block.type))).toEqual([["heading", "text"], ["heading", "barChart"], ["figure"]]);
  });

  it("cuts long text at paragraphs, then sentences, then words", () => {
    expect(splitText("One.\n\nTwo.")).toEqual(["One.\n\nTwo."]);
    const sentences = splitText(`${"A sentence here. ".repeat(60)}`.trim(), 200);
    expect(sentences.every((piece) => piece.length <= 200)).toBe(true);
    const words = splitText("word ".repeat(100).trim(), 50);
    expect(words.every((piece) => piece.length <= 50)).toBe(true);
  });
});

describe("old outputs open as what they were", () => {
  const byte: LegacyByte = {
    schemaVersion: 2,
    id: "123e4567-e89b-42d3-a456-426614174000",
    title: "Limits",
    subtitle: "Notes",
    sourceKind: "note",
    tags: ["maths"],
    depth: "light",
    sizeNote: "Short on purpose.",
    bits: [
      { id: "b1", kind: "plain", section: "Idea", blocks: [{ type: "heading", text: "Approaching" }, { type: "text", text: "A limit is where values head." }], cites: [{ sourceId: "s1", spot: "passage", quote: "values head", block: 1 }] },
      { id: "b2", kind: "flip", blocks: [{ type: "flashcards", cards: [{ front: "Left limit?", back: "From below." }] }], cites: [{ sourceId: "s1", spot: "passage", block: 0 }] },
      { id: "b3", kind: "interactive", blocks: [{ type: "quiz", question: "Which side?", options: ["Left", "Right"], correctIndex: 0, explanation: "Below is left." }], cites: [] },
    ],
  };

  it("a stored byte is served as cards: reading screens are read, a card that flipped turns over, a check asks", () => {
    const set = toCardSet(byte, 2)!;
    expect(set).toMatchObject({ schemaVersion: CARD_SET_SCHEMA_VERSION, id: byte.id, title: "Limits", sizeNote: "Short on purpose.", upgradedFrom: 2 });
    expect(set.cards.map((card) => [card.id, card.kind, markOf(card)])).toEqual([
      ["c1", "explain", "none"],
      ["c2", "recall", "self"],
      ["c3", "ask", "answer"],
    ]);
    expect(set.cards[0]).toMatchObject({ section: "Idea", front: byte.bits[0]!.blocks, cites: byte.bits[0]!.cites });
    expect(set.cards[1]).toMatchObject({ front: [{ type: "text", text: "Left limit?" }], back: [{ type: "text", text: "From below." }] });
    expect(validateCardSet(set).errors).toEqual([]);
    expect("depth" in set || "bits" in set).toBe(false);
  });

  it("the format serves stored bytes and pages upgraded, and leaves a set as it is", () => {
    expect(upgradeStoredSet(byte, 2)?.schemaVersion).toBe(3);
    expect(upgradeStoredSet(setOf([{ front: [q], back: [a] }]), 3)).toBeUndefined();
    expect(upgradeStoredSet({ nothing: true }, 1)).toBeUndefined();
  });

  const page: PagePayload = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    type: "paper",
    title: "Attention",
    subtitle: "arxiv.org",
    timeAgo: "just now",
    tags: ["ai"],
    status: { type: "ready" },
    depth: "standard",
    blocks: [
      { type: "hero", url: "/v1/assets/hero", title: "Header" },
      { type: "toc", items: ["Method", "Results"] },
      { type: "heading", text: "Method" },
      { type: "text", text: "Self-attention only." },
      { type: "flashcards", cards: [{ front: "Q1", back: "A1" }, { front: "Q2", back: "A2" }] },
      { type: "heading", text: "Results" },
      { type: "audio", url: "https://pod.example/ep.mp3", title: "Episode" },
    ],
    byteDepth: "medium",
  };

  it("a stored page is served as cards that validate, the same every time, never changed", () => {
    expect(isPagePayload(page)).toBe(true);
    const before = JSON.stringify(page);
    const set = toCardSet(page, 1)!;
    expect(set.upgradedFrom).toBe(1);
    expect(set.cards.map((card) => card.kind)).toEqual(["explain", "recall", "recall", "explain"]);
    expect(validateCardSet(set).errors).toEqual([]);
    expect(toCardSet(page, 1)).toEqual(set);
    expect(JSON.stringify(page)).toBe(before);
    expect(pageToByte({ ...page, blocks: [] }).bits).toEqual([{ id: "b1", kind: "plain", blocks: [{ type: "heading", text: "Attention" }], cites: [] }]);
  });

  it("a set is laid out as one page for the phone build that only knows pages, gaps shown in bold", () => {
    const set = setOf([{ front: [q], back: [a] }, { kind: "cloze", front: [{ type: "cloze", text: "From the [[left]]." }] }]);
    const laid = cardsToPage(set);
    expect(laid).toMatchObject({ id: set.id, type: "note", status: { type: "ready" } });
    expect(laid.blocks).toEqual([q, a, { type: "text", text: "From the **left**." }]);
  });
});
