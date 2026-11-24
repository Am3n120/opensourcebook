import { describe, expect, it } from "vitest";
import { paragraphsFromItems, type LaidOutItem } from "../src/extract/pdf";

/** Lines laid out top to bottom: each [text, gap above it, size, width]. */
function page(lines: Array<[string, number, number?, number?]>): LaidOutItem[] {
  let y = 800;
  return lines.map(([str, gap, size = 11, width = 450]) => {
    y -= gap;
    return { str, y, size, width, hasEOL: true };
  });
}

describe("a PDF page's paragraphs", () => {
  it("joins the lines of a paragraph and starts a new one at a wider gap", () => {
    const text = paragraphsFromItems(page([
      ["The chain is a series of proteins", 0],
      ["in the inner membrane.", 14],
      ["The pumped protons build up", 24],
      ["between the two membranes.", 14],
    ]));
    expect(text).toBe("The chain is a series of proteins in the inner membrane.\n\nThe pumped protons build up between the two membranes.");
  });

  it("sets a heading apart by its size", () => {
    const text = paragraphsFromItems(page([
      ["Lecture 9", 0, 20, 200],
      ["The chain is a series of proteins", 22],
      ["in the inner membrane.", 14],
    ]));
    expect(text).toBe("## Lecture 9\n\nThe chain is a series of proteins in the inner membrane.");
  });

  it("marks a heading by its level, against the document's body size, and never a sentence, a long line or a number", () => {
    const text = paragraphsFromItems(
      page([
        ["Part two", 0, 22, 200],
        ["How the pump works", 30, 14, 250],
        ["The chain is a series of proteins", 20],
        ["in the inner membrane.", 14],
        ["A larger closing remark that ends like a sentence.", 24, 14, 400],
        ["12", 40, 18, 20],
      ]),
      11,
    );
    expect(text).toBe("## Part two\n\n### How the pump works\n\nThe chain is a series of proteins in the inner membrane.\n\nA larger closing remark that ends like a sentence.\n\n12");
  });

  it("finds no heading on a page set in one size", () => {
    const text = paragraphsFromItems(page([["Introduction", 0, 11, 120], ["The chain is a series of proteins.", 24]]));
    expect(text).not.toMatch(/#/);
  });

  it("ends a paragraph after a short line that ends a sentence", () => {
    const text = paragraphsFromItems(page([
      ["It runs in four stages, glycolysis first, then the rest", 0],
      ["of them in order.", 14, 11, 120],
      ["Glycolysis splits glucose.", 14],
    ]));
    expect(text).toBe("It runs in four stages, glycolysis first, then the rest of them in order.\n\nGlycolysis splits glucose.");
  });

  it("puts runs on one baseline on one line, and gives nothing for an empty page", () => {
    const items: LaidOutItem[] = [
      { str: "Two ", y: 700, size: 11, width: 30 },
      { str: "runs", y: 700, size: 11, width: 30, hasEOL: true },
    ];
    expect(paragraphsFromItems(items)).toBe("Two runs");
    expect(paragraphsFromItems([])).toBe("");
  });
});
