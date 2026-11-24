import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "../api/types";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

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
const item = (id: string, outputId: string | undefined, done = false) => ({
  id, level: 1, ord: Number(id.slice(1)), type: "flashcards", title: `Item ${id}`, settings: {}, enabled: true, status: outputId ? "done" : "pending", sources: [], done, ...(outputId ? { outputId } : {}),
});

function routes(progress?: JsonObject) {
  return {
    "GET /v1/outputs/:id": ({ params }: { params: Record<string, string> }) => ({ output: output(params.id!, { projectId: "p1", planId: "pl1", itemId: "i1" }) }),
    "GET /v1/projects/:id": { project: { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now } },
    "GET /v1/sources/:id": { source: { id: "s1", kind: "pdf", title: "Week 3", createdAt: now, updatedAt: now }, extraction: { contentHash: "h", kind: "pdf", status: "ready", createdAt: now, updatedAt: now }, chunkCount: 1 },
    "GET /v1/plans/:id": {
      plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "running", createdAt: now, updatedAt: now, kickedOffAt: now },
      stages: [], edges: [], counts: { total: 2, done: 0 }, estimateUsd: 0, issues: [],
      items: [{ ...item("i1", "o1"), ...(progress ? { progress } : {}) }, item("i2", "o2")],
    },
    "POST /v1/plans/:id/items/:itemId/done": { item: { id: "i1", done: true }, counts: { total: 2, done: 1 } },
    "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } },
  };
}

// Many steps in a row, each waiting on a load or a click: more time under a busy test run, the same checks.
test("a set plays one card at a time: turned over, marked got it or not yet, a missed card back in the sitting, ticked done at the end", { timeout: 30_000 }, async () => {
  const { calls } = renderApp("/outputs/o1", routes());
  const card = await screen.findByLabelText("Card 1 of 3", undefined, { timeout: 10_000 });
  expect(within(card).getByText("When does a limit exist?")).toBeInTheDocument();
  expect(within(card).getByText("Warm-up")).toBeInTheDocument();
  // The kind of card, in the format's own words.
  expect(within(card).getByText("Front and back")).toBeInTheDocument();
  expect(screen.getByText("Card 1 of 3")).toBeInTheDocument();
  // The answer, and its cite, wait for the turn; nothing on the screen tells the person to tap.
  expect(within(card).queryByText("When both sides agree.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Got it" })).not.toBeInTheDocument();
  expect(screen.queryByText(/tap/i)).not.toBeInTheDocument();
  await userEvent.click(within(card).getByText("When does a limit exist?"));
  const back = screen.getByLabelText("Card 1 of 3, turned over");
  expect(within(back).getByText("When both sides agree.")).toBeInTheDocument();
  expect(await within(back).findByRole("link", { name: /Week 3/ })).toHaveAttribute("href", "/sources/s1");
  // Missed: kept as due again soon, with when it was marked, and the card comes back later in this sitting.
  await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
  await expect.poll(() => (calls.findLast((c) => c.path === "/v1/plans/pl1/items/i1/progress")?.body as { progress: { cards: Record<string, { box: number; last?: number }> } } | undefined)?.progress.cards.c1).toMatchObject({ box: 0, last: expect.any(Number) });
  // A cloze hides its key part until it is turned over, by space here.
  const cloze = screen.getByLabelText("Card 2 of 4");
  expect(within(cloze).queryByText("left")).not.toBeInTheDocument();
  await userEvent.keyboard(" ");
  expect(within(screen.getByLabelText("Card 2 of 4, turned over")).getByText("left")).toBeInTheDocument();
  await userEvent.keyboard("2");
  // A card that asks is marked by its answer.
  const asks = screen.getByLabelText("Card 3 of 4");
  await userEvent.click(within(asks).getByRole("button", { name: "b" }));
  expect(within(asks).getByText("b is right")).toBeInTheDocument();
  expect(screen.getByText(/Got it: back tomorrow/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  // The missed card is back.
  const again = screen.getByLabelText("Card 4 of 4");
  expect(within(again).getByText("When does a limit exist?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Turn over" }));
  await userEvent.click(screen.getByRole("button", { name: "Got it" }));
  // The end says what was got and when they come back, and the plan item is ticked done with it.
  expect(await screen.findByText("That's the set, for now")).toBeInTheDocument();
  expect(screen.getByText(/Coming back: 3 tomorrow/)).toBeInTheDocument();
  await expect.poll(() => calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")?.body).toMatchObject({ done: true, outputId: "o1", result: { cards: 3, learned: 0, got: 3, missed: 1 } });
  expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
});

test("a set gone through before opens on a review of what is due, says when each was last marked, and goes back to all the cards in one click", async () => {
  const past = Date.now() - 60_000;
  const later = Date.now() + 3 * 86_400_000;
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  renderApp("/outputs/o1", routes({ card: 2, cards: { c1: { box: 1, due: past, seen: 1, missed: 0 }, c2: { box: 2, due: later, seen: 2, missed: 0 }, c3: { box: 0, due: past, seen: 1, missed: 1, last: twoDaysAgo } } }));
  expect(await screen.findByText("Review · 2 due")).toBeInTheDocument();
  expect(screen.getByText("card 1 of 2")).toBeInTheDocument();
  expect(screen.getByLabelText("Card 1 of 2")).toHaveTextContent("When does a limit exist?");
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByLabelText("Card 2 of 2")).toHaveTextContent("You missed this one 2 days ago.");
  await userEvent.keyboard("{ArrowRight}");
  expect(await screen.findByText("Review done")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Go through all 3 again" }));
  expect(screen.getByText("Card 1 of 3")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Review 2 due" }));
  expect(screen.getByText("Review · 2 due")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "All 3 cards" }));
  expect(screen.getByText("Card 1 of 3")).toBeInTheDocument();
});

test("a set opens on the card the person stopped at, and keeps where they go next", async () => {
  const { calls } = renderApp("/outputs/o1", routes({ card: 1 }));
  expect(await screen.findByLabelText("Card 2 of 3")).toBeInTheDocument();
  // Opening it writes nothing; moving does.
  expect(calls.some((c) => c.path.endsWith("/progress"))).toBe(false);
  await userEvent.keyboard("{ArrowLeft}");
  expect(screen.getByLabelText("Card 1 of 3")).toBeInTheDocument();
  await expect.poll(() => calls.find((c) => c.path === "/v1/plans/pl1/items/i1/progress")?.body).toEqual({ progress: { card: 0, cards: {} } });
});

test("a byte stored before cards still opens: its screens are cards to read", async () => {
  const old = {
    id: "o9", type: "flashcards", title: "Old byte", schemaVersion: 2, createdAt: now, updatedAt: now, citations: [],
    payload: { schemaVersion: 2, title: "Old byte", bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: "An old screen." }], cites: [] }] },
  };
  renderApp("/outputs/o9", { "GET /v1/outputs/:id": { output: old } });
  const card = await screen.findByLabelText("Card 1 of 1");
  expect(within(card).getByText("An old screen.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Finish" }));
  expect(await screen.findByText("The end of the set")).toBeInTheDocument();
});

test("the player draws no edges of a plan, no hints and no bar of its own: those are the frame's", async () => {
  renderApp("/outputs/o1", routes());
  await screen.findByLabelText("Card 1 of 3");
  expect(screen.queryByRole("button", { name: /Next thing|Previous thing/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/in the plan/)).not.toBeInTheDocument();
  expect(document.querySelector(".bhint, .fcbar, .fcrail")).toBeNull();
});
