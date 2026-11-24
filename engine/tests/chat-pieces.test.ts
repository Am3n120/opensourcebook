/**
 * Reply pieces (docs/api.md, "Message"): kinds sit in a registry, a kind
 * nobody registered still reads as its text, and a question's options get
 * ids and may name a skill.
 */
import { describe, expect, it } from "vitest";
import { createPieceKinds, question, say } from "../src/chat/pieces";

describe("reply pieces", () => {
  it("reads a reply as plain text through the registry, an unknown kind by its text", () => {
    const kinds = createPieceKinds();
    const text = kinds.replyText([
      say("First."),
      { kind: "plan", planId: "p1", action: "edited", changes: ["Removed one."] },
      { kind: "poll", text: "A kind added later." },
      { kind: "mystery" },
    ] as never);
    expect(text).toBe("First.\n\n[The plan card (changed)]\n- Removed one.\n\nA kind added later.");
  });

  it("registers new kinds without touching the others, once each", () => {
    const kinds = createPieceKinds().register({ kind: "poll", asText: (piece) => `Poll: ${String(piece.text)}` });
    expect(kinds.asText({ kind: "poll", text: "Which?" } as never)).toBe("Poll: Which?");
    expect(() => kinds.register({ kind: "text", asText: () => "" })).toThrow(/already registered/);
  });

  it("makes a question from the model's words: ids, no blanks or repeats, a skill per option", () => {
    expect(question("q1", { text: " Which? ", options: ["A", " ", "B", "A", { label: "C" }], multiple: true }, (index) => (index === 0 ? "planning" : undefined))).toEqual({
      kind: "question",
      id: "q1",
      text: "Which?",
      options: [{ id: "o1", label: "A", skill: "planning" }, { id: "o2", label: "B" }, { id: "o3", label: "C" }],
      multiple: true,
    });
    expect(question("q1", { options: ["A"] }, () => undefined)).toBeUndefined();
    expect(question("q1", { text: "Only one?", options: ["A"], multiple: true }, () => undefined)!.multiple).toBe(false);
  });

  it("reads a make sheet as what it holds and where it stands", () => {
    const kinds = createPieceKinds();
    const sheet = { kind: "make", format: "quiz", title: "Loops", about: "b", sources: [], settings: {}, plannedAs: "quiz · 5 questions", notices: [], issues: [], state: "open" };
    expect(kinds.asText(sheet as never)).toBe('[The make sheet for "Loops" (quiz · 5 questions): open for the person; nothing is made until they press its button]');
    expect(kinds.asText({ ...sheet, state: "made", planId: "p9", remakes: { planId: "p1", itemId: "n1" } } as never)).toBe('[The make sheet for "Loops" (quiz · 5 questions), a remake: made (thing p9)]');
  });
});
