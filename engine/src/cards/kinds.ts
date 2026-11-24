/**
 * The kinds of card. A kind is one job a card does for a learner, and owns
 * what that job needs of the card's sides; everything else (blocks fit their
 * shapes, each side fits one screen, cites hold word for word) is the same
 * for every card and checked in validate.ts. The makers' tools, the settings
 * form and the planner describe kinds from this list, never from a list of
 * their own, so a new kind (a card that asks for a typed answer, a picture
 * to label by tapping) is one more entry here, drawn by the web player from
 * the card's sides with nothing per kind.
 *
 * How a card is marked comes from its sides (`markOf` in contract.ts): a
 * card that asks is marked by its answer, a card with a back or a hidden part
 * by the person (got it / not yet), and a card with neither is only read.
 */
import type { SettingOption } from "../studio/types";
import { ASK_BLOCKS, HIDING_BLOCKS, MEDIA_BLOCKS, markOf, type Card, type CardBlock, type CardMark } from "./contract";

export interface CardKind {
  readonly id: string;
  /** Sentence case, for the settings form and the maker. */
  readonly label: string;
  /** What the card is for, in one plain line: for the person choosing kinds, the planner and the maker. */
  readonly description: string;
  /** How the person marks it; the check holds the card to it. */
  readonly mark: CardMark;
  /** One example of its sides, as the maker sends them. Values are placeholders. */
  readonly example: { front: Array<Record<string, unknown>>; back?: Array<Record<string, unknown>> };
  /** What this kind needs of the card, as plain sentences the maker can act on; empty when it is right. */
  check(card: Pick<Card, "front" | "back">): string[];
}

const types = (blocks: readonly CardBlock[] | undefined): string[] => (blocks ?? []).map((block) => String(block?.type));
const has = (blocks: readonly CardBlock[] | undefined, wanted: ReadonlySet<string> | readonly string[]): boolean =>
  types(blocks).some((type) => (wanted instanceof Set ? wanted.has(type) : (wanted as readonly string[]).includes(type)));

/** Checks every kind with a back shares: the card turns over to an answer and asks nothing on its face. */
function turnsOver(card: Pick<Card, "front" | "back">, front: string): string[] {
  const problems: string[] = [];
  if (!card.back?.length) problems.push(`This kind turns over: give it a back, the answer to check yourself against (${front} goes on the front).`);
  if (has(card.front, ASK_BLOCKS) || has(card.back, ASK_BLOCKS)) problems.push("A card that turns over does not also ask a question with options; make that its own card of kind ask.");
  if (has(card.front, HIDING_BLOCKS) || has(card.back, HIDING_BLOCKS)) problems.push("A hidden part (cloze) belongs on a cloze card.");
  return problems;
}

function needsOnBack(card: Pick<Card, "back">, wanted: readonly string[], what: string): string[] {
  return has(card.back, wanted) ? [] : [`The back of this kind holds ${what} (${wanted.map((type) => `a ${type} block`).join(" or ")}).`];
}

export const CARD_KINDS: readonly CardKind[] = [
  {
    id: "recall",
    label: "Front and back",
    description: "A question, term, cue or example on the front; the answer on the back, checked after trying to recall it.",
    mark: "self",
    example: { front: [{ type: "text", text: "..." }], back: [{ type: "text", text: "..." }] },
    check: (card) => turnsOver(card, "the question, term or cue"),
  },
  {
    id: "cloze",
    label: "Fill the gap",
    description: "A sentence with its key part hidden, recalled before the card turns over to show it.",
    mark: "self",
    example: { front: [{ type: "cloze", text: "... [[the key part]] ..." }] },
    check: (card) => {
      const problems: string[] = [];
      const clozes = types(card.front).filter((type) => type === "cloze").length;
      if (clozes !== 1) problems.push(`The front holds exactly one cloze block, the sentence with its key part in [[double brackets]]; it has ${clozes}.`);
      if (has(card.front, ASK_BLOCKS) || has(card.back, ASK_BLOCKS)) problems.push("A cloze card does not also ask a question with options.");
      if (has(card.back, HIDING_BLOCKS)) problems.push("The back shows, it hides nothing: leave the cloze on the front.");
      return problems;
    },
  },
  {
    id: "compare",
    label: "Compare",
    description: "Things compared along the same lines: the front asks how they differ, the back is the table.",
    mark: "self",
    example: { front: [{ type: "text", text: "How do ... and ... differ in ..., ... and ...?" }], back: [{ type: "table", headers: ["...", "...", "..."], rows: [["...", "...", "..."]] }] },
    check: (card) => [...turnsOver(card, "what is compared"), ...needsOnBack(card, ["table", "prosCons"], "the comparison")],
  },
  {
    id: "steps",
    label: "Steps",
    description: "A process in order: the front names it, the back lists its steps.",
    mark: "self",
    example: { front: [{ type: "text", text: "What are the steps of ...?" }], back: [{ type: "numbered", items: ["...", "...", "..."] }] },
    check: (card) => [...turnsOver(card, "the process"), ...needsOnBack(card, ["numbered", "timeline"], "the steps in order")],
  },
  {
    id: "formula",
    label: "Formula",
    description: "A formula and what each part means: the front says what it gives, the back shows it with its parts.",
    mark: "self",
    example: { front: [{ type: "text", text: "What gives ... from ... and ...?" }], back: [{ type: "math", latex: "...", caption: "..." }, { type: "bullets", items: ["$x$ is ...", "$y$ is ..."] }] },
    check: (card) => [...turnsOver(card, "what the formula gives"), ...needsOnBack(card, ["math"], "the formula")],
  },
  {
    id: "worked",
    label: "Worked example",
    description: "A problem on the front to try; the back works it through step by step.",
    mark: "self",
    example: { front: [{ type: "text", text: "..." }], back: [{ type: "numbered", items: ["...", "..."] }, { type: "text", text: "So ..." }] },
    check: (card) => [...turnsOver(card, "the problem"), ...needsOnBack(card, ["numbered", "math", "code", "text"], "the working")],
  },
  {
    id: "picture",
    label: "Picture",
    description: "A picture from the source with a question about it on the front (what is labelled, what it shows); the answer on the back.",
    mark: "self",
    example: { front: [{ type: "figure", url: "/v1/assets/ASSET-ID", caption: "..." }, { type: "text", text: "What is ...?" }], back: [{ type: "bullets", items: ["...", "..."] }] },
    check: (card) => [...turnsOver(card, "the picture and its question"), ...(has(card.front, MEDIA_BLOCKS) ? [] : ["The front of a picture card shows a picture from the source (a figure block)."])],
  },
  {
    id: "ask",
    label: "Question",
    description: "A question the card checks itself: pick an option, fill a gap, match pairs, put things in order, name the marks on a picture from the source or draw a line on a grid.",
    mark: "answer",
    example: { front: [{ type: "quiz", question: "...", options: ["...", "...", "..."], correctIndex: 0, explanation: "..." }] },
    check: (card) => {
      const problems: string[] = [];
      const asks = types(card.front).filter((type) => ASK_BLOCKS.has(type)).length;
      if (asks !== 1) problems.push(`The front holds exactly one block that asks (${[...ASK_BLOCKS].join(", ")}); it has ${asks}.`);
      if (card.back?.length) problems.push("A question card has no back: its explanation says why once it is answered.");
      return problems;
    },
  },
  {
    id: "explain",
    label: "Explain",
    description: "One point the set needs before its other cards make sense (what a term means, why a rule holds), read and not marked. Use few.",
    mark: "none",
    example: { front: [{ type: "text", text: "..." }] },
    check: (card) => (markOf(card) === "none" ? [] : ["An explain card only shows: no back, no hidden part and no question. If it should be recalled, make it another kind."]),
  },
];

export class CardKindRegistry {
  private readonly kinds = new Map<string, CardKind>();

  constructor(kinds: readonly CardKind[] = CARD_KINDS) {
    for (const kind of kinds) this.register(kind);
  }

  register(kind: CardKind): this {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(kind.id)) throw new Error(`"${kind.id}" is not a card kind id.`);
    if (this.kinds.has(kind.id)) throw new Error(`Card kind "${kind.id}" is already registered.`);
    if (!kind.label.trim() || !kind.description.trim()) throw new Error(`Card kind "${kind.id}" needs a label and a description.`);
    this.kinds.set(kind.id, kind);
    return this;
  }

  get(id: string): CardKind | undefined {
    return this.kinds.get(id);
  }

  ids(): string[] {
    return [...this.kinds.keys()];
  }

  list(): CardKind[] {
    return [...this.kinds.values()];
  }

  /** The kinds as a settings form offers them, in their own words. */
  options(): SettingOption[] {
    return this.list().map((kind) => ({ value: kind.id, label: kind.label, description: kind.description }));
  }

  /** The kinds `allowed` names, one line each with an example of its sides: what a maker's tool says. */
  catalog(allowed: readonly string[] = this.ids()): string {
    return this.list()
      .filter((kind) => allowed.includes(kind.id))
      .map((kind) => `- ${kind.id} (${kind.label.toLowerCase()}): ${kind.description} Example: ${JSON.stringify(kind.example)}`)
      .join("\n");
  }
}

/** The kinds Open Sourcebook ships. */
export const cardKinds = new CardKindRegistry();
