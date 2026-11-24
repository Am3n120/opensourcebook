import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "../api/types";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";
import { asCards, cardTitle, markOf, spotText } from "./blockData";
import { linkUrl, mediaUrl, previewUrl } from "./media";
import { madeByLine } from "./videoData";

const cards = [
  { id: "c1", kind: "recall", section: "Warm-up", front: [{ type: "text", text: "When does a limit exist?" }], back: [{ type: "text", text: "When both sides agree." }], cites: [{ sourceId: "s1", spot: "passage", locator: { page: 4 }, block: 1 }] },
  { id: "c2", kind: "cloze", front: [{ type: "cloze", text: "A limit from the [[left]] uses smaller x." }], cites: [] },
  { id: "c3", kind: "ask", front: [{ type: "quiz", question: "Pick one", options: ["a", "b"], correctIndex: 1, explanation: "b is right" }], cites: [] },
];

function output(id: string, extra: JsonObject = {}) {
  return {
    id, type: "flashcards", title: `Set ${id}`, schemaVersion: 3, costUsd: 0.03, createdAt: now, updatedAt: now,
    payload: { schemaVersion: 3, id, title: `Set ${id}`, subtitle: "Week 3", tags: [], cards },
    citations: [{ sourceId: "s1" }], prompt: "Teach limits.", sources: [{ sourceId: "s1" }], ...extra,
  };
}
const item = (id: string, outputId: string | undefined, done = false, status?: string) => ({
  id, level: 1, ord: Number(id.slice(1)), type: "flashcards", title: `Item ${id}`, settings: {}, enabled: true, status: status ?? (outputId ? "done" : "pending"), sources: [], done, ...(outputId ? { outputId } : {}),
});

function routes(done = { value: false }, lastStatus = "pending") {
  return {
    "GET /v1/outputs/:id": ({ params }: { params: Record<string, string> }) => ({ output: output(params.id!, { projectId: "p1", planId: "pl1", itemId: params.id === "o2" ? "i2" : "i1" }) }),
    "GET /v1/projects/:id": { project: { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now } },
    "GET /v1/sources/:id": { source: { id: "s1", kind: "pdf", title: "Week 3", createdAt: now, updatedAt: now }, extraction: { contentHash: "h", kind: "pdf", status: "ready", createdAt: now, updatedAt: now }, chunkCount: 1 },
    "GET /v1/plans/:id": () => ({
      plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "running", createdAt: now, updatedAt: now, kickedOffAt: now },
      stages: [], edges: [], counts: { total: 3, done: done.value ? 1 : 0 }, estimateUsd: 0, issues: [],
      items: [item("i1", "o1", done.value), item("i2", "o2"), item("i3", undefined, false, lastStatus)],
    }),
    "POST /v1/plans/:id/items/:itemId/done": () => {
      done.value = true;
      return { item: { id: "i1", done: true }, counts: { total: 3, done: 1 } };
    },
  };
}

test("down goes to the next made thing in plan order, and after the last to the plan's end card; up comes back", async () => {
  renderApp("/outputs/o1", routes(undefined, "skipped"));
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
  // No buttons, labels or hints for before and next: scrolling and the arrow keys are the way.
  expect(screen.queryByRole("button", { name: /Next thing|Previous thing/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/in plan order|Last in the plan|First in the plan/)).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowDown}");
  expect(await screen.findByRole("heading", { name: "Set o2" })).toBeInTheDocument();
  await userEvent.keyboard("{ArrowDown}");
  const end = await screen.findByRole("region", { name: "The end" });
  // The skipped third is not counted.
  expect(within(end).getByRole("heading", { name: "That's all 2 in this plan" })).toBeInTheDocument();
  expect(end).toHaveTextContent("0 done, 2 left for later. Nothing more is coming in this plan.");
  expect(within(end).getByRole("button", { name: "Back to the project" })).toBeInTheDocument();
  await userEvent.click(within(end).getByRole("button", { name: "Go to the first one left" }));
  expect(await screen.findByRole("heading", { name: "Set o1" })).toBeInTheDocument();
});

test("a wheel turned past the end of the thing goes on to the next one", async () => {
  renderApp("/outputs/o1", routes());
  const main = await screen.findByRole("region", { name: "Playing: Set o1" });
  await screen.findByLabelText("Card 1 of 3");
  fireEvent.wheel(main, { deltaY: 120 });
  expect(await screen.findByRole("heading", { name: "Set o2" })).toBeInTheDocument();
});

test("with more of the plan still to make or being made, the end card says more is coming", async () => {
  renderApp("/outputs/o2", routes(undefined, "running"));
  await screen.findByRole("heading", { name: "Set o2" });
  await screen.findByLabelText("Card 1 of 3");
  await userEvent.keyboard("{ArrowDown}");
  expect(await screen.findByRole("region", { name: "The end" })).toHaveTextContent("More is coming in this plan.");
  await userEvent.keyboard("{ArrowUp}");
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
});

test("a thing asked for on its own has no plan, no end card, and leaves full view for its project", async () => {
  const r = routes();
  const plan = { ...r["GET /v1/plans/:id"](), counts: { total: 1, done: 0 } };
  plan.plan = { ...plan.plan, title: "Set o1", direct: true } as typeof plan.plan;
  plan.items = [plan.items[0]!];
  renderApp("/outputs/o1", { ...r, "GET /v1/plans/:id": plan });
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Exit full view" })).toHaveAttribute("href", "/projects/p1?play=o1");
  // The project under the title, as the full view shows it.
  expect(await screen.findByText("Calculus I")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.queryByRole("region", { name: "The end" })).not.toBeInTheDocument();
});

test("on a phone the thing fills the screen: back to its plan, no full view", async () => {
  const before = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  try {
    renderApp("/outputs/o1", routes());
    expect(await screen.findByRole("link", { name: "Back to the plan" })).toHaveAttribute("href", "/projects/p1?plan=pl1");
    expect(screen.queryByRole("link", { name: /full view/i })).not.toBeInTheDocument();
  } finally {
    window.matchMedia = before;
  }
});

test("the done tick in the bar ticks the plan item, and again undoes it", async () => {
  const { calls } = renderApp("/outputs/o1", routes());
  await screen.findByLabelText("Card 1 of 3");
  const tick = await screen.findByRole("button", { name: "Done" });
  expect(tick).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(tick);
  await waitFor(() => expect(calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")?.body).toEqual({ done: true, outputId: "o1" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true"));
});

test("talk opens the thread on this thing beside it, with its count on the icon", async () => {
  renderApp("/outputs/o1", {
    ...routes(),
    "GET /v1/threads": { threads: [{ itemId: "i1", planId: "pl1", count: 2 }] },
    "GET /v1/plans/:id/items/:itemId/thread": { messages: [] },
    "GET /v1/projects/:id/sources": { sources: [] },
  });
  await screen.findByLabelText("Card 1 of 3");
  const talk = await screen.findByRole("button", { name: "Talk about this: 2 messages" });
  await userEvent.click(talk);
  expect(await screen.findByRole("complementary", { name: "Talk about Set o1" })).toBeInTheDocument();
});

test("a format with no web player says so", async () => {
  renderApp("/outputs/o1", { "GET /v1/outputs/:id": { output: { ...output("o1"), type: "poster", payload: {} } } });
  expect(await screen.findByText("No web player for this format yet")).toBeInTheDocument();
});

test("cards are read defensively, named for the list and marked from their sides", () => {
  const read = asCards({ cards: [...cards, { id: "c9", front: [] }, "nope"] } as unknown as JsonObject);
  expect(read.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  expect(read.map((c) => markOf(c))).toEqual(["self", "self", "answer"]);
  expect(markOf({ front: [{ type: "text", text: "x" }], back: [] })).toBe("none");
  expect(cardTitle(read[0]!, 0)).toBe("When does a limit exist?");
  expect(cardTitle(read[1]!, 1)).toBe("A limit from the … uses smaller x.");
  expect(cardTitle(read[2]!, 2)).toBe("Pick one");
  // A card's name in the list reads as plain words, without its inline marks.
  expect(cardTitle({ id: "x", kind: "recall", front: [{ type: "text", text: "Why **pivots** decide `Ax = b`" }], back: [], cites: [] }, 3)).toBe("Why pivots decide Ax = b");
  // An older payload of screens reads as cards to read.
  expect(asCards({ bits: [{ id: "b1", blocks: [{ type: "text", text: "Old." }] }] } as unknown as JsonObject).map((c) => [c.id, c.kind, markOf(c)])).toEqual([["c1", "explain", "none"]]);
  expect(spotText({ sourceId: "s", locator: { page: 3, endPage: 5 } })).toBe("pp. 3–5");
  expect(spotText({ sourceId: "s", locator: { startMs: 83000 } })).toBe("1:23");
});

test("media paths go through the proxy; unsafe URLs are dropped", () => {
  expect(mediaUrl("/v1/assets/x")).toBe("/api/v1/assets/x");
  expect(mediaUrl("javascript:alert(1)")).toBeUndefined();
  // Media from a web address is never drawn, only what Open Sourcebook keeps or embeds; a link a person clicks may open a page.
  expect(mediaUrl("https://elsewhere.example/a.jpg")).toBeUndefined();
  expect(mediaUrl("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(mediaUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
  expect(linkUrl("https://elsewhere.example/page")).toBe("https://elsewhere.example/page");
  expect(linkUrl("javascript:alert(1)")).toBeUndefined();
  expect(previewUrl("/v1/video-makers/scenes/styles/ink/preview")).toBe("/api/v1/video-makers/scenes/styles/ink/preview");
  expect(previewUrl("https://elsewhere.example/a.jpg")).toBeUndefined();
  expect(previewUrl("//elsewhere.example/a.jpg")).toBeUndefined();
});

test("a video made by a maker says who made it, in words; a storyboard says nothing more", () => {
  const render = { by: "scenes", storyboard: false, url: "/v1/assets/a", durationMs: 1, scenes: [] };
  expect(
    madeByLine({
      render: { ...render, maker: { id: "scenes", label: "Drawn scenes", style: { id: "ink", label: "Ink" }, agent: { id: "claude", model: "sonnet" }, voice: { id: "say", label: "Computer voice", real: true } } },
    }),
  ).toBe("Drawn scenes, Ink style, written by claude (sonnet), voice: Computer voice");
  expect(
    madeByLine({
      render: { ...render, maker: { id: "scenes", label: "Drawn scenes", style: { id: "ink", label: "Ink" }, agent: { id: "claude", label: "Claude Code", model: "claude-sonnet-4-6", effort: "high" }, voice: { id: "say", label: "Computer voice", real: true } } },
    }),
  ).toBe("Drawn scenes, Ink style, written by Claude Code (claude-sonnet-4-6, high effort), voice: Computer voice");
  expect(madeByLine({ render: { ...render, by: "storyboard", storyboard: true } })).toBeUndefined();
  expect(madeByLine({})).toBeUndefined();
});

test("a quiz asks one question at a time and records its graded result with the done tick", async () => {
  const quizOut = {
    id: "o1", type: "quiz", title: "Check yourself", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    projectId: "p1", planId: "pl1", itemId: "i1",
    payload: {
      title: "Check yourself", passMark: 0.5, feedback: "afterEach",
      questions: [
        { id: "q1", kind: "choice", topic: "onto", prompt: "Which is onto?", points: 1, options: ["A wide matrix with full rank", "A tall matrix"], answer: 0, feedback: { correct: "Yes.", incorrect: "Columns must span." }, cites: [{ sourceId: "s1", locator: { page: 3 } }] },
        { id: "q2", kind: "choice", topic: "rank", prompt: "Rank of I₂?", display: "I_2 = \\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}", points: 1, options: ["1", "2"], answer: 1, feedback: { correct: "Right. Two pivots.", incorrect: "Count the pivots." }, cites: [] },
      ],
    },
  };
  const shown: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    shown.push(this);
  };
  const { calls } = renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: quizOut } });
  const card = await screen.findByLabelText("Question 1 of 2");
  expect(within(card).getByText("Which is onto?")).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: /A tall matrix/ }));
  expect(within(card).getByText("Columns must span.")).toBeInTheDocument();
  // The feedback is brought into view, wherever the card's fold falls.
  expect(shown.at(-1)).toHaveTextContent("Not quite.");
  await userEvent.click(within(card).getByRole("button", { name: /Next question/ }));
  // The question's display is LaTeX, drawn as maths under the prompt.
  await expect.poll(() => document.querySelector(".qdisplay .katex-display")).not.toBeNull();
  expect(document.querySelector(".qdisplay .tex-src")).toBeNull();
  await userEvent.keyboard("b");
  // Feedback that opens with its own verdict is not given a second one.
  expect(document.querySelector(".fb2")?.textContent).toMatch(/^Right\. Two pivots\./);
  await userEvent.click(screen.getByRole("button", { name: /See your result/ }));
  const sum = screen.getByLabelText("Your result");
  expect(within(sum).getByRole("heading", { name: "1 of 2" })).toBeInTheDocument();
  expect(within(sum).getByText("50% · the pass mark is 50%")).toBeInTheDocument();
  // The result goes with the done tick as the quiz ends.
  await expect.poll(() => calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")).toBeDefined();
  const body = calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")?.body as { done: boolean; outputId: string; result: Record<string, unknown> };
  expect(body).toMatchObject({ done: true, outputId: "o1", result: { format: "quiz", score: 0.5, passed: true, correct: 1, topicsMissed: ["onto"] } });
});

test("a quiz says its verdict once, whatever the written feedback opens with", async () => {
  const quizOut = {
    id: "o1", type: "quiz", title: "Check", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    payload: {
      title: "Check", passMark: 0.5, feedback: "afterEach",
      questions: [
        { id: "q1", kind: "choice", topic: "t", prompt: "Pick", points: 1, options: ["one", "two"], answer: 0, optionFeedback: ["Right: one is it.", "Wrong. Two misreads the rule."], feedback: { correct: "Correct, one.", incorrect: "Not quite. The rule says one." }, cites: [] },
      ],
    },
  };
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: quizOut } });
  const card = await screen.findByLabelText("Question 1 of 1");
  await userEvent.click(within(card).getByRole("button", { name: /two/ }));
  const box = document.querySelector(".fb2")!;
  expect(box.textContent).toBe("Not quite. Two misreads the rule. The rule says one.");
  expect(card.textContent).not.toMatch(/Wrong/);
});

test("a worked question: one box a step with its unit and form, equivalent answers right, a shown step costs only that step", async () => {
  const quizOut = {
    id: "o1", type: "quiz", title: "Check", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    payload: {
      title: "Check", passMark: 0.5, feedback: "afterEach",
      questions: [
        {
          id: "q1", kind: "worked", topic: "t", prompt: "Work it out", points: 1, feedback: { correct: "Both steps hold.", incorrect: "Multiply first." }, cites: [],
          steps: [
            { prompt: "The area?", input: "entries", values: ["52.5", "52.50"], unit: "cm²", form: "to one decimal place" },
            { prompt: "Half of it?", input: "entries", values: ["26.25"] },
          ],
        },
      ],
    },
  };
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: quizOut } });
  const card = await screen.findByLabelText("Question 1 of 1");
  // An older step listing one answer two ways is one box.
  expect(within(card).getAllByRole("textbox")).toHaveLength(1);
  expect(within(card).getByText("cm²")).toBeInTheDocument();
  expect(within(card).getByText("to one decimal place")).toBeInTheDocument();
  await userEvent.type(within(card).getByLabelText("Step 1 answer"), "52,50 cm²");
  await userEvent.click(within(card).getByRole("button", { name: "Check" }));
  expect(within(card).getByText("Right.")).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: /Show this step/ }));
  expect(card.textContent).toMatch(/Shown: 26\.25\. This step doesn't count; the others still do\./);
  expect(document.querySelector(".fb2")?.textContent).toBe("1 of 2 steps right. The step you were shown doesn't count; the others do. Multiply first.");
});

test("a link to something that is not there says so calmly, with a way home", async () => {
  renderApp("/outputs/gone", {});
  expect(await screen.findByText("Can't find this item")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
});

/** A quiz of one question of `kind`, as the engine stores it. */
function oneQuestion(question: Record<string, unknown>, feedback: "afterEach" | "atEnd" = "afterEach") {
  return {
    id: "o1", type: "quiz", title: "Check", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    payload: { title: "Check", passMark: 0.5, feedback, questions: [{ id: "q1", topic: "t", prompt: "Answer it", points: 1, feedback: { correct: "Because the source says so.", incorrect: "The source puts it otherwise." }, cites: [], ...question }] },
  };
}

test("put in order: shown mixed, moved into order, checked, with the right order shown when it was not", async () => {
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: oneQuestion({ kind: "order", items: ["egg", "larva", "pupa"], shown: [2, 0, 1] }) } });
  const card = await screen.findByLabelText("Question 1 of 1");
  const list = within(card).getByRole("list", { name: "Your order" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace(/[↑↓\d]/g, ""))).toEqual(["pupa", "egg", "larva"]);
  expect(within(card).getByRole("button", { name: /Next question|See your result/ })).toBeDisabled();
  // Checked as shown: pupa, egg, larva keeps one neighbouring pair of two (egg before larva).
  await userEvent.click(within(card).getByRole("button", { name: "Check the order" }));
  expect(document.querySelector(".fb2")?.textContent).toMatch(/^0 of 3 in place/);
  expect(within(card).getByText("goes 1st")).toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: /Move/ })).toBeNull();
});

test("match pairs: each left picks a right, offered in the quiz's order; a wrong one shows the right one", async () => {
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: oneQuestion({ kind: "match", pairs: [{ left: "mitosis", right: "two cells" }, { left: "meiosis", right: "four cells" }], rights: [1, 0] }) } });
  const card = await screen.findByLabelText("Question 1 of 1");
  const first = within(card).getByLabelText("Match for mitosis");
  expect(within(first).getAllByRole("option").slice(1).map((o) => o.textContent)).toEqual(["four cells", "two cells"]);
  expect(within(card).getByRole("button", { name: "Check" })).toBeDisabled();
  await userEvent.selectOptions(first, "two cells");
  await userEvent.selectOptions(within(card).getByLabelText("Match for meiosis"), "two cells");
  await userEvent.click(within(card).getByRole("button", { name: "Check" }));
  expect(document.querySelector(".fb2")?.textContent).toMatch(/The source puts it otherwise\./);
  expect(within(card).getByText("four cells", { selector: "small" })).toBeInTheDocument();
});

test("label a picture: the source's picture through the engine, a name picked for each of its marks", async () => {
  renderApp("/outputs/o1", {
    ...routes(),
    "GET /v1/outputs/:id": { output: oneQuestion({ kind: "label", picture: { url: "/v1/assets/abc", caption: "A plant cell" }, marks: [{ mark: "A", answer: "nucleus" }, { mark: "B", answer: "wall" }], names: ["wall", "ribosome", "nucleus"] }) },
  });
  const card = await screen.findByLabelText("Question 1 of 1");
  expect(within(card).getByRole("img", { name: "A plant cell" })).toHaveAttribute("src", "/api/v1/assets/abc");
  await userEvent.selectOptions(within(card).getByLabelText("What A is"), "nucleus");
  await userEvent.selectOptions(within(card).getByLabelText("What B is"), "wall");
  await userEvent.click(within(card).getByRole("button", { name: "Check" }));
  expect(document.querySelector(".fb2")?.textContent).toMatch(/^Right\./);
});

test("a line on a graph: two points typed in draw the line, checked against the right one", async () => {
  renderApp("/outputs/o1", {
    ...routes(),
    "GET /v1/outputs/:id": { output: oneQuestion({ kind: "graph", axes: { x: { min: 0, max: 10, step: 1, label: "hours" }, y: { min: 0, max: 50, step: 5 } }, line: [[0, 10], [4, 30]] }) },
  });
  const card = await screen.findByLabelText("Question 1 of 1");
  expect(within(card).getByRole("button", { name: "Check the line" })).toBeDisabled();
  await userEvent.type(within(card).getByLabelText("Point 1 hours"), "1");
  await userEvent.type(within(card).getByLabelText("Point 1 y"), "15");
  await userEvent.type(within(card).getByLabelText("Point 2 hours"), "3");
  await userEvent.type(within(card).getByLabelText("Point 2 y"), "25");
  expect(card.querySelector(".qgraph .ul")).not.toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: "Check the line" }));
  expect(document.querySelector(".fb2")?.textContent).toMatch(/^Right\./);
  expect(card.querySelector(".qgraph .rl")).not.toBeNull();
});

test("fill in the working: a box for each gap, number forms accepted, a wrong gap shows its answer", async () => {
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: oneQuestion({ kind: "complete", lines: ["v = d / t", "v = 120 / [[4]] = [[30]] km/h"] }) } });
  const card = await screen.findByLabelText("Question 1 of 1");
  expect(within(card).getByText("v = d / t")).toBeInTheDocument();
  await userEvent.type(within(card).getByLabelText("Gap 1"), "4.0");
  await userEvent.type(within(card).getByLabelText("Gap 2"), "40");
  await userEvent.click(within(card).getByRole("button", { name: "Check" }));
  expect(within(card).getByLabelText("Gap 1")).toBeDisabled();
  expect(within(card).getByText("30", { selector: "small" })).toBeInTheDocument();
  expect(document.querySelector(".fb2")?.textContent).toMatch(/The source puts it otherwise\./);
});

test("with feedback at the end, a new kind keeps the answer without saying right or wrong", async () => {
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: oneQuestion({ kind: "order", items: ["a", "b", "c"], shown: [1, 0, 2] }, "atEnd") } });
  const card = await screen.findByLabelText("Question 1 of 1");
  await userEvent.click(within(card).getByRole("button", { name: "Move down: b" }));
  await userEvent.click(within(card).getByRole("button", { name: "Check the order" }));
  expect(document.querySelector(".fb2")).toBeNull();
  expect(card.querySelector(".order .right, .order .wrong")).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: /See your result/ }));
  expect(within(screen.getByLabelText("Your result")).getByRole("heading", { name: "1 of 1" })).toBeInTheDocument();
});

/** A practice exam: two questions on two topics, timed, feedback at the end, in a plan so its result is saved. */
function timedQuiz(timeLimit = 30) {
  return {
    id: "o1", type: "quiz", title: "Practice exam", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    projectId: "p1", planId: "pl1", itemId: "i1",
    payload: {
      title: "Practice exam", passMark: 0.5, feedback: "atEnd", timeLimit,
      questions: [
        { id: "q1", kind: "choice", topic: "Rank", prompt: "Rank of I₂?", points: 2, options: ["1", "2"], answer: 1, feedback: { correct: "Two pivots.", incorrect: "Count the pivots." }, cites: [] },
        { id: "q2", kind: "choice", topic: "Onto", prompt: "Which is onto?", points: 1, options: ["A wide matrix with full rank", "A tall matrix"], answer: 0, feedback: { correct: "Its columns span.", incorrect: "Columns must span." }, cites: [] },
      ],
    },
  };
}

test("a practice exam waits for Start, runs a clock, holds feedback, then gives a mark, the time taken and what was missed", { timeout: 20_000 }, async () => {
  const { calls } = renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: timedQuiz() }, "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } } });
  const start = await screen.findByLabelText("Before you start");
  expect(within(start).getByRole("heading", { name: "2 questions in 30 minutes" })).toBeInTheDocument();
  expect(screen.queryByText("Rank of I₂?")).toBeNull();
  expect(screen.queryByRole("timer")).toBeNull();
  await userEvent.click(within(start).getByRole("button", { name: /Start/ }));
  expect(screen.getByRole("timer")).toHaveTextContent(/^(30:00|29:5\d) left$/);
  // Where it started is kept, so the clock runs on another device too.
  await expect.poll(() => (calls.findLast((c) => c.path === "/v1/plans/pl1/items/i1/progress")?.body as { progress: { startedAt?: number } } | undefined)?.progress.startedAt).toBeTypeOf("number");
  const first = screen.getByLabelText("Question 1 of 2");
  await userEvent.click(within(first).getByRole("button", { name: /^B/ }));
  expect(document.querySelector(".fb2")).toBeNull();
  expect(within(first).getByText("Feedback comes at the end")).toBeInTheDocument();
  await userEvent.click(within(first).getByRole("button", { name: /Next question/ }));
  await userEvent.click(within(screen.getByLabelText("Question 2 of 2")).getByRole("button", { name: /A tall matrix/ }));
  await userEvent.click(screen.getByRole("button", { name: /See your result/ }));

  const sum = screen.getByLabelText("Your result");
  expect(within(sum).getByRole("heading", { name: "1 of 2" })).toBeInTheDocument();
  expect(within(sum).getByText("67% · the pass mark is 50%")).toBeInTheDocument();
  expect(within(sum).getByText("Done in under a minute of 30.")).toBeInTheDocument();
  expect(screen.queryByRole("timer")).toBeNull();
  const missed = within(sum).getByRole("list", { name: "What you missed" });
  expect(within(missed).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Onto. Columns must span."]);
  await expect.poll(() => calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")).toBeDefined();
  const body = calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")?.body as { result: Record<string, unknown> };
  expect(body.result).toMatchObject({ format: "quiz", score: 0.6667, timedOut: false, topicsMissed: ["Onto"] });
  expect(body.result.seconds).toBeTypeOf("number");

  // Looking back, the answers are fixed and each shows its feedback.
  await userEvent.click(within(sum).getByRole("button", { name: "See the answers" }));
  const back = screen.getByLabelText("Question 1 of 2");
  expect(document.querySelector(".fb2")?.textContent).toMatch(/Two pivots\./);
  await userEvent.click(within(back).getByRole("button", { name: /^A(?!sk)/ }));
  expect(document.querySelector(".fb2")?.textContent).toMatch(/Two pivots\./);
  await userEvent.click(within(back).getByRole("button", { name: /Next question/ }));
  await userEvent.click(screen.getByRole("button", { name: /Back to your result/ }));
  expect(within(screen.getByLabelText("Your result")).getByRole("heading", { name: "1 of 2" })).toBeInTheDocument();
});

test("a practice exam reopened after its time ran out has ended with what was answered", async () => {
  const r = routes();
  const plan = r["GET /v1/plans/:id"]();
  plan.items[0] = { ...plan.items[0]!, progress: { at: 1, responses: { q1: { choice: 1 } }, ended: false, startedAt: Date.now() - 31 * 60_000 } } as (typeof plan.items)[number];
  renderApp("/outputs/o1", { ...r, "GET /v1/outputs/:id": { output: timedQuiz() }, "GET /v1/plans/:id": plan, "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } } });
  const sum = await screen.findByLabelText("Your result");
  expect(within(sum).getByRole("heading", { name: "1 of 2" })).toBeInTheDocument();
  expect(within(sum).getByText("Time ran out after 30 minutes; what was left unanswered counts as skipped.")).toBeInTheDocument();
});

test("a practice exam ends as it stands when the clock reaches zero", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: timedQuiz(1) }, "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(await screen.findByLabelText("Before you start")).getByRole("button", { name: /Start/ }));
    await user.click(within(screen.getByLabelText("Question 1 of 2")).getByRole("button", { name: /^B/ }));
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    const sum = screen.getByLabelText("Your result");
    expect(within(sum).getByText("Time ran out after 1 minute; what was left unanswered counts as skipped.")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("a practice exam tells a screen reader once at 5 minutes left and once at 1 minute", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: timedQuiz(10) }, "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(await screen.findByLabelText("Before you start")).getByRole("button", { name: /Start/ }));
    const live = document.querySelector("[aria-live='polite'].sr")!;
    expect(live.textContent).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(live.textContent).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(live.textContent).toBe("5 minutes left");
    await act(() => vi.advanceTimersByTimeAsync(3 * 60_000));
    expect(live.textContent).toBe("5 minutes left");
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(live.textContent).toBe("1 minute left");
  } finally {
    vi.useRealTimers();
  }
});

test("a thing's player is told what the plan makes from its result: the items that branch from it", async () => {
  const r = routes();
  const plan = r["GET /v1/plans/:id"]();
  plan.items[1] = { ...plan.items[1]!, parentId: "i1", condition: { kind: "metric", metric: "score", below: 0.7 }, title: "Fix what you missed" } as (typeof plan.items)[number];
  const seen = vi.fn();
  const registry = await import("./registry");
  const draw = vi.spyOn(registry, "renderPlayer").mockImplementation((_f, _t, props) => (seen(props.branches), null));
  renderApp("/outputs/o1", { ...r, "GET /v1/plans/:id": plan });
  await waitFor(() => expect(seen).toHaveBeenLastCalledWith([{ title: "Fix what you missed", condition: { kind: "metric", metric: "score", below: 0.7 }, made: true }]));
  draw.mockRestore();
});

test("flashcards draw the sitting on the player's line, a piece per card, and up and down go to the thing before and after once", async () => {
  renderApp("/outputs/o1", { ...routes(), "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } } });
  const card = await screen.findByLabelText("Card 1 of 3");
  const line = () => screen.getByRole("progressbar", { name: "Where you are" });
  expect(await screen.findByRole("progressbar", { name: "Where you are" })).toHaveAttribute("aria-valuemax", "3");
  expect(line().querySelectorAll(".pc-seg.now")).toHaveLength(1);
  await userEvent.click(within(card).getByText("When does a limit exist?"));
  await userEvent.click(screen.getByRole("button", { name: /Not yet/ }));
  // Missed: amber on the line, and the card comes back, so the sitting is a piece longer.
  expect(line()).toHaveAttribute("aria-valuemax", "4");
  expect(line().querySelectorAll(".pc-seg.warn")).toHaveLength(1);
  expect(line()).toHaveAttribute("aria-valuenow", "1");
  // ↓ is the player's: one step to the next thing, never a second one from the cards.
  await userEvent.keyboard("{ArrowDown}");
  expect(await screen.findByRole("heading", { name: "Set o2" })).toBeInTheDocument();
});

test("a quiz draws how far through it is on the player's line, and its result says where the plan goes on from it", async () => {
  const r = routes();
  const plan = r["GET /v1/plans/:id"]();
  plan.items[1] = { ...plan.items[1]!, parentId: "i1", condition: { kind: "metric", metric: "score", below: 0.7 }, title: "Fix what you missed" } as (typeof plan.items)[number];
  plan.items[2] = { ...plan.items[2]!, parentId: "i1", condition: { kind: "metric", metric: "score", atLeast: 0.7 }, title: "Go further" } as (typeof plan.items)[number];
  const quizOut = {
    id: "o1", type: "quiz", title: "Check yourself", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    projectId: "p1", planId: "pl1", itemId: "i1",
    payload: {
      title: "Check yourself", passMark: 0.5, feedback: "afterEach",
      questions: [
        { id: "q1", kind: "choice", topic: "onto", prompt: "Which is onto?", points: 1, options: ["A wide matrix with full rank", "A tall matrix"], answer: 0, feedback: { correct: "Yes.", incorrect: "Columns must span." }, cites: [] },
        { id: "q2", kind: "choice", topic: "rank", prompt: "Rank of I₂?", points: 1, options: ["1", "2"], answer: 1, feedback: { correct: "Two pivots.", incorrect: "Count the pivots." }, cites: [] },
      ],
    },
  };
  renderApp("/outputs/o1", { ...r, "GET /v1/plans/:id": plan, "GET /v1/outputs/:id": { output: quizOut } });
  const card = await screen.findByLabelText("Question 1 of 2");
  const line = () => screen.getByRole("progressbar", { name: "Where you are" });
  expect(await screen.findByRole("progressbar", { name: "Where you are" })).toHaveAttribute("aria-valuenow", "0");
  await userEvent.click(within(card).getByRole("button", { name: /A tall matrix/ }));
  expect(line()).toHaveAttribute("aria-valuenow", "50");
  await userEvent.click(within(card).getByRole("button", { name: /Next question/ }));
  await screen.findByLabelText("Question 2 of 2");
  await userEvent.keyboard("b");
  await userEvent.click(screen.getByRole("button", { name: /See your result/ }));
  const sum = screen.getByLabelText("Your result");
  expect(line()).toHaveAttribute("aria-valuenow", "100");
  // 50% is under 70%: only that branch is said, the other one does not hold.
  expect(sum).toHaveTextContent("Since you scored under 70%, your plan goes on to Fix what you missed, ready now.");
  expect(sum).not.toHaveTextContent("Go further");
});

test("a guide's Change it and Print sit in the player's bar", async () => {
  const guideOut = {
    id: "o1", type: "guide", title: "Notes", schemaVersion: 1, createdAt: now, updatedAt: now, citations: [], sources: [],
    projectId: "p1", planId: "pl1", itemId: "i1",
    payload: { schemaVersion: 1, title: "Notes", sections: [{ id: "s1", title: "One", points: [{ id: "p1", text: "A point.", background: false, cites: [] }] }] },
  };
  renderApp("/outputs/o1", { ...routes(), "GET /v1/outputs/:id": { output: guideOut } });
  expect(await screen.findByText("A point.")).toBeInTheDocument();
  const bar = document.querySelector<HTMLElement>(".pc-bar")!;
  expect(within(bar).getByRole("button", { name: "Print" })).toBeInTheDocument();
  await userEvent.click(within(bar).getByRole("button", { name: "Change it" }));
  expect(within(bar).getByRole("button", { name: "Done changing" })).toBeInTheDocument();
  expect(document.querySelector(".gtools")).toBeNull();
});
