import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Inline } from "./inline";
import { parseInline, quoteWords } from "./inlineMarks";

describe("inline marks in body text", () => {
  it("reads bold, italic, code, links and math, and keeps the rest as text", () => {
    expect(parseInline("A **bold** idea, *slanted*, `x + 1`, [the paper](https://arxiv.org/abs/1) and $d_k$.")).toEqual([
      { kind: "text", text: "A " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: " idea, " },
      { kind: "italic", text: "slanted" },
      { kind: "text", text: ", " },
      { kind: "code", text: "x + 1" },
      { kind: "text", text: ", " },
      { kind: "link", text: "the paper", href: "https://arxiv.org/abs/1" },
      { kind: "text", text: " and " },
      { kind: "math", text: "d_k" },
      { kind: "text", text: "." },
    ]);
  });

  it("shows a marker with no partner as typed, money as money, and a non-web link as its label", () => {
    expect(parseInline("2 * 3 costs $5 and $10")).toEqual([{ kind: "text", text: "2 * 3 costs $5 and $10" }]);
    expect(parseInline("[click](javascript:void)")).toEqual([{ kind: "text", text: "click" }]);
  });

  it("draws bold without the asterisks", () => {
    render(<p><Inline text="printed on **paper, cloth, or a similar material**" /></p>);
    expect(screen.getByText("paper, cloth, or a similar material").tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
  });
});

describe("a cite's quoted words", () => {
  it("drop the source's Markdown, paired or cut off, so a screen reader never says the marks", () => {
    expect(quoteWords("**Waxing cresc")).toBe("Waxing cresc");
    expect(quoteWords("## Phases\n\nThe **waxing** moon, see [the chart](https://x.org) and `code`.")).toBe("Phases The waxing moon, see the chart and code.");
    expect(quoteWords("> - first point\n> 2. second__")).toBe("first point second");
    expect(quoteWords("snake_case stays")).toBe("snake_case stays");
  });
});
