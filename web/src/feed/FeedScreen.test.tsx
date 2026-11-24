import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const later = "2026-11-12T11:00:00.000Z";
const setCards = [
  { id: "c1", kind: "recall", front: [{ type: "text", text: "Card one?" }], back: [{ type: "text", text: "Answer one." }], cites: [{ sourceId: "s1", spot: "p. 2", quote: "limits exist", block: 1 }] },
  { id: "c2", kind: "recall", front: [{ type: "text", text: "Card two?" }], back: [{ type: "text", text: "Answer two." }], cites: [] },
  { id: "c3", kind: "recall", front: [{ type: "text", text: "Card three?" }], back: [{ type: "text", text: "Answer three." }], cites: [] },
];
const quizQuestions = [
  { id: "q1", kind: "choice", topic: "limits", prompt: "Does the limit exist?", points: 1, options: ["Yes", "No"], answer: 0, feedback: { correct: "Both sides agree.", incorrect: "Look at both sides." }, cites: [] },
  { id: "q2", kind: "choice", topic: "limits", prompt: "Is it continuous?", points: 1, options: ["Yes", "No"], answer: 1, feedback: { correct: "There is a jump there.", incorrect: "Look for a jump." }, cites: [] },
];
const summary = (id: string, type: string, title: string, itemId: string, createdAt: string) => ({ id, type, title, schemaVersion: 1, createdAt, updatedAt: createdAt, projectId: "p1", planId: "pl1", itemId });
const full = (id: string) =>
  id === "o-set"
    ? { ...summary("o-set", "flashcards", "Limits, in short", "i1", now), payload: { schemaVersion: 3, id, title: "Limits", cards: setCards }, citations: [{ sourceId: "s1" }], sources: [{ sourceId: "s1" }] }
    : { ...summary("o-quiz", "quiz", "Check yourself", "i2", later), payload: { title: "Check", passMark: 0.5, feedback: "afterEach", questions: quizQuestions }, citations: [], sources: [] };

function routes(state: { progress?: Record<string, unknown>; done?: Record<string, boolean> } = {}) {
  const item = (id: string, outputId: string, ord: number, type: string) => ({
    id, level: 0, ord, type, title: id, settings: {}, enabled: true, status: "done", sources: [], outputId,
    done: state.done?.[id] === true, ...(state.progress?.[id] ? { progress: state.progress[id] } : {}),
  });
  return {
    "GET /v1/outputs": { outputs: [summary("o-quiz", "quiz", "Check yourself", "i2", later), summary("o-set", "flashcards", "Limits, in short", "i1", now)] },
    "GET /v1/projects": { projects: [{ id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now }] },
    "GET /v1/projects/:id": { project: { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now } },
    "GET /v1/outputs/:id": ({ params }: { params: Record<string, string> }) => ({ output: full(params.id!) }),
    "GET /v1/sources/:id": { source: { id: "s1", kind: "text", title: "Week 3 notes", createdAt: now, updatedAt: now }, extraction: { contentHash: "h", kind: "text", status: "ready", createdAt: now, updatedAt: now }, chunkCount: 1 },
    "GET /v1/plans/:id": () => ({
      plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "done", createdAt: now, updatedAt: now, kickedOffAt: now },
      stages: [], edges: [], counts: { total: 2, done: 0 }, estimateUsd: 0, issues: [],
      items: [item("i1", "o-set", 0, "flashcards"), item("i2", "o-quiz", 1, "quiz")],
    }),
    "POST /v1/plans/:id/items/:itemId/done": ({ params }: { params: Record<string, string> }) => ({ item: { id: params.itemId, done: true }, counts: { total: 2, done: 1 } }),
    "POST /v1/plans/:id/items/:itemId/progress": ({ params }: { params: Record<string, string> }) => ({ item: { id: params.itemId } }),
  };
}

/** The things in the feed, without the end card after them. */
const things = () => screen.getAllByRole("region").filter((r) => r.getAttribute("aria-label") !== "The end");
const current = () => document.querySelector<HTMLElement>(".pslide[aria-current='true']")!;

test("the feed shows one thing per screen in plan order, and the next is a scroll away", async () => {
  const { calls } = renderApp("/feed", routes());
  // Both are unfinished and in one plan, so plan order: the set (item 1) comes before the quiz (item 2).
  expect(await within(await screen.findByRole("region", { name: "Limits, in short" })).findByLabelText("Card 1 of 3")).toBeInTheDocument();
  expect(current()).toHaveAccessibleName("Limits, in short");
  expect(within(current()).getByRole("link", { name: /Calculus I · Unit 1/ })).toHaveAttribute("href", "/projects/p1");
  expect(within(current()).getByRole("button", { name: "Talk about Limits, in short" })).toBeInTheDocument();

  // The feed scrolls by a screen; when it settles on the next one, the one scrolled past is ticked done.
  const box = screen.getByLabelText("Feed", { selector: ".pfeed" });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 800 });
  box.scrollTop = 800;
  fireEvent.scroll(box);
  await waitFor(() => expect(current()).toHaveAccessibleName("Check yourself"));
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/plans/pl1/items/i1/done")?.body).toEqual({ done: true, outputId: "o-set" });
});

test("a set's cards swipe sideways inside its screen, turn over with a tap, and what was got is kept", async () => {
  const { calls } = renderApp("/feed", routes());
  const first = await screen.findByLabelText("Card 1 of 3");
  const stage = first.closest(".fcstage")!;
  fireEvent.touchStart(stage, { touches: [{ clientX: 300, clientY: 400 }] });
  fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 120, clientY: 410 }] });
  expect(await screen.findByLabelText("Card 2 of 3")).toBeInTheDocument();
  // A mostly vertical move is the feed's, not the set's.
  fireEvent.touchStart(stage, { touches: [{ clientX: 300, clientY: 600 }] });
  fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 250, clientY: 200 }] });
  expect(screen.getByLabelText("Card 2 of 3")).toBeInTheDocument();
  await waitFor(() => expect(calls.filter((c) => c.path === "/v1/plans/pl1/items/i1/progress").map((c) => c.body)).toEqual([{ progress: { card: 1, cards: {} } }]));
  await userEvent.click(within(screen.getByLabelText("Card 2 of 3")).getByText("Card two?"));
  await userEvent.click(within(current()).getByRole("button", { name: /Got it/ }));
  await waitFor(() => expect((calls.filter((c) => c.path === "/v1/plans/pl1/items/i1/progress").at(-1)?.body as { progress: { cards: Record<string, { box: number }> } }).progress.cards.c2?.box).toBe(1));
  expect(screen.getByLabelText("Card 3 of 3")).toBeInTheDocument();
});

test("a set with cards due comes first in the feed, finished or not, and opens on reviewing them", async () => {
  const past = Date.now() - 60_000;
  const seen = (box: number, due: number) => ({ box, due, seen: 1, missed: 0 });
  renderApp("/feed", routes({ done: { i1: true }, progress: { i1: { card: 2, cards: { c1: seen(1, past), c2: seen(2, Date.now() + 86_400_000), c3: seen(0, past) } } } }));
  expect(await screen.findByLabelText("Card 1 of 2")).toBeInTheDocument();
  expect(current()).toHaveAccessibleName("Limits, in short");
  expect(within(current()).getByText("Review · 2 due")).toBeInTheDocument();
});

test("a cite and the sources open the passage they came from", async () => {
  renderApp("/feed", routes());
  const card = await screen.findByLabelText("Card 1 of 3");
  await userEvent.click(within(card).getByText("Card one?"));
  // A small number at the claim, as in the chat, opening the source at the quoted words; on the back, after the turn.
  expect(await within(screen.getByLabelText("Card 1 of 3, turned over")).findByRole("link", { name: /^Source 1: Week 3 notes/ })).toHaveAttribute("href", "/sources/s1?quote=limits+exist");
  // The feed's round buttons have their own class, apart from the shared filled button.
  expect(within(current()).getByRole("button", { name: "Sources" })).toHaveClass("fbtn");
  expect(within(current()).getByRole("button", { name: "Sources" })).not.toHaveClass("pbtn");
  await userEvent.click(within(current()).getByRole("button", { name: "Sources" }));
  expect(await within(screen.getByRole("dialog", { name: "Sources" })).findByRole("link", { name: /Week 3 notes/ })).toHaveAttribute("href", "/sources/s1");
});

test("a quiz is answered in place, with its feedback, and opens again where the person stopped", async () => {
  // The set is finished, so the unfinished quiz comes first; its first answer was given on another device.
  const { calls } = renderApp("/feed", routes({ done: { i1: true }, progress: { i2: { at: 1, responses: { q1: { choice: 0 } }, ended: false } } }));
  const card = await screen.findByLabelText("Question 2 of 2");
  expect(current()).toHaveAccessibleName("Check yourself");
  expect(within(current()).getByText("1 right so far")).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: /No/ }));
  expect(within(card).getByText("There is a jump there.", { exact: false })).toBeInTheDocument();
  await waitFor(() =>
    expect(calls.filter((c) => c.path === "/v1/plans/pl1/items/i2/progress").at(-1)?.body).toEqual({ progress: { at: 1, responses: { q1: { choice: 0 }, q2: { choice: 1 } }, ended: false } }),
  );
  await userEvent.click(within(card).getByRole("button", { name: /See your result/ }));
  expect(within(current()).getByRole("heading", { name: "2 of 2" })).toBeInTheDocument();
});

test("when the computer is away the phone says so, and carries on by itself when it is back", { timeout: 15_000 }, async () => {
  let away = true;
  const r = routes();
  renderApp("/feed", {
    ...r,
    "GET /v1/outputs": () => {
      if (away) throw new TypeError("Failed to fetch");
      return r["GET /v1/outputs"];
    },
  });
  expect(await screen.findByText("Open Sourcebook runs on your computer. It isn't reachable right now.")).toBeInTheDocument();
  away = false;
  expect(await screen.findByLabelText("Card 1 of 3", undefined, { timeout: 8000 })).toBeInTheDocument();
});

test("a device that is no longer paired is told to scan the code again", async () => {
  renderApp("/feed", { ...routes(), "GET /v1/outputs": [401, { error: "not_paired", message: "Scan the code on your computer to open Open Sourcebook here." }] });
  expect(await screen.findByRole("heading", { name: "Scan the code on your computer" })).toBeInTheDocument();
});

function asPhone<T>(run: () => Promise<T>): Promise<T> {
  const before = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  return run().finally(() => {
    window.matchMedia = before;
  });
}

test("on a phone Home is the projects, and the Library tab is the feed", async () => {
  await asPhone(async () => {
    renderApp("/", { ...routes(), "GET /v1/projects/:id/outputs": { outputs: [] }, "GET /v1/projects/:id/plans": { plans: [] } });
    // Projects first, not the feed.
    expect(await screen.findByRole("link", { name: /Calculus I/ })).toHaveAttribute("href", "/projects/p1");
    expect(screen.queryByLabelText("Card 1 of 3")).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Library" }));
    expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
    // The feed wears the same bar: the tabs, with Library marked, and search.
    const tabs = within(screen.getByRole("navigation", { name: "Main" }));
    expect(tabs.getByRole("link", { name: "Library" })).toHaveClass("active");
    expect(tabs.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("searchbox", { name: "Search the Library" })).toBeInTheDocument();
  });
});

test("the old feed address still opens the feed, under the Library tab", async () => {
  renderApp("/feed", routes());
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Library" })).toHaveClass("active");
});

test("the old projects list address goes to Home", async () => {
  renderApp("/projects", routes());
  expect(await screen.findByRole("heading", { name: "Projects", hidden: true })).toBeInTheDocument();
});

test("with nothing made yet, the feed says where things come from", async () => {
  renderApp("/feed", { ...routes(), "GET /v1/outputs": { outputs: [] } });
  expect(await screen.findByRole("heading", { name: "Nothing made yet" })).toBeInTheDocument();
});

test("chips narrow the feed to a project, to what is due, and back to every project", async () => {
  const r = routes();
  const other = { id: "o-bio", type: "quiz", title: "Cells, checked", schemaVersion: 1, createdAt: later, updatedAt: later, projectId: "p2" };
  const past = Date.now() - 86_400_000;
  const seen = (box: number, due: number) => ({ box, due, seen: past });
  renderApp("/feed", {
    ...routes({ progress: { i1: { card: 0, cards: { c1: seen(0, past), c2: seen(0, past), c3: seen(0, past) } } } }),
    "GET /v1/outputs": { outputs: [...r["GET /v1/outputs"].outputs, other] },
    "GET /v1/projects": { projects: [...r["GET /v1/projects"].projects, { id: "p2", title: "Biology", settings: {}, createdAt: now, updatedAt: now }] },
    "GET /v1/outputs/:id": ({ params }: { params: Record<string, string> }) =>
      params.id === "o-bio" ? { output: { ...other, payload: { title: "Cells", passMark: 0.5, feedback: "afterEach", questions: quizQuestions }, citations: [], sources: [] } } : { output: full(params.id!) },
  });
  // Every project at once: three things from two projects.
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
  expect(things()).toHaveLength(3);
  const chips = within(screen.getByRole("group", { name: "Show" }));
  expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual(["All projects", "Calculus I", "Biology", "Due · 1"]);
  expect(chips.getByRole("button", { name: "All projects" })).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(chips.getByRole("button", { name: "Biology" }));
  // Only that project now, from its first thing.
  await waitFor(() => expect(things()).toHaveLength(1));
  expect(current()).toHaveAccessibleName("Cells, checked");
  expect(within(current()).getByRole("link", { name: "Biology" })).toHaveAttribute("href", "/projects/p2");
  expect(chips.getByRole("button", { name: "Biology" })).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(chips.getByRole("button", { name: "Due · 1" }));
  await waitFor(() => expect(current()).toHaveAccessibleName("Limits, in short"));
  expect(things()).toHaveLength(1);

  await userEvent.click(chips.getByRole("button", { name: "All projects" }));
  await waitFor(() => expect(things()).toHaveLength(3));
});

test("the bar's search finds a thing by its words, and says so when nothing matches", async () => {
  renderApp("/feed", routes());
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search the Library" }), "check");
  await waitFor(() => expect(things()).toHaveLength(1));
  expect(current()).toHaveAccessibleName("Check yourself");
  await userEvent.type(screen.getByRole("searchbox", { name: "Search the Library" }), "zzz");
  expect(await screen.findByRole("heading", { name: "Nothing matches “checkzzz”" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all projects" }));
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
});

test("a project with nothing in the feed says so and offers the whole feed", async () => {
  renderApp("/feed?project=gone", routes());
  expect(await screen.findByRole("heading", { name: "Nothing here from this project" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all projects" }));
  expect(await screen.findByLabelText("Card 1 of 3")).toBeInTheDocument();
});

test("each thing's line is the player chrome's, at the foot of the thing, and the feed ends on the end card", async () => {
  renderApp("/feed", routes());
  await screen.findByLabelText("Card 1 of 3");
  // The set says its sitting in pieces; the feed draws them, once, along the foot of the thing.
  const line = await within(current()).findByRole("progressbar", { name: "Where you are" });
  expect(line).toHaveAttribute("aria-valuemax", "3");
  expect(line.parentElement).toHaveClass("pplay");
  expect(current().querySelectorAll(".pc-line")).toHaveLength(1);
  await userEvent.keyboard("{ArrowDown}");
  await waitFor(() => expect(current()).toHaveAccessibleName("Check yourself"));
  await userEvent.keyboard("{ArrowDown}");
  const end = await screen.findByRole("region", { name: "The end" });
  expect(end).toHaveTextContent("That's all 2 in this feed");
  expect(end).not.toHaveTextContent("coming");
  await userEvent.click(within(end).getByRole("button", { name: "Back to the first" }));
  await waitFor(() => expect(current()).toHaveAccessibleName("Limits, in short"));
});

test("a video in the feed draws no line of its own: the feed draws the chrome's", async () => {
  const sky = { schemaVersion: 1, title: "Sky", idea: "Blue.", aspect: { width: 9, height: 16 }, scenes: [{ id: "s1", kind: "question", durationMs: 5000, visual: { kind: "photo", description: "Sky." }, narration: "Why?", onScreenText: [], cites: [] }], render: { by: "storyboard", storyboard: true, assetId: "a1", url: "/v1/assets/a1", contentType: "video/mp4", width: 720, height: 1280, fps: 10, durationMs: 5000, audio: false, captions: true, scenes: [{ id: "s1", startMs: 0, endMs: 5000 }], renderMs: 900, madeAt: now } };
  const r = routes();
  renderApp("/feed", {
    ...r,
    "GET /v1/outputs": { outputs: [summary("o-vid", "video", "Why the sky is blue", "i9", now)] },
    "GET /v1/outputs/:id": { output: { ...summary("o-vid", "video", "Why the sky is blue", "i9", now), payload: sky, citations: [], sources: [] } },
  });
  expect(await screen.findByLabelText("Why the sky is blue", { selector: "video" })).toBeInTheDocument();
  await waitFor(() => expect(current().querySelectorAll(".pc-line")).toHaveLength(1));
  expect(current().querySelector(".pc-line")?.parentElement).toHaveClass("pplay");
  expect(current().querySelector(".pplay")).toHaveClass("dark");
});
