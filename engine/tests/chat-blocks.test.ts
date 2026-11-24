/**
 * Reply blocks (docs/api.md, "Reply blocks"): every kind is read through
 * one registry, cites sit on the block, item or row that says the thing and
 * are checked word for word, links to a passage become links to its spot,
 * passage labels never stay in the words, and an unknown kind degrades to
 * a paragraph.
 */
import { describe, expect, it } from "vitest";
import { readAnswer } from "../src/chat/answer";
import { createBlockKinds, CiteBook } from "../src/chat/blocks";
import { blockGuide } from "../src/chat/writing";
import { pieceKinds } from "../src/chat/pieces";
import type { Passage } from "../src/sources/passages";

const passages: Passage[] = [
  { id: "c1", label: "S1#1", sourceId: "s1", text: "Midterm covers lectures 1 to 6. The final covers everything." },
  { id: "c2", label: "S2#1", sourceId: "s2", text: "The derivative is the limit of the difference quotient." },
];

describe("reply blocks", () => {
  it("reads lists, tables, notes, maths and code, with cites on items and rows", () => {
    const read = readAnswer(
      {
        blocks: [
          { kind: "paragraph", text: "Two things cover it.", cites: [{ passage: "S1#1", quote: "Midterm covers lectures 1 to 6" }] },
          { kind: "numbered", items: [{ text: "Lectures 1 to 6", cites: [{ passage: "S1#1", quote: "lectures 1 to 6" }] }, "The final"] },
          { kind: "table", header: ["Exam", "Covers"], rows: [{ cells: ["Midterm", "1–6"], cites: [{ passage: "S1#1", quote: "lectures 1 to 6" }] }, ["Final", "All"]] },
          { kind: "note", text: "Nothing on dates." },
          { kind: "math", text: "$f'(x) = \\lim_{h \\to 0} \\frac{f(x+h)-f(x)}{h}$" },
          { kind: "code", text: "print(1)\n", lang: "python" },
          { kind: "heading", text: "## **Next**" },
        ],
        covered: true,
      },
      passages,
      [],
      { strict: true },
    );
    expect(read.badQuotes).toEqual([]);
    expect(read.problems).toEqual([]);
    const [text, list, table, note, math, code, heading] = read.reply.pieces as unknown as Array<Record<string, unknown>>;
    expect(text).toEqual({ kind: "text", text: "Two things cover it.", cites: [0] });
    // Quotes widen to whole sentences, so the same sentence cited three times is one cite.
    expect(list).toMatchObject({ kind: "list", ordered: true, items: [{ text: "Lectures 1 to 6", cites: [0] }, { text: "The final", cites: [] }], text: "1. Lectures 1 to 6\n2. The final" });
    expect(table).toMatchObject({ kind: "table", header: ["Exam", "Covers"], rows: [{ cells: ["Midterm", "1–6"], cites: [0] }, { cells: ["Final", "All"], cites: [] }] });
    expect(note).toEqual({ kind: "note", text: "Nothing on dates.", cites: [] });
    expect(math).toMatchObject({ kind: "math", text: "f'(x) = \\lim_{h \\to 0} \\frac{f(x+h)-f(x)}{h}" });
    expect(code).toEqual({ kind: "code", text: "print(1)", lang: "python" });
    expect(heading).toEqual({ kind: "heading", text: "Next" });
    expect(pieceKinds.asText(table as never)).toBe("Exam | Covers\nMidterm | 1–6\nFinal | All");
  });

  it("drops a failing cite from its item and marks only that item", () => {
    const read = readAnswer({ blocks: [{ kind: "bullets", items: [{ text: "A", cites: [{ passage: "S1#1", quote: "not there" }] }, { text: "B", cites: [{ passage: "S1#1", quote: "final covers everything" }] }] }] }, passages, [], { strict: true });
    expect(read.badQuotes).toEqual([{ passage: "S1#1", quote: "not there" }]);
    expect((read.reply.pieces[0] as { items: unknown[] }).items).toEqual([
      { text: "A", cites: [], unchecked: true },
      { text: "B", cites: [0] },
    ]);
  });

  it("links words to a passage's spot, and takes passage labels out of the words", () => {
    const book = new CiteBook(passages, true);
    expect(book.inline("See [the midterm rule](S1#1) (S1#1), and S2#1 too [S1#1, S2#1].")).toBe("See [the midterm rule](cite:0), and too.");
    expect(book.cites).toHaveLength(1);
    expect(book.inline("[gone](S9#9) and [a site](https://example.com)")).toBe("gone and a site");
    expect(book.bad).toEqual([{ passage: "S9#9", quote: "", unknown: true }]);
  });

  it("keeps the cites of earlier calls at their numbers", () => {
    const first = readAnswer({ blocks: [{ kind: "paragraph", text: "x", cites: [{ passage: "S2#1", quote: "difference quotient" }] }] }, passages, [], { strict: true });
    const second = readAnswer({ blocks: [{ kind: "paragraph", text: "y", cites: [{ passage: "S1#1", quote: "final covers everything" }, { passage: "S2#1", quote: "difference quotient" }] }] }, passages, [], { strict: true, cites: first.reply.cites });
    expect(second.reply.pieces[0]).toMatchObject({ cites: [1, 0] });
    expect(second.reply.cites?.[0]).toEqual(first.reply.cites?.[0]);
  });

  it("reads an unknown kind with words as a paragraph, and says what can't be shown", () => {
    const read = readAnswer({ blocks: [{ kind: "poem", text: "Roses." }, { kind: "bullets", items: [] }, { kind: "table", header: ["Only"] }] }, passages, [], { strict: true });
    expect(read.reply.pieces).toEqual([{ kind: "text", text: "Roses.", cites: [] }]);
    expect(read.problems).toEqual([expect.stringContaining("Block 2 (bullets)"), expect.stringContaining("Block 3 (table)")]);
  });

  it("keeps what the writer adds apart: a background block carries no cite and says it is not from the sources", () => {
    const read = readAnswer({ blocks: [{ kind: "background", text: "Such a value is usually read as a large gap.", cites: [{ passage: "S1#1", quote: "Midterm covers" }] }] }, passages, [], { strict: true });
    expect(read.reply.pieces).toEqual([{ kind: "background", text: "Such a value is usually read as a large gap." }]);
    expect(createBlockKinds().asText(read.reply.pieces[0] as unknown as Record<string, unknown>)).toContain("Background, not from the sources");
    expect(blockGuide()).toContain('- "background": What you add that the sources do not say');
    expect(blockGuide()).toContain("Keep what the sources say apart from what you add");
  });

  it("still reads the older `parts` as paragraphs", () => {
    const read = readAnswer({ parts: [{ text: "Old shape.", cites: [{ passage: "S1#1", quote: "Midterm covers" }] }] }, passages);
    expect(read.reply.pieces).toEqual([{ kind: "text", text: "Old shape.", cites: [0] }]);
  });

  it("registers each kind once and each name once", () => {
    const kinds = createBlockKinds();
    expect(kinds.names()).toEqual(expect.arrayContaining(["paragraph", "bullets", "numbered", "table", "note", "math", "code", "heading"]));
    expect(() => kinds.register({ kind: "poem", names: ["bullets"], about: "", cites: false, read: () => ({ problem: "" }), asText: () => "" })).toThrow(/taken/);
  });
});
