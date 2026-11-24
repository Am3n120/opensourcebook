import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { paperBlocks } from "./paperBlocks";
import { PaperText } from "./PaperText";

const text = "## Compound interest\n\n### What compounding means\n\nInterest earns interest of its own.\nA second line.\n\n\f\n\nThe balance after n periods grows.";

test("a source's text is read as headings, paragraphs and page breaks, each with its span", () => {
  const blocks = paperBlocks(text);
  expect(blocks.map((b) => [b.kind, text.slice(b.start, b.end)])).toEqual([
    ["heading", "Compound interest"],
    ["heading", "What compounding means"],
    ["paragraph", "Interest earns interest of its own.\nA second line."],
    ["page", "\f"],
    ["paragraph", "The balance after n periods grows."],
  ]);
});

test("the reader draws the headings and marks the cited words exactly, across a heading and a paragraph", () => {
  const start = text.indexOf("earns interest");
  render(<PaperText text={text} marked={[start, start + "earns interest".length]} mark={createRef()} title="Interest" />);
  expect(screen.getByRole("heading", { name: "Compound interest" }).tagName).toBe("H4");
  expect(screen.getByRole("heading", { name: "What compounding means" }).tagName).toBe("H5");
  expect(screen.getByText("earns interest", { selector: "mark" })).toHaveClass("spot");
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  // A plain text with no headings is its paragraphs, as before.
  expect(paperBlocks("One.\n\nTwo.").map((b) => b.kind)).toEqual(["paragraph", "paragraph"]);
});

test("a first heading that is the reader's own title is not said twice", () => {
  render(<PaperText text={text} marked={undefined} mark={createRef()} title="compound interest" />);
  expect(screen.queryByRole("heading", { name: "Compound interest" })).toBeNull();
  expect(screen.getByRole("heading", { name: "What compounding means" })).toBeInTheDocument();
});

test("a Markdown source marks the cited words themselves inside the marked block", async () => {
  const { Markdown } = await import("./MarkdownText");
  const md = "# Notes\n\nPioneers do not depend on **shade** or rich soil, so they thrive.";
  const quote = "do not depend on";
  const at = md.indexOf(quote);
  render(<Markdown text={md} marked={[at, at + quote.length]} />);
  expect(screen.getByText(quote, { selector: "mark" })).toHaveClass("exact");
});
