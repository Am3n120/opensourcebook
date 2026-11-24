import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Item, Message, PlanView } from "../api/types";
import { now, type FakeRequest } from "../test/fakeEngine";
import { renderApp } from "../test/render";

/**
 * The thread on a made thing (Thread.tsx): opened and closed on the thing,
 * beside it in the Studio and as a sheet in the feed; a message sent with
 * where the person is; the live step while the reply is written, then the
 * reply; a message's spot takes the player there; a quiz offers it under
 * its explanation with the answer given; the chat shows a thread message
 * with a way back to the thing.
 */
const project = { id: "p1", title: "Biology", settings: {}, createdAt: now, updatedAt: now };
const source = { id: "s1", projectId: "p1", kind: "text", title: "Heart notes", status: "ready", createdAt: now, updatedAt: now };
const quizItem: Item = { id: "i1", level: 1, ord: 0, type: "quiz", title: "The heart's loops", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o1" };
const view: PlanView = {
  plan: { id: "pl1", projectId: "p1", title: "The heart's loops", version: 1, status: "done", createdAt: now, updatedAt: now, kickedOffAt: now, direct: true, chatId: "c1" },
  stages: [],
  items: [quizItem],
  edges: [],
  counts: { total: 1, done: 0 },
  estimateUsd: 0,
  issues: [],
};
const quiz = {
  id: "o1", type: "quiz", title: "The heart's loops", projectId: "p1", planId: "pl1", itemId: "i1", citations: [], sources: [], createdAt: now, updatedAt: now,
  payload: {
    title: "Loops", passMark: 0.5, feedback: "afterEach",
    questions: [{ id: "q1", kind: "choice", topic: "loops", prompt: "Where does the right side send blood?", points: 1, options: ["To the body", "To the lungs"], answer: 1, feedback: { correct: "To the lungs.", incorrect: "The right side sends it to the lungs." }, cites: [] }],
  },
};
const chat = { id: "c1", projectId: "p1", title: "Heart", messageCount: 0, createdAt: now, updatedAt: now };
const WRONG = { at: 0, responses: { q1: { choice: 0 } }, ended: false };
const about = { item: "i1", plan: "pl1", output: "o1", format: "quiz", title: "The heart's loops", at: WRONG, label: "question 1 · wrong" };
const asked: Message = { id: "m1", chatId: "c1", seq: 0, role: "user", text: "Why not A?", about, createdAt: now };
const running: Message = { id: "m2", chatId: "c1", seq: 1, role: "assistant", text: "", pieces: [], state: "running", steps: [{ tool: "read_passages", label: "Reading Heart notes", state: "running", startedAt: now }], about, createdAt: now };
const answered: Message = { ...running, state: undefined, text: "A is the left side's loop.", pieces: [{ kind: "text", text: "A is the left side's loop.", cites: [] }] as Message["pieces"], steps: [{ tool: "read_passages", label: "Reading Heart notes", state: "done", startedAt: now }] };

function studioRoutes(thread: { messages: Message[] }, more: Record<string, unknown> = {}) {
  return {
    "GET /v1/projects/:id": { project },
    "GET /v1/projects": { projects: [project] },
    "GET /v1/projects/:id/sources": { sources: [source] },
    "GET /v1/projects/:id/plans": { plans: [{ ...view.plan, counts: view.counts }] },
    "GET /v1/projects/:id/outputs": { outputs: [] },
    "GET /v1/plans/:id": view,
    "GET /v1/projects/:id/chats": { chats: [chat] },
    "GET /v1/chats/:id": { chat, messages: [] },
    "GET /v1/skills": { skills: [], commands: [] },
    "GET /v1/outputs/:id": { output: quiz },
    "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "i1" } },
    "GET /v1/threads": () => ({ threads: thread.messages.length ? [{ itemId: "i1", chatId: "c1", count: thread.messages.length, lastAt: now }] : [] }),
    "GET /v1/plans/:id/items/:itemId/thread": (req: FakeRequest) => ({
      item: { id: "i1", planId: "pl1", projectId: "p1", title: "The heart's loops", type: "quiz", outputId: "o1" },
      chat,
      messages: thread.messages.filter((m) => m.seq > Number(req.query.get("after") ?? -1)),
      ...(req.query.get("at") ? { here: { label: JSON.parse(req.query.get("at")!).responses?.q1 ? "question 1 · wrong" : "question 1" } } : {}),
    }),
    ...more,
  };
}

test("a quiz's explanation offers to ask about it; the thread opens beside it, sends the answer given, shows the live step, then the reply", async () => {
  const thread = { messages: [] as Message[] };
  const { calls } = renderApp("/projects/p1?play=o1", studioRoutes(thread, {
    "POST /v1/plans/:id/items/:itemId/thread": () => {
      thread.messages = [asked, running];
      return { chat, created: false, messages: [asked, running] };
    },
  }));
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  // No thread yet: the button says so, with no count.
  expect(within(playing).getByRole("button", { name: "Talk about this" })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(await within(playing).findByRole("button", { name: /To the body/ }));
  // Under the explanation, the quiet way to ask or disagree.
  await userEvent.click(await within(playing).findByRole("button", { name: "Ask about this, or disagree" }));
  const panel = await screen.findByRole("complementary", { name: "Talk about The heart's loops" });
  expect(panel).toHaveClass("side");
  expect(playing).toHaveClass("threading");
  expect(within(panel).getByText("Talk about this")).toBeInTheDocument();
  // The moment it is about, in the format's words, and where it is saved.
  await waitFor(() => expect(within(panel).getByText("question 1 · wrong", { selector: "small" })).toBeInTheDocument());
  expect(within(panel).getByText("Also saved in your chats as “Heart”")).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "Open in the chat" })).toBeInTheDocument();
  expect(within(panel).getByPlaceholderText("Ask about this moment, or disagree")).toBeInTheDocument();
  // The engine cannot remake one scene, so no such action is shown.
  expect(within(panel).queryByRole("button", { name: /Remake/ })).not.toBeInTheDocument();
  const box = within(panel).getByRole("textbox", { name: "Write about The heart's loops" });
  expect(box).toHaveFocus();
  await userEvent.type(box, "Why not A?{Enter}");
  const sent = calls.find((c) => c.method === "POST" && c.path === "/v1/plans/pl1/items/i1/thread");
  expect(sent?.body).toEqual({ text: "Why not A?", at: WRONG });
  // The message with its spot, and the live step of the reply.
  expect(await within(panel).findByText("Why not A?")).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "question 1 · wrong" })).toBeInTheDocument();
  expect(await within(panel).findByText("Reading Heart notes…")).toBeInTheDocument();
  // The reply lands as the chat's does.
  thread.messages = [asked, answered];
  expect(await within(panel).findByText("A is the left side's loop.", {}, { timeout: 3000 })).toBeInTheDocument();
  // Closed, it stays closed; the button now counts the messages.
  await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("complementary", { name: "Talk about The heart's loops" })).not.toBeInTheDocument();
  await waitFor(() => expect(within(playing).getByRole("button", { name: "Talk about this: 2 messages" })).toBeInTheDocument());
});

test("a message's spot takes the player there", async () => {
  const thread = { messages: [asked, answered] };
  renderApp("/projects/p1?play=o1", studioRoutes(thread));
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  await userEvent.click(await within(playing).findByRole("button", { name: "Talk about this: 2 messages" }));
  const panel = await screen.findByRole("complementary", { name: "Talk about The heart's loops" });
  // The quiz opens at question 1 not yet answered…
  expect(within(playing).queryByText(/The right side sends it to the lungs/)).not.toBeInTheDocument();
  await userEvent.click(await within(panel).findByRole("button", { name: "question 1 · wrong" }));
  // …and the spot puts it back where the message was written: A picked, the explanation shown.
  expect(await within(playing).findByText(/The right side sends it to the lungs/)).toBeInTheDocument();
});

test("the chat shows a thread message with what it was about, and the way back opens the thing", async () => {
  renderApp("/projects/p1?chat=c1", {
    ...studioRoutes({ messages: [] }),
    "GET /v1/chats/:id": { chat, messages: [asked, answered] },
  });
  const mark = await screen.findByRole("button", { name: "On the quiz “The heart's loops”, question 1 · wrong" });
  await userEvent.click(mark);
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  // Opened at that spot: the answer given and its explanation.
  expect(await within(playing).findByText(/The right side sends it to the lungs/)).toBeInTheDocument();
});

test("in the phone's feed the thread is a sheet over the lower part, put away by dragging it down", async () => {
  const thread = { messages: [] as Message[] };
  const { calls } = renderApp("/feed", {
    ...studioRoutes(thread, {
      "POST /v1/plans/:id/items/:itemId/thread": () => {
        thread.messages = [{ ...asked, about: { ...about, at: { at: 0, responses: {}, ended: false }, label: "question 1" } }, answered];
        return { chat, created: false, messages: thread.messages };
      },
    }),
    "GET /v1/outputs": { outputs: [{ id: "o1", type: "quiz", title: "The heart's loops", schemaVersion: 1, createdAt: now, updatedAt: now, projectId: "p1", planId: "pl1", itemId: "i1" }] },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Talk about The heart's loops" }));
  const sheet = await screen.findByRole("dialog", { name: "Talk about The heart's loops" });
  expect(sheet).toHaveClass("sheet");
  // The thing stays on screen above it.
  expect(screen.getByText("Where does the right side send blood?")).toBeInTheDocument();
  await userEvent.type(within(sheet).getByRole("textbox"), "what is this asking?");
  await userEvent.click(within(sheet).getByRole("button", { name: "Send" }));
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/plans/pl1/items/i1/thread")?.body).toEqual({ text: "what is this asking?", at: { at: 0, responses: {}, ended: false } });
  expect(await within(sheet).findByText("A is the left side's loop.")).toBeInTheDocument();
  // Dragged down by its top, it goes.
  const top = sheet.querySelector(".thd") as HTMLElement;
  top.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100 }));
  top.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 260 }));
  top.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 260 }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Talk about The heart's loops" })).not.toBeInTheDocument());
});

test("the Studio's list shows that a thing has a thread and how many messages; one with none shows nothing", async () => {
  renderApp("/projects/p1", studioRoutes({ messages: [asked, answered] }));
  const list = await screen.findByRole("list", { name: "Made here" });
  expect(await within(list).findByLabelText("2 messages about it")).toBeInTheDocument();
});

test("a thing with no thread shows no count", async () => {
  renderApp("/projects/p1", studioRoutes({ messages: [] }));
  const list = await screen.findByRole("list", { name: "Made here" });
  expect(within(list).getByRole("group", { name: "The heart's loops" })).toBeInTheDocument();
  expect(within(list).queryByLabelText(/about it/)).not.toBeInTheDocument();
});
