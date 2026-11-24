import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Blocks } from "./Blocks";
import { Inline } from "./inline";

test("a math block is drawn as maths, not shown as its LaTeX", async () => {
  const { container } = render(<Blocks blocks={[{ type: "math", latex: "\\frac{a}{b}", caption: "A fraction" }]} />);
  await screen.findByText("A fraction");
  await expect.poll(() => container.querySelector(".bmath .katex-display")).not.toBeNull();
  expect(container.querySelector(".bmath .mfrac")).not.toBeNull();
  expect(container.querySelector(".tex-src")).toBeNull();
});

test("$…$ in body text is drawn inline; money stays text", async () => {
  const { container } = render(<p><Inline text="Costs $5 and $10, and $x^2$ grows." /></p>);
  await expect.poll(() => container.querySelector(".tex .katex")).not.toBeNull();
  expect(container.querySelectorAll(".tex")).toHaveLength(1);
  expect(container.textContent).toContain("Costs $5 and $10, and ");
});

test("a formula that cannot be read is shown as written", async () => {
  const { container } = render(<Blocks blocks={[{ type: "math", latex: "\\frac{1}{2 \\nosuchcommand" }]} />);
  await expect.poll(() => container.querySelector(".tex-src:not(.wait)")).not.toBeNull();
  expect(container.querySelector(".tex-src")).toHaveTextContent("\\frac{1}{2 \\nosuchcommand");
  expect(container.querySelector(".katex")).toBeNull();
});

test("maths a maker wrote cannot add a link, a picture or an attribute of its own", async () => {
  const sources = [
    "\\href{javascript:alert(1)}{x}",
    "\\url{https://attacker.example/a}",
    "\\includegraphics[height=1em]{https://attacker.example/p.png}",
    "\\htmlClass{evil}{x}",
    "\\htmlData{leak=1}{x}",
    "\\htmlId{evil}{x}",
    "\\htmlStyle{background:url(https://attacker.example/s.png)}{x}",
  ];
  const { container } = render(<Blocks blocks={sources.map((latex) => ({ type: "math", latex }))} />);
  // Each is drawn by KaTeX (the command as plain text) or shown as written; none is still waiting.
  await expect.poll(() => container.querySelectorAll(".bmath .katex, .tex-src:not(.wait)").length).toBe(sources.length);
  expect(container.querySelectorAll(".bmath .katex").length).toBeGreaterThan(0);
  expect(container.querySelectorAll("a, img, [href], [src], [data-leak], #evil, .evil, [style*='attacker']")).toHaveLength(0);
});
