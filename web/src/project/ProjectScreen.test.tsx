import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Item, PlanView } from "../api/types";
import { formats, now, sampleOutputs, sampleProviders, sampleSources, type FakeRequest } from "../test/fakeEngine";
import { renderApp } from "../test/render";
import { localDay } from "../plan/days";
import "../make/register";
import { unplugPlanPanel } from "../plan/register";
import { registerRightView } from "./rightPanel";

// The views the app's entry plugs in: the make sheet and Plan a whole subject. A plan opens as its card in the chat
// here; a test that needs a plan opened on the right plugs in its own stand-in.
unplugPlanPanel();

function item(id: string, level: number, ord: number, extra: Partial<Item> = {}): Item {
  return { id, level, ord, type: "byte", title: `Item ${id}`, settings: {}, enabled: true, status: "pending", sources: [], done: false, ...extra };
}
function planView(extra: Partial<PlanView["plan"]> = {}, items?: Item[]): PlanView {
  return {
    plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "draft", createdAt: now, updatedAt: now, ...extra },
    stages: [{ level: 1, label: "Warm-up" }],
    items: items ?? [
      item("a", 1, 0, { estCostUsd: 0.12, prompt: "Six bits on limits." }),
      item("b", 1, 1, { type: "quiz" }),
      item("c", 2, 0, { parentId: "a", condition: { kind: "ask", question: "More practice?" } }),
    ],
    edges: [],
    counts: { total: 3, done: 0 },
    estimateUsd: 0.12,
    issues: [],
  };
}
const project = { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now, category: "Mathematics" };
const source = { id: "s1", projectId: "p1", kind: "pdf", title: "Week 3", status: "ready", createdAt: now, updatedAt: now };

function routes(view: PlanView | (() => PlanView), more: Record<string, unknown> = {}) {
  const get = typeof view === "function" ? view : () => view;
  return {
    "GET /v1/projects/:id": { project },
    "GET /v1/projects": { projects: [project] },
    "GET /v1/projects/:id/usage": { usage: { calls: 1, failedCalls: 0, unpricedCalls: 0, tokensIn: 1, tokensOut: 1, usd: 1.5 } },
    "GET /v1/projects/:id/sources": { sources: [source] },
    "GET /v1/projects/:id/plans": () => ({ plans: [{ ...get().plan, counts: get().counts }] }),
    "GET /v1/projects/:id/outputs": { outputs: [] },
    "GET /v1/plans/:id": () => get(),
    "GET /v1/plans/:id/usage": { usage: { calls: 0, failedCalls: 0, unpricedCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 }, items: [] },
    "GET /v1/sources/:id": { source, extraction: { contentHash: "h", kind: "pdf", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 4 },
    "GET /v1/projects/:id/chats": { chats: [] },
    "GET /v1/skills": {
      skills: [{ id: "planning", label: "plan", command: "plan", about: "Makes a plan from the selected sources." }],
      // As the engine works them out: the skills' own, then one per format that can be made, in its own words.
      commands: [
        { command: "plan", label: "plan", action: "Make a plan", about: "Makes a plan from the selected sources.", skill: "planning" },
        { command: "teachback", label: "teach-back", action: "Explain it back", chatOnly: true, about: "Checks your own explanation of an idea against your sources.", skill: "teachBack" },
        { command: "mindmap", label: "mind map", action: "Map the ideas", chatOnly: true, about: "Lays out the main ideas in your sources and how they connect.", skill: "mindMap" },
        { command: "flashcards", label: "set of flashcards", about: "cards to swipe and flip, brought back until they stick", skill: "make", format: "flashcards" },
        { command: "quiz", label: "quiz", about: "questions that check you", skill: "make", format: "quiz" },
      ],
    },
    ...more,
  };
}
/** A request's body; a message's `today` (this device's day, checked on its own) is left out. */
const body = (calls: FakeRequest[], method: string, path: string) => {
  const sent = calls.find((c) => c.method === method && c.path === path)?.body;
  if (!sent || typeof sent !== "object" || !path.endsWith("/messages")) return sent;
  const rest = { ...(sent as Record<string, unknown>) };
  delete rest.today;
  return rest;
};
/** The right column: Make on top, Made here under it. */
const STUDIO = "Make and Made here";
/** The project with the hand-made plan pl1 opened from the Studio. */
const OPENED = "/projects/p1?plan=pl1";
const cardOf = async () => screen.findByRole("article", { name: "Plan: Unit 1" });

test("three panels fill the window: sources, the chat with the plan as a reply, the Studio", async () => {
  renderApp(OPENED, routes(planView()));
  expect(await screen.findByRole("heading", { level: 1, name: /^Calculus I\b/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  // The chat's send button wears an arrow pointing up (a shaft and a head), not a chevron.
  expect(screen.getByRole("button", { name: "Send" }).querySelector("path")).toHaveAttribute("d", "M12 19V5M5 12l7-7 7 7");
  expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Sources" })).getByText("Week 3")).toBeInTheDocument();
  const card = await cardOf();
  expect(within(card).getByRole("region", { name: "Stage 1" })).toHaveTextContent("Warm-up");
  expect(within(card).getByRole("region", { name: "Stage 1" }).querySelector(".prow.two")).not.toBeNull();
  expect(within(card).getByText("Ask me: More practice?")).toBeInTheDocument();
  expect(within(card).getAllByTestId("item").find((e) => e.textContent?.includes("Item c"))?.dataset.depth).toBe("1");
  // Never started, it is not in the Studio's list; the Studio is still there to make things in, and the project menu reaches the plan.
  const studio = screen.getByRole("region", { name: STUDIO });
  expect(within(studio).queryByText("Unit 1")).not.toBeInTheDocument();
  expect(within(studio).getByRole("group", { name: "Make" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Project menu" }));
  expect(within(screen.getByText("Plans not started, made outside a chat").parentElement!).getByRole("button", { name: "Unit 1" })).toBeInTheDocument();
});

const chat = { id: "c1", projectId: "p1", messageCount: 0, createdAt: now, updatedAt: now };
const say = (text: string, cites: number[] = []) => ({ kind: "text", text, cites });
function message(seq: number, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) {
  return { id: `m${seq}`, chatId: "c1", seq, role, text, createdAt: now, ...extra };
}

test("/plan goes to the chat, and the plan arrives as a reply with its card", async () => {
  const fresh = { ...planView({ id: "pl2", title: "Revision", chatId: "c1" }, [item("r", 1, 0, { title: "Recap" })]), stages: [] };
  const { calls } = renderApp(
    OPENED,
    routes(planView(), {
      "POST /v1/projects/:id/chats": [201, { chat }],
      "POST /v1/chats/:id/messages": {
        chat: { ...chat, title: "/plan Revision", messageCount: 2 },
        messages: [message(0, "user", "/plan Revision"), message(1, "assistant", "Here is a plan.", { skill: "planning", pieces: [say("Here is a plan."), { kind: "plan", planId: "pl2", action: "created" }, say("Start it when you like.")] })],
        plans: [fresh],
      },
    }),
  );
  await cardOf();
  await userEvent.type(screen.getByLabelText("Message"), "/plan Revision{Enter}");
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toEqual({ text: "/plan Revision", sources: ["s1"] });
  const reply = await screen.findByText("Here is a plan.");
  expect(reply).toBeInTheDocument();
  expect(await screen.findByRole("article", { name: "Plan: Revision" })).toHaveTextContent("Recap");
  expect(screen.getByRole("article", { name: "Plan: Revision" })).not.toHaveTextContent("Made outside a chat");
  // The pieces are drawn in order: text, the card, more text.
  const after = screen.getByText("Start it when you like.");
  expect(screen.getByRole("article", { name: "Plan: Revision" }).compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("button", { name: "/plan Revision" })).toBeInTheDocument();
});

test("Tools lists the same commands as /; a plan picked alone opens a new plan, and with words typed it starts the message", async () => {
  const { calls } = renderApp(
    OPENED,
    routes(planView(), {
      "POST /v1/projects/:id/chats": [201, { chat }],
      "POST /v1/chats/:id/messages": {
        chat: { ...chat, title: "Hi", messageCount: 2 },
        messages: [message(0, "user", "Hi"), message(1, "assistant", "Hello.")],
        plans: [],
      },
    }),
  );
  await cardOf();
  const box = screen.getByLabelText("Message");
  await userEvent.type(box, "Hi{Enter}");
  await screen.findByText("Hello.");
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toEqual({ text: "Hi", sources: ["s1"] });
  // The person's day goes with every message, so "by Friday" can become a stage's day.
  expect((calls.find((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")?.body as { today?: string }).today).toBe(localDay());
  // With words typed, a pick from Tools starts the message with its command.
  await userEvent.type(box, "for the exam");
  await userEvent.click(screen.getByRole("button", { name: "Tools" }));
  await userEvent.click(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: /\/plan$/ }));
  expect(box).toHaveValue("/plan for the exam");
  // Alone, it opens a new plan on the right and leaves the box empty; nothing is sent.
  await userEvent.clear(box);
  await userEvent.click(screen.getByRole("button", { name: "Tools" }));
  await userEvent.click(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: /\/plan$/ }));
  expect(box).toHaveValue("");
  expect(await screen.findByRole("region", { name: "Plan a whole subject" })).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")).toHaveLength(1);
});

test("a question gets an answer with a chip per cite that opens the exact spot", async () => {
  const text = "Intro. A limit exists only when both one-sided limits agree. More.";
  const { calls } = renderApp(
    OPENED,
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 0 }] },
      "GET /v1/chats/:id": { chat: { ...chat, title: "Limits" }, messages: [] },
      "GET /v1/sources/:id": { source, extraction: { contentHash: "h", kind: "pdf", status: "ready", text, createdAt: now, updatedAt: now }, chunkCount: 1 },
      "POST /v1/chats/:id/messages": {
        chat: { ...chat, title: "Limits", messageCount: 2 },
        messages: [
          message(0, "user", "explain @Week 3 please", { mentions: [{ kind: "source", id: "s1", label: "Week 3" }] }),
          message(1, "assistant", "Both sides must agree.", {
            covered: true,
            pieces: [say("Both sides must agree.", [0])],
            cites: [{ sourceId: "s1", spot: "passage", chunkId: "k1", locator: { charStart: 7, charEnd: 61 }, quote: "both one-sided limits agree" }],
          }),
        ],
      },
    }),
  );
  await cardOf();
  const box = screen.getByLabelText("Message");
  await userEvent.type(box, "explain @wee");
  const pop = screen.getByRole("listbox", { name: "Mention" });
  expect(within(pop).getByText("Sources", { selector: ".cpop-h" })).toBeInTheDocument();
  // A source the chat reads says so.
  expect(within(pop).getByRole("option", { name: /Week 3/ })).toHaveTextContent("pdf · ticked");
  await userEvent.keyboard("{Enter}");
  expect(box).toHaveValue("explain @Week 3 ");
  await userEvent.keyboard("please{Enter}");
  const sent = body(calls, "POST", "/v1/chats/c1/messages") as { text: string; sources: string[]; mentions: unknown[] };
  // (jsdom moves the caret after a picked mention, so only the start of the text is checked.)
  expect(sent.text).toMatch(/^explain @Week 3 /);
  expect(sent).toMatchObject({ sources: ["s1"], mentions: [{ kind: "source", id: "s1", label: "Week 3" }] });
  expect(await screen.findByText("@Week 3")).toHaveClass("ref");
  const chip = await screen.findByRole("button", { name: "Source 1: Week 3" });
  // The first cited reply says once what the numbers do.
  expect(screen.getAllByText("Click a number to see the exact spot in your source.")).toHaveLength(1);
  await userEvent.hover(chip);
  const tip = screen.getByRole("tooltip");
  expect(tip).toHaveTextContent("Week 3");
  expect(tip).toHaveTextContent("both one-sided limits agree");
  await userEvent.unhover(chip);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await userEvent.click(chip);
  const reader = await screen.findByRole("region", { name: "Source" });
  // On a narrow window, the source's own tab comes forward, so the spot is seen.
  expect(within(screen.getByRole("tablist", { name: "Panels" })).getByRole("tab", { name: /^Sources/ })).toHaveAttribute("aria-selected", "true");
  const spot = await within(reader).findByText("both one-sided limits agree", { selector: "mark" });
  expect(spot).toHaveClass("spot");
  // The spot carries the number of the chip it was opened from.
  expect(spot).toHaveAttribute("data-cite", "1");
});

test("a plan changed by later messages is drawn once, on the newest reply about it", async () => {
  const made = { ...planView({ id: "pl2", title: "Revision", chatId: "c1" }, [item("r", 1, 0, { title: "Recap" })]), stages: [] };
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/plans": { plans: [{ ...made.plan, counts: made.counts }] },
      "GET /v1/plans/:id": made,
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Revision", messageCount: 4 }] },
      "GET /v1/chats/:id": {
        chat,
        messages: [
          message(0, "user", "/plan"),
          message(1, "assistant", "Here is a plan.", { pieces: [say("Here is a plan."), { kind: "plan", planId: "pl2", action: "created" }] }),
          message(2, "user", "shorter"),
          message(3, "assistant", "Shorter now.", { pieces: [say("Shorter now."), { kind: "plan", planId: "pl2", action: "edited", changes: ['Changed "Recap": settings.'] }] }),
        ],
      },
    }),
  );
  expect(await screen.findByText("Shorter now.")).toBeInTheDocument();
  expect(await screen.findAllByRole("article", { name: "Plan: Revision" })).toHaveLength(1);
  expect(screen.getByText('Changed "Recap": settings.')).toBeInTheDocument();
});

test("a reply's question is answered by picking an option, sent back as the person's message", async () => {
  const asked = message(1, "assistant", "Two things first.", {
    pieces: [
      say("Before I plan:"),
      { kind: "question", id: "q1", text: "What is it for?", options: [{ id: "o1", label: "An exam", skill: "planning" }, { id: "o2", label: "Just to understand it", skill: "planning" }], multiple: false },
    ],
  });
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Plan", messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "make me a plan"), asked] },
      "POST /v1/chats/:id/messages": {
        chat: { ...chat, messageCount: 4 },
        messages: [message(2, "user", "An exam", { answer: { messageId: "m1", picks: [{ questionId: "q1", optionIds: ["o1"] }] } }), message(3, "assistant", "Got it.")],
        plans: [],
      },
    }),
  );
  const question = await screen.findByRole("group", { name: "What is it for?" });
  await userEvent.click(within(question).getByRole("button", { name: "An exam" }));
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toEqual({ text: "An exam", sources: ["s1"], answer: { messageId: "m1", picks: [{ questionId: "q1", optionIds: ["o1"] }] } });
  expect(await screen.findByText("Got it.")).toBeInTheDocument();
  // Answered: the pick stays shown, and the options no longer take a click.
  expect(within(question).getByRole("button", { name: "An exam" })).toHaveAttribute("aria-pressed", "true");
  expect(within(question).getByRole("button", { name: "Just to understand it" })).toBeDisabled();
});

test("a reply the engine could not write is one quiet line with Try again, and the retry replaces it", async () => {
  const failed = (seq: number) =>
    message(seq, "assistant", "I couldn't write a reply just now: the model call failed. Send the message again to retry.", {
      pieces: [say("I couldn't write a reply just now: the model call failed. Send the message again to retry.")],
      failed: { reason: "error" },
    });
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "What is a limit?"), failed(1)] },
      "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 4 }, messages: [message(2, "user", "What is a limit?"), message(3, "assistant", "A limit is where a function heads.")], plans: [] },
    }),
  );
  expect(await screen.findByText("Open Sourcebook couldn't write a reply just now.")).toBeInTheDocument();
  expect(screen.queryByText(/the model call failed/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toEqual({ text: "What is a limit?", sources: ["s1"] });
  expect(await screen.findByText("A limit is where a function heads.")).toBeInTheDocument();
  // The failed try is folded away: the question shows once, and nothing failed is left.
  expect(screen.getAllByText("What is a limit?")).toHaveLength(1);
  expect(screen.queryByText("Open Sourcebook couldn't write a reply just now.")).not.toBeInTheDocument();
});

test("a reply the person's agent is writing shows its steps on one line, then the reply; Stop ends it", async () => {
  const step = (label: string, state = "done") => ({ tool: "search_passages", label, state, startedAt: now });
  const running = (steps: unknown[]) => message(1, "assistant", "", { pieces: [], state: "running", agent: "claude", steps });
  let polls = 0;
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 0 }] },
      "GET /v1/chats/:id": () => {
        polls += 1;
        if (polls === 1) return { chat, messages: [] };
        if (polls === 2) return { chat, messages: [message(0, "user", "What is a limit?"), running([step("Searching Week 3", "running")])] };
        return {
          chat,
          messages: [message(0, "user", "What is a limit?"), message(1, "assistant", "A limit is where a function heads.", { pieces: [say("A limit is where a function heads.")], agent: "claude", steps: [step("Searching Week 3"), step("Writing the reply")] })],
        };
      },
      "POST /v1/chats/:id/messages": { chat, messages: [message(0, "user", "What is a limit?"), running([])], plans: [] },
    }),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Message" }), "What is a limit?{Enter}");
  expect(await screen.findByText("Getting started…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(await screen.findByText("Searching Week 3…", {}, { timeout: 3000 })).toBeInTheDocument();
  expect(await screen.findByText("A limit is where a function heads.", {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getByText("Worked in 2 steps")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/chats/c1/stop")).toBe(false);
});

test("a reply shows its blocks as the agent writes them, and its steps open to fewer lines in the past", async () => {
  const step = (tool: string, label: string, state = "done") => ({ tool, label, state, startedAt: now });
  const cites = [{ sourceId: "s1", spot: "passage", quote: "Midterm covers lectures 1 to 6." }];
  const lead = { kind: "text", text: "Two files cover the **midterm**.", cites: [0] };
  const list = { kind: "list", ordered: false, items: [{ text: "Week 3 notes", cites: [0] }, { text: "[The syllabus](cite:0)", cites: [] }], text: "- Week 3 notes\n- The syllabus", cites: [] };
  let polls = 0;
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 0 }] },
      "GET /v1/chats/:id": () => {
        polls += 1;
        if (polls === 1) return { chat, messages: [] };
        const asked = message(0, "user", "Which files cover the midterm?");
        if (polls === 2) return { chat, messages: [asked, message(1, "assistant", "", { pieces: [lead], cites, state: "running", agent: "claude", steps: [step("read_passages", "Reading Week 3"), step("reply", "Writing more of the reply", "running")] })] };
        return {
          chat,
          messages: [
            asked,
            message(1, "assistant", "", {
              pieces: [lead, list],
              cites,
              agent: "claude",
              steps: [step("read_passages", "Reading Week 3"), step("read_passages", "Reading Week 3"), step("reply", "Writing the reply")],
              stepLines: [
                { text: "Read 4 passages of Week 3", steps: 2, state: "done" },
                { text: "Wrote the reply", steps: 1, state: "done" },
              ],
            }),
          ],
        };
      },
      "POST /v1/chats/:id/messages": { chat, messages: [message(0, "user", "Which files cover the midterm?"), message(1, "assistant", "", { pieces: [], state: "running", agent: "claude", steps: [] })], plans: [] },
    }),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Message" }), "Which files cover the midterm?{Enter}");
  // While it runs: the step it is on in plain words, and the first block already there.
  expect(await screen.findByText("Writing more of the reply…", {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getByText("midterm", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  // Then the rest, a list with its cites at the end of each item.
  expect(await screen.findByText("Week 3 notes", {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Source 1:/ })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "The syllabus" })).toBeInTheDocument();
  // The steps list is in the page only while open, and says what was done in fewer lines.
  expect(screen.queryByText("Read 4 passages of Week 3")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("Worked in 3 steps"));
  expect(screen.getByText("Read 4 passages of Week 3")).toBeInTheDocument();
  expect(screen.getByText("Wrote the reply")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy reply" })).toBeInTheDocument();
});

test("a teach-back starts from its own button words, and its reply groups the person's points with their cites", async () => {
  const cites = [
    { sourceId: "s1", spot: "passage", quote: "A limit describes where a function heads." },
    { sourceId: "s1", spot: "passage", quote: "Both one-sided limits must agree." },
  ];
  const feedback = {
    kind: "teachback",
    items: [
      { verdict: "right", text: "A limit is where the function **heads**.", cites: [0] },
      { verdict: "missing", text: "Both sides have to agree.", cites: [1] },
      { verdict: "wrong", text: "The function need not reach the value.", cites: [0] },
    ],
    text: "",
    cites: [],
  };
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": {
        chat,
        messages: [
          message(0, "user", "/teachback A limit is the value the function reaches."),
          message(1, "assistant", "", { skill: "teachBack", pieces: [{ kind: "text", text: "Close, with one slip.", cites: [] }, feedback], cites }),
        ],
      },
    }),
  );
  const checked = await screen.findByRole("group", { name: "Your explanation, checked against your sources" });
  const right = within(checked).getByRole("region", { name: "What you got right" });
  expect(within(right).getByText("heads", { selector: "strong" })).toBeInTheDocument();
  expect(within(right).getByRole("button", { name: /^Source 1:/ })).toBeInTheDocument();
  expect(within(within(checked).getByRole("region", { name: "What you left out" })).getByText("Both sides have to agree.")).toBeInTheDocument();
  expect(within(within(checked).getByRole("region", { name: "What the sources say differently" })).getByRole("button", { name: /^Source 1:/ })).toBeInTheDocument();
  // How many of the main points the person got, one segment for each.
  expect(checked).toHaveTextContent("You got 1 of the 3 main points");
  expect(checked.querySelectorAll(".tb-bar span")).toHaveLength(3);
  // Explain it again starts the same command in the box, for another try.
  await userEvent.click(within(checked).getByRole("button", { name: "Explain it again" }));
  expect(screen.getByLabelText("Message")).toHaveValue("/teachback ");
  expect(within(checked).getByRole("button", { name: "Open the passages" })).toBeInTheDocument();
  // Tools offers it in its own words, under what answers in the chat and makes nothing.
  await userEvent.clear(screen.getByLabelText("Message"));
  await userEvent.click(screen.getByRole("button", { name: "Tools" }));
  await userEvent.click(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: "Explain it back, /teachback" }));
  expect(screen.getByLabelText("Message")).toHaveValue("/teachback ");
});

test("a mind map shows its ideas round the centre, and tapping one opens its sentence, its cites and its links", async () => {
  const cites = [
    { sourceId: "s1", spot: "passage", quote: "Plants make glucose." },
    { sourceId: "s1", spot: "passage", quote: "The energy comes from sunlight." },
  ];
  const map = {
    kind: "mindmap",
    nodes: [
      { id: "p", text: "Photosynthesis", detail: "Plants make **glucose**.", cites: [0] },
      { id: "sun", text: "Sunlight", detail: "Where the energy comes from.", cites: [1] },
      { id: "o2", text: "Oxygen", cites: [] },
    ],
    links: [
      { from: "sun", to: "p", text: "powers" },
      { from: "p", to: "o2", text: "gives off" },
    ],
    text: "",
    cites: [],
  };
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Leaves", messageCount: 2 }] },
      "GET /v1/chats/:id": {
        chat,
        messages: [message(0, "user", "/mindmap"), message(1, "assistant", "", { skill: "mindMap", pieces: [{ kind: "text", text: "Sunlight drives it.", cites: [] }, map], cites })],
      },
    }),
  );
  const drawn = await screen.findByRole("group", { name: "Mind map: Photosynthesis" });
  // The centre is open to begin with: its sentence, its cite and how it connects.
  expect(within(drawn).getByRole("button", { name: "Photosynthesis", pressed: true })).toBeInTheDocument();
  expect(within(drawn).getByText("glucose", { selector: "strong" })).toBeInTheDocument();
  expect(within(drawn).getByRole("button", { name: /^Source 1:/ })).toBeInTheDocument();
  const ties = within(drawn).getByRole("list", { name: "How Photosynthesis connects" });
  // Each tie is the other idea's name as a chip, with how they are linked as a quiet line after it.
  expect(within(ties).getAllByRole("button").map((b) => b.textContent)).toEqual(["Sunlight", "Oxygen"]);
  expect(within(ties).getAllByRole("listitem").map((li) => li.querySelector("small")?.textContent)).toEqual(["← powers", "→ gives off"]);
  // Tapping an idea on the map opens it; a link below moves along the map.
  await userEvent.click(within(drawn).getByRole("button", { name: "Sunlight", pressed: false }));
  expect(within(drawn).getByRole("heading", { name: "Sunlight" })).toBeInTheDocument();
  expect(within(drawn).getByText("Where the energy comes from.")).toBeInTheDocument();
  expect(within(drawn).getByRole("button", { name: /^Source 2:/ })).toBeInTheDocument();
  await userEvent.click(within(within(drawn).getByRole("list", { name: "How Sunlight connects" })).getByRole("button", { name: "Photosynthesis" }));
  expect(within(drawn).getByRole("heading", { name: "Photosynthesis" })).toBeInTheDocument();
  expect(drawn).toHaveTextContent("3 ideas · 2 links");
  // The full view: the same map with zoom, the open idea at the side, and a way to ask about it in the chat.
  await userEvent.click(within(drawn).getByRole("button", { name: "Full view" }));
  const full = screen.getByRole("dialog", { name: "Mind map: Photosynthesis, full view" });
  expect(within(full).getByRole("heading", { name: "Photosynthesis" })).toBeInTheDocument();
  await userEvent.click(within(full).getByRole("button", { name: "Zoom in" }));
  await userEvent.click(within(full).getByRole("button", { name: "Ask about this idea" }));
  expect(screen.queryByRole("dialog", { name: /full view/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toHaveValue("About Photosynthesis: ");
  // It is a chat command, listed by its own title, not a Studio tile.
  await userEvent.clear(screen.getByLabelText("Message"));
  await userEvent.click(screen.getByRole("button", { name: "Tools" }));
  expect(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: "Map the ideas, /mindmap" })).toBeInTheDocument();
});

test("a turn stopped part way keeps what it wrote and says it is cut short", async () => {
  const cut = message(1, "assistant", "", {
    pieces: [{ kind: "text", text: "Lectures 1 to 6 cover it.", cites: [] }, { kind: "text", text: "You stopped this reply. The reply above is cut short.", cites: [], failure: true }],
    agent: "claude",
    failed: { reason: "stopped", cutShort: true },
  });
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "Which lectures?"), cut] },
    }),
  );
  expect(await screen.findByText("Lectures 1 to 6 cover it.")).toBeInTheDocument();
  expect(screen.getByText("You stopped this reply, so it is cut short.")).toBeInTheDocument();
  expect(screen.queryByText("You stopped this reply. The reply above is cut short.")).not.toBeInTheDocument();
});

test("Stop ends the agent's reply, and an agent that can't be reached is one calm line with Try again", async () => {
  const stopped = message(1, "assistant", "You stopped this reply.", { pieces: [say("You stopped this reply.")], agent: "claude", failed: { reason: "stopped" } });
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "What is a limit?"), message(1, "assistant", "", { pieces: [], state: "running", agent: "claude", steps: [] })] },
      "POST /v1/chats/:id/stop": { chat, messages: [stopped] },
      "POST /v1/chats/:id/messages": {
        chat,
        messages: [
          message(2, "user", "What is a limit?"),
          message(3, "assistant", "Open Sourcebook couldn't reach your agent.", { pieces: [say("Open Sourcebook couldn't reach your agent.")], agent: "claude", failed: { reason: "agentUnreachable" } }),
        ],
        plans: [],
      },
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/chats/c1/stop")).toBe(true);
  expect(await screen.findByText("You stopped this reply.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "What is a limit?{Enter}");
  expect(await screen.findByText("Open Sourcebook can't reach your agent. Start Open Sourcebook's connector on your computer, then try again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

test("a part whose cites failed the check says it is not checked against the sources", async () => {
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "Do series converge?"), message(1, "assistant", "Always.", { pieces: [{ ...say("Always."), unchecked: true }], agent: "claude" })] },
    }),
  );
  expect(await screen.findByText(/not checked against your sources/)).toBeInTheDocument();
});

test("a message that never reached the engine stays on screen, says why, and sends again in one click", async () => {
  let tries = 0;
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "POST /v1/projects/:id/chats": { chat },
      "POST /v1/chats/:id/messages": () =>
        ++tries === 1 ? [503, { error: "chat_unavailable", message: "The chat is not available right now." }] : { chat: { ...chat, messageCount: 2 }, messages: [message(0, "user", "hello"), message(1, "assistant", "Hi there.")], plans: [] },
    }),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Message" }), "hello{Enter}");
  expect(await screen.findByText("Not sent: The chat is not available right now.")).toBeInTheDocument();
  expect(screen.getByText("hello")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Hi there.")).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")).toHaveLength(2);
  expect(screen.getAllByText("hello")).toHaveLength(1);
  expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();
});

test("with several agents ready and none picked, a message asks who answers the chat and is sent with that pick", async () => {
  let tries = 0;
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/providers": { ...sampleProviders, picks: {} },
      "POST /v1/projects/:id/chats": { chat },
      "POST /v1/chats/:id/messages": () =>
        ++tries === 1 ? [409, { error: "pick_needed", message: "Pick who answers in the chat's picker." }] : { chat: { ...chat, messageCount: 2, answerer: "agent:alpha:a-one" }, messages: [message(0, "user", "hello"), message(1, "assistant", "Hi there.")], plans: [] },
    }),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Message" }), "hello{Enter}");
  const picker = await screen.findByRole("dialog", { name: "Answers the chat" });
  expect(within(picker).getByText("Pick who answers the chat")).toBeInTheDocument();
  expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();
  expect(screen.queryByText(/chat's picker/)).not.toBeInTheDocument();
  await userEvent.click(within(picker).getByRole("option", { name: /A One/ }));
  await userEvent.click(within(picker).getByRole("button", { name: "Use this" }));
  expect(await screen.findByText("Hi there.")).toBeInTheDocument();
  const sent = calls.filter((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages");
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toMatchObject({ text: "hello", answerer: "agent:alpha:a-one" });
  expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/projects/p1/chats")).toHaveLength(1);
  expect(screen.getAllByText("hello")).toHaveLength(1);
});

test("closing the who-answers picker without a pick leaves the message unsent, in plain words", async () => {
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/providers": { ...sampleProviders, picks: {} },
      "POST /v1/projects/:id/chats": { chat },
      "POST /v1/chats/:id/messages": [409, { error: "pick_needed", message: "Pick who answers in the chat's picker." }],
    }),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Message" }), "hello{Enter}");
  const picker = await screen.findByRole("dialog", { name: "Answers the chat" });
  await userEvent.click(within(picker).getByRole("button", { name: "Close" }));
  expect(await screen.findByText("Not sent: Pick who answers the chat, then try again.")).toBeInTheDocument();
});

test("several questions wait for Send; a kind this app does not know is still shown", async () => {
  const asked = message(1, "assistant", "x", {
    pieces: [
      { kind: "question", id: "q1", text: "Which parts?", options: [{ id: "o1", label: "Limits" }, { id: "o2", label: "Series" }], multiple: true },
      { kind: "question", id: "q2", text: "How deep?", options: [{ id: "o1", label: "Light" }, { id: "o2", label: "Deep" }], multiple: false },
      { kind: "poll", text: "A piece of a later kind." },
      { kind: "mystery" },
    ],
  });
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "plan"), asked] },
      "POST /v1/chats/:id/messages": { chat, messages: [], plans: [] },
    }),
  );
  expect(await screen.findByText("A piece of a later kind.")).toBeInTheDocument();
  expect(screen.getByText(/can't be shown here yet/)).toBeInTheDocument();
  const send = screen.getByRole("button", { name: "Send answers" });
  expect(send).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Limits" }));
  await userEvent.click(screen.getByRole("button", { name: "Series" }));
  await userEvent.click(screen.getByRole("button", { name: "Deep" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")).toBe(false);
  await userEvent.click(send);
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toEqual({
    text: "Limits, Series\nDeep",
    sources: ["s1"],
    answer: { messageId: "m1", picks: [{ questionId: "q1", optionIds: ["o1", "o2"] }, { questionId: "q2", optionIds: ["o2"] }] },
  });
});

test("the Sources panel follows the chat's ticked sources, including a source a message mentioned", async () => {
  const other = { ...source, id: "s2", title: "Week 4" };
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/sources": { sources: [source, other] },
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 0, sources: ["s1"] }] },
      "GET /v1/chats/:id": { chat: { ...chat, sources: ["s1"] }, messages: [] },
      "POST /v1/chats/:id/messages": { chat: { ...chat, sources: ["s1", "s2"] }, messages: [message(0, "user", "@Week 4"), message(1, "assistant", "ok")], plans: [] },
    }),
  );
  const week4 = await screen.findByRole("checkbox", { name: "Use Week 4 in this chat" });
  await vi.waitFor(() => expect(week4).not.toBeChecked());
  expect(screen.getByRole("checkbox", { name: "Use Week 3 in this chat" })).toBeChecked();
  await userEvent.type(screen.getByLabelText("Message"), "hi{Enter}");
  await vi.waitFor(() => expect(screen.getByRole("checkbox", { name: "Use Week 4 in this chat" })).toBeChecked());
});

test("a chat shows only what was said and made in it; a plan made outside a chat opens on its own", async () => {
  renderApp("/projects/p1", routes(planView(), { "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }] }, "GET /v1/chats/:id": { chat, messages: [message(0, "user", "hi"), message(1, "assistant", "hello")] } }));
  expect(await screen.findByText("hello")).toBeInTheDocument();
  expect(screen.queryByRole("article", { name: "Plan: Unit 1" })).not.toBeInTheDocument();
  // A new chat is empty, even with plans in the project that no chat made.
  await userEvent.click(screen.getByRole("button", { name: "Limits" }));
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(await screen.findByRole("heading", { name: "Week 3 is read and ready" })).toBeInTheDocument();
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  // A plan never started that no chat made opens from the project menu, above the chat, saying it is not part of it.
  await userEvent.click(screen.getByRole("button", { name: "Project menu" }));
  await userEvent.click(screen.getByRole("button", { name: "Unit 1" }));
  const opened = await screen.findByRole("group", { name: "Opened, not part of this chat" });
  expect(within(opened).getByRole("article", { name: "Plan: Unit 1" })).toHaveTextContent("Made outside a chat");
  expect(screen.queryByText("Plan from this chat")).not.toBeInTheDocument();
  await userEvent.click(within(opened).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});

test("past chats are listed and opened; a new chat starts empty", async () => {
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }, { ...chat, id: "c2", title: "Series", messageCount: 4 }] },
      "GET /v1/chats/:id": (req: FakeRequest) =>
        req.params.id === "c1"
          ? { chat: { ...chat, title: "Limits" }, messages: [message(0, "user", "first question"), message(1, "assistant", "first answer")] }
          : { chat: { ...chat, id: "c2", title: "Series" }, messages: [message(0, "user", "about series")] },
    }),
  );
  expect(await screen.findByText("first answer")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Limits" }));
  await userEvent.click(screen.getByRole("button", { name: /Series/ }));
  expect(await screen.findByText("about series")).toBeInTheDocument();
  expect(screen.queryByText("first answer")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Series" }));
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.queryByText("about series")).not.toBeInTheDocument();
});

test("opening a project picks up the most recent chat with something said in it, past an empty one", async () => {
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, id: "c2", title: "New chat", messageCount: 0 }, { ...chat, title: "Limits", messageCount: 2 }] },
      "GET /v1/chats/:id": (req: FakeRequest) =>
        req.params.id === "c1" ? { chat: { ...chat, title: "Limits" }, messages: [message(0, "user", "first question"), message(1, "assistant", "first answer")] } : { chat: { ...chat, id: "c2" }, messages: [] },
    }),
  );
  expect(await screen.findByText("first answer")).toBeInTheDocument();
});

test("a new chat says its source is read and ready and offers what answers in the chat; its first message shows once", async () => {
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "POST /v1/projects/:id/chats": [201, { chat }],
      // The new chat is read back while its first reply is written; the reply must not double the question.
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "what is a limit?")] },
      "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 2 }, messages: [message(0, "user", "what is a limit?"), message(1, "assistant", "A value approached.", { pieces: [say("A value approached.")] })] },
    }),
  );
  expect(await screen.findByRole("heading", { name: "Week 3 is read and ready" })).toBeInTheDocument();
  expect(screen.getByText(/To make something from it, pick a shape in Make/)).toBeInTheDocument();
  // Nothing here makes a thing: what answers in the chat, by its own title, and a summary of the source.
  expect(screen.queryByRole("group", { name: "Make something" })).not.toBeInTheDocument();
  expect([...document.querySelectorAll(".hello .chip")].map((b) => b.textContent)).toEqual(["Explain it back", "Map the ideas", "Summarize Week 3"]);
  // The box and the line under it, in the design's words; the line names shapes the engine lists.
  const box = screen.getByLabelText("Message");
  expect(box).toHaveAttribute("placeholder", "Ask about your source, or say what to make");
  expect(screen.getByText("Ask for a set of flashcards, a quiz or a plan here and its make sheet opens on the right, filled in.")).toBeInTheDocument();
  await userEvent.type(box, "what is a limit?{Enter}");
  expect(await screen.findByText("A value approached.")).toBeInTheDocument();
  expect(screen.getAllByText("what is a limit?")).toHaveLength(1);
  expect(box).toHaveFocus();
  expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")).toHaveLength(1);
});

test("a shape picked from / with nothing typed opens its make sheet and sends nothing; with words it goes to the chat", async () => {
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "POST /v1/projects/:id/chats": [201, { chat }],
      "POST /v1/projects/:id/make/settle": { settings: {}, plannedAs: "Your agent · 5 questions", issues: [] },
      "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 1 }, messages: [message(0, "user", "/quiz on limits")] },
    }),
  );
  const box = await screen.findByLabelText("Message");
  await screen.findByRole("button", { name: "Tools" });
  await userEvent.type(box, "/qu{Enter}");
  expect(box).toHaveValue("");
  expect(await screen.findByRole("heading", { name: "Make a quiz" })).toBeInTheDocument();
  expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages"))).toBe(false);
  // The emptied box puts its caret back on the next frame; type after it.
  await new Promise((done) => requestAnimationFrame(done));
  // A whole command sent bare opens the sheet too.
  await userEvent.type(box, "/quiz{Enter}");
  expect(box).toHaveValue("");
  expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages"))).toBe(false);
  await new Promise((done) => requestAnimationFrame(done));
  // With words after it, it is a message: the reply opens the sheet filled in.
  await userEvent.type(box, "/quiz on limits{Enter}");
  expect((body(calls, "POST", "/v1/chats/c1/messages") as { text: string }).text).toBe("/quiz on limits");
});

test("Shift+Enter starts a new line in the message; Enter sends it", async () => {
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "POST /v1/projects/:id/chats": [201, { chat }],
      "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 1 }, messages: [message(0, "user", "one\ntwo")] },
    }),
  );
  await screen.findByRole("heading", { name: "Week 3 is read and ready" });
  const box = screen.getByLabelText("Message");
  await userEvent.type(box, "one{Shift>}{Enter}{/Shift}two");
  expect(box).toHaveValue("one\ntwo");
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")).toBe(false);
  await userEvent.keyboard("{Enter}");
  expect((body(calls, "POST", "/v1/chats/c1/messages") as { text: string }).text).toBe("one\ntwo");
  expect(box).toHaveValue("");
});

test("editing an item happens inside the plan, and only changes are sent", async () => {
  const { calls } = renderApp(OPENED, routes(planView(), { "PATCH /v1/plans/:id/items/:itemId": planView() }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Item details" });
  await userEvent.click(within(within(form).getByRole("group", { name: "Kinds of card" })).getByRole("checkbox", { name: /Fill the gap/ }));
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect(body(calls, "PATCH", "/v1/plans/pl1/items/a")).toEqual({ settings: { kinds: ["recall"] } });
});

test("a plan line shows only its format and title; tapping it shows what it is for, then the whole brief", async () => {
  const briefed = planView(undefined, [item("a", 1, 0, { prompt: "Shows the idea on one example. Do not repeat the intro; start from a blank frame." })]);
  renderApp(OPENED, routes(briefed));
  const card = await cardOf();
  expect(card).not.toHaveTextContent("Shows the idea");
  expect(card).not.toHaveTextContent(/either order|Tap an item/);
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  const details = within(card).getByRole("region", { name: "Item details" });
  expect(details).toHaveTextContent("Shows the idea on one example.");
  expect(details).not.toHaveTextContent("blank frame");
  await userEvent.click(within(details).getByRole("button", { name: "Full brief" }));
  expect(details).toHaveTextContent("start from a blank frame");
  expect(within(details).getByRole("button", { name: "Edit" })).toBeInTheDocument();
});

test("changing the format resets settings; unticking leaves an item out", async () => {
  const deep = planView(undefined, [item("a", 1, 0, { settings: { depth: "deep" } }), item("b", 1, 1, { type: "quiz" })]);
  const { calls } = renderApp(OPENED, routes(deep, { "PATCH /v1/plans/:id/items/:itemId": deep }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("checkbox", { name: "Include Item b" }));
  expect(body(calls, "PATCH", "/v1/plans/pl1/items/b")).toEqual({ enabled: false });
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Item details" });
  await userEvent.click(within(within(form).getByRole("group", { name: "Format" })).getByRole("button", { name: "quiz" }));
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ type: "quiz", settings: {} });
});

test("adds an item to a stage from inside the plan, reading the chat's ticked sources from the start", async () => {
  const added = planView(undefined, [...planView().items, item("d", 1, 2, { type: "quiz", title: "Recap" })]);
  const { calls } = renderApp(OPENED, routes(planView(), { "POST /v1/plans/:id/items": [201, added] }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Add an item to Warm-up" }));
  const form = within(card).getByRole("form", { name: "Add an item" });
  await userEvent.type(within(form).getByLabelText("Title"), "Recap");
  await userEvent.click(within(within(form).getByRole("group", { name: "Format" })).getByRole("button", { name: "quiz" }));
  expect(within(form).getByRole("button", { name: "Week 3" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(within(form).getByRole("button", { name: "Add item" }));
  expect(body(calls, "POST", "/v1/plans/pl1/items")).toEqual({ type: "quiz", title: "Recap", level: 1, settings: {}, sources: [{ sourceId: "s1" }], enabled: true });
});

test("removing an item warns that its branches go too", async () => {
  const { calls } = renderApp(OPENED, routes(planView(), { "DELETE /v1/plans/:id/items/:itemId": planView(undefined, [item("b", 1, 0)]) }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  await userEvent.click(within(card).getByRole("button", { name: "Remove" }));
  expect(within(card).getByText(/Remove it and 1 branch under it\?/)).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Remove" }));
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/plans/pl1/items/a")).toBe(true);
});

test("Start approves and starts in one step; a refusal shows its reasons", async () => {
  let view = planView();
  const { calls } = renderApp(OPENED, routes(() => view, {
    "POST /v1/plans/:id/approve": () => (view = planView({ status: "approved" })),
    "POST /v1/plans/:id/start": () => (view = planView({ status: "running", kickedOffAt: now })),
  }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Start" }));
  expect(await within(card).findByRole("progressbar", { name: "Items done" })).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/v1/plans/pl1/approve", "/v1/plans/pl1/start"]);
  expect(within(card).queryByRole("checkbox", { name: "Include Item a" })).not.toBeInTheDocument();
});

test("a refused Start lists what blocks it", async () => {
  renderApp(OPENED, routes(planView(), {
    "POST /v1/plans/:id/approve": [422, { error: "plan_invalid", message: "The plan cannot start", issues: ["Item c: video is not made yet"] }],
  }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: /Start/ }));
  expect(await within(card).findByRole("alert")).toHaveTextContent("Item c: video is not made yet");
});

test("a running plan shows progress, opens what is made, ticks done and answers ask me", async () => {
  let current = planView({ status: "running", kickedOffAt: now }, [
    item("a", 1, 0, { status: "done", outputId: "o1" }),
    item("c", 2, 0, { parentId: "a", condition: { kind: "ask" }, asking: { question: "More practice?" } }),
  ]);
  current = { ...current, counts: { total: 2, done: 0 } };
  const { calls } = renderApp(OPENED, routes(() => current, {
    "POST /v1/plans/:id/items/:itemId/done": () => {
      current = { ...current, items: current.items.map((i) => (i.id === "a" ? { ...i, done: true } : i)), counts: { total: 2, done: 1 } };
      return { item: { id: "a", done: true }, counts: { total: 2, done: 1 } };
    },
    "POST /v1/plans/:id/items/:itemId/answer": { item: { id: "c" }, counts: { total: 2, done: 1 } },
  }));
  const card = await cardOf();
  // The row's play and the card's own Play say the same thing and open the same thing.
  const plays = within(card).getAllByRole("button", { name: "Play Item a" });
  expect(plays.length).toBeGreaterThanOrEqual(2);
  expect(within(card).queryByRole("button", { name: /Play (now|the plan)|Play from/ })).not.toBeInTheDocument();
  // A row that is not done has no tick to hit by mistake; marking by hand is in the item's details.
  expect(within(card).queryByRole("checkbox", { name: "Done: Item a" })).not.toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  await userEvent.click(within(card).getByRole("button", { name: "Mark done" }));
  expect(body(calls, "POST", "/v1/plans/pl1/items/a/done")).toEqual({ done: true, outputId: "o1" });
  expect(await within(card).findByText("1 of 2 gone through")).toBeInTheDocument();
  // The change is said on the row, with Undo beside it, and the tick now shows.
  expect(within(card).getByText("Marked done.")).toBeInTheDocument();
  expect(within(card).getByRole("checkbox", { name: "Done: Item a" })).toBeChecked();
  await userEvent.click(within(card).getByRole("button", { name: "Undo" }));
  expect(calls.filter((c) => c.path === "/v1/plans/pl1/items/a/done").at(-1)?.body).toEqual({ done: false });
  await userEvent.click(within(card).getByRole("button", { name: "Skip" }));
  expect(body(calls, "POST", "/v1/plans/pl1/items/c/answer")).toEqual({ answer: false });
});

test("an item being made says what its maker is doing now, in the maker's words, and for how long", async () => {
  const startedAt = new Date(Date.now() - 6 * 60_000 - 5_000).toISOString();
  const job = { id: "j1", status: "running", stage: "writing", progress: 0.4, attempt: 1, step: "Writing scene 2 of 5", startedAt };
  renderApp(OPENED, routes(planView({ status: "running", kickedOffAt: now }, [item("a", 1, 0, { type: "video", status: "running", job })])));
  const card = await cardOf();
  expect(within(card).getByText("making")).toBeInTheDocument();
  expect(within(card).getByRole("status")).toHaveTextContent("Writing scene 2 of 5 · 6 min so far");
});

test("a plan with everything made says All made until the person has been through it all, then Done", async () => {
  let current = { ...planView({ status: "done", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1" })]), counts: { total: 1, done: 0 } };
  renderApp(OPENED, routes(() => current, {
    "POST /v1/plans/:id/items/:itemId/done": () => {
      current = { ...current, items: current.items.map((i) => ({ ...i, done: true })), counts: { total: 1, done: 1 } };
      return { item: { id: "a", done: true }, counts: { total: 1, done: 1 } };
    },
  }));
  const card = await cardOf();
  expect(within(card).getByText("All made")).toBeInTheDocument();
  expect(within(card).queryByText("Done")).not.toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Details for Item a" }));
  await userEvent.click(within(card).getByRole("button", { name: "Mark done" }));
  expect(await within(card).findByText("Done")).toBeInTheDocument();
});

test("the project screen shows no money, not even on Start", async () => {
  renderApp(OPENED, routes(planView()));
  const card = await cardOf();
  expect(within(card).getByRole("button", { name: "Start" })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\$/);
});

test("a cite's link from the phone feed lands on the Sources tab, so the spot is seen on a narrow window", async () => {
  renderApp("/sources/s1?quote=limit", routes(planView()));
  await screen.findByRole("region", { name: "Source" });
  expect(within(screen.getByRole("tablist", { name: "Panels" })).getByRole("tab", { name: /^Sources/ })).toHaveAttribute("aria-selected", "true");
});

test("a source opens beside the chat, and old source and plan links land in the project", async () => {
  renderApp("/sources/s1", routes(planView()));
  const reader = await screen.findByRole("region", { name: "Source" });
  expect(await within(reader).findByText("A limit describes…")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
  await userEvent.click(within(reader).getByRole("button", { name: "Sources" }));
  expect(await screen.findByRole("region", { name: "Sources" })).toBeInTheDocument();
});

test("the columns never fold; Sources says how many are used, and the composer says when the chat uses only some", async () => {
  renderApp("/projects/p1", routes(planView()));
  // Once the chat is open, its ticks are on the panel.
  await screen.findByText("Week 3 is read and ready");
  expect(screen.queryByRole("button", { name: /^Hide / })).not.toBeInTheDocument();
  const panel = screen.getByRole("region", { name: "Sources" });
  expect(within(panel).getByText("1 of 1 used")).toBeInTheDocument();
  expect(within(panel).getByText("Ticked sources are what the chat and anything you make may use. Drop files anywhere on this panel to add them.")).toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("checkbox", { name: "Use Week 3 in this chat" }));
  expect(screen.getByText("0 of 1 sources")).toBeInTheDocument();
  expect(within(panel).getByText("0 of 1 used")).toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("button", { name: "Use all" }));
  expect(within(panel).getByText("1 of 1 used")).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "Use all" })).not.toBeInTheDocument();
});

test("a made thing plays in the right column, and @ suggests what is playing first", async () => {
  const made = directView("d1", { status: "done", outputId: "o1", title: "Limits, one screen at a time", type: "byte", job: undefined }, { status: "done" });
  const byte = { id: "o1", type: "byte", title: "Limits, one screen at a time", projectId: "p1", planId: "d1", itemId: "d1-i", payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: "A limit is where a function heads." }], cites: [] }] }, citations: [], createdAt: now, updatedAt: now };
  renderApp("/projects/p1", routes(made, { "GET /v1/outputs/:id": { output: byte } }));
  const studio = await screen.findByRole("region", { name: STUDIO });
  // Played things say Play, outlined like every button in Made here.
  const play = await within(studio).findByRole("button", { name: "Play Limits, one screen at a time" });
  expect(play).toHaveClass("obtn");
  expect(play).toHaveTextContent("Play");
  await userEvent.click(play);
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  expect((await within(playing).findAllByText("A limit is where a function heads.")).length).toBeGreaterThan(0);
  await userEvent.type(screen.getByLabelText("Message"), "@");
  const pop = screen.getByRole("listbox", { name: "Mention" });
  expect(within(pop).getAllByRole("option")[0]).toHaveTextContent("Limits, one screen at a time");
  expect(pop).toHaveTextContent("Playing now");
  // The way back is always there: on the panel itself, never inside the feed that scrolls.
  const back = within(within(playing).getByRole("banner")).getByRole("button", { name: "Back to the project" });
  expect(back.closest(".feed9")).toBeNull();
  await userEvent.click(back);
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

test("on a narrow window, tabs pick one panel at a time, the chat first", async () => {
  renderApp(OPENED, routes(planView()));
  await cardOf();
  const tabs = screen.getByRole("tablist", { name: "Panels" });
  expect(within(tabs).getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  // Chat, then Sources and Made with how many each holds.
  expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chat", "Sources · 1", "Made · 0"]);
  await userEvent.click(within(tabs).getByRole("tab", { name: /^Made/ }));
  expect(within(tabs).getByRole("tab", { name: /^Made/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("region", { name: STUDIO }).parentElement).toHaveClass("tab-made");
  // The phone's Sources tab says what the ticks mean in its own words.
  await userEvent.click(within(tabs).getByRole("tab", { name: /^Sources/ }));
  expect(screen.getByRole("region", { name: "Sources" }).parentElement).toHaveClass("tab-sources");
  expect(await screen.findByText("1 of 1 used by the chat and what you make")).toBeInTheDocument();
  expect(screen.getByText("Tap a source to read it. Its menu renames or removes it.")).toBeInTheDocument();
});

test("the Studio lists plans that have started, not drafts a chat made", async () => {
  const draft = { ...planView({ id: "pl2", title: "Draft in a chat", chatId: "c1" }), stages: [] };
  const running = planView({ status: "running", kickedOffAt: now });
  renderApp("/projects/p1", {
    ...routes(running),
    "GET /v1/projects/:id/plans": { plans: [{ ...running.plan, counts: running.counts }, { ...draft.plan, counts: draft.counts }] },
    "GET /v1/plans/:id": ({ params }: { params: Record<string, string> }) => (params.id === "pl2" ? draft : running),
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  expect(await within(studio).findByText("Plan: Unit 1")).toBeInTheDocument();
  expect(within(studio).queryByText(/Draft in a chat/)).not.toBeInTheDocument();
  expect(within(studio).getByRole("link", { name: "See in Library" })).toHaveAttribute("href", "/library?project=p1");
});

test("a thing made in another tab shows in the Studio without a reload, and a hidden tab still reads", async () => {
  const running = planView({ status: "running", kickedOffAt: now, title: "Made in another tab" });
  let made = false;
  renderApp("/projects/p1", {
    ...routes(running),
    "GET /v1/projects/:id/plans": () => ({ plans: made ? [{ ...running.plan, counts: running.counts }] : [] }),
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  expect(await within(studio).findByText("Nothing yet. What you make shows up here, and plays here.")).toBeInTheDocument();
  // Another tab starts something; this tab, hidden meanwhile, is shown again and looks at once.
  made = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(await within(studio).findByText("Plan: Made in another tab", {}, { timeout: 3000 })).toBeInTheDocument();
});

test("an old plan link opens the plan in its project", async () => {
  renderApp("/plans/pl1", routes(planView()));
  expect(await cardOf()).toBeInTheDocument();
});

test("an empty project offers a file drop, link and paste, and starts with a hello", async () => {
  renderApp("/projects/p1", { ...routes(planView()), "GET /v1/projects/:id/sources": { sources: [] }, "GET /v1/projects/:id/plans": { plans: [] } });
  expect(await screen.findByText("Drop anything here")).toBeInTheDocument();
  expect(await screen.findByText("Bring something to learn from, or just say hi.")).toBeInTheDocument();
  // With nothing made, the Studio is the place to make the first thing.
  const studio = screen.getByRole("region", { name: STUDIO });
  expect(within(studio).getByText("Nothing yet. What you make shows up here, and plays here.")).toBeInTheDocument();
  expect(within(studio).queryByRole("link", { name: "See in Library" })).not.toBeInTheDocument();
});

test("Add sources opens the adder as a dialog for this project", async () => {
  renderApp("/projects/p1", routes(planView()));
  await userEvent.click(await screen.findByRole("button", { name: "Add sources" }));
  expect(await screen.findByRole("dialog", { name: /^Add sources to / })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog", { name: /^Add sources to / })).not.toBeInTheDocument();
});

test("files dropped on the sources panel are added to the project", async () => {
  const calls: FakeRequest[] = [];
  renderApp("/projects/p1", {
    ...routes(planView()),
    "POST /v1/uploads": (req: FakeRequest) => {
      calls.push(req);
      return [201, { upload: { id: "u9", contentType: "application/pdf", byteLength: 4, uploadedAt: now } }];
    },
    "POST /v1/sources": (req: FakeRequest) => {
      calls.push(req);
      return [201, { source: { id: "s9", kind: "pdf", title: "dropped", createdAt: now, updatedAt: now }, extraction: { status: "ready" }, chunkCount: 1 }];
    },
  });
  const panel = await screen.findByRole("region", { name: "Sources" });
  const file = new File(["%PDF"], "dropped.pdf", { type: "application/pdf" });
  fireEvent.drop(panel, { dataTransfer: { files: [file], items: [], getData: () => "" } });
  await waitFor(() => expect(calls.some((c) => c.path === "/v1/sources")).toBe(true));
});

test("a reply stopped by the model account or a limit says so plainly, with no Try again; an old reply with no reason reads as a reply", async () => {
  renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 6 }] },
      "GET /v1/chats/:id": {
        chat,
        messages: [
          message(0, "user", "What is a limit?"),
          message(1, "assistant", "The model account at Example AI is out of credit.", { pieces: [say("The model account at Example AI is out of credit.")], failed: { reason: "outOfCredit" } }),
          message(2, "user", "And a series?"),
          message(3, "assistant", "Stopped at the $0.05 limit.", { pieces: [say("Stopped at the $0.05 limit.")], failed: { reason: "budget", budgetUsd: 0.05 } }),
          message(4, "user", "Hello?"),
          message(5, "assistant", "I couldn't write a reply just now.", { pieces: [say("I couldn't write a reply just now.")], usage: { calls: 1, failedCalls: 1, unpricedCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 } }),
        ],
      },
    }),
  );
  expect(await screen.findByText("The model account at Example AI is out of credit.")).toBeInTheDocument();
  expect(screen.getByText("Open Sourcebook stopped this reply: it reached the limit set for it.")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\$/);
  // Stored before replies said why they failed: drawn as what it says, not guessed at.
  expect(screen.getByText("I couldn't write a reply just now.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
});

test("the open chat is in the address: a link to a chat opens it, not the most recent one", async () => {
  renderApp(
    "/projects/p1?chat=c2",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 2 }, { ...chat, id: "c2", title: "Series", messageCount: 1 }] },
      "GET /v1/chats/:id": (req: FakeRequest) => (req.params.id === "c2" ? { chat: { ...chat, id: "c2", title: "Series" }, messages: [message(0, "user", "about series")] } : { chat, messages: [message(0, "user", "first question")] }),
    }),
  );
  expect(await screen.findByText("about series")).toBeInTheDocument();
  expect(screen.queryByText("first question")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Series" })).toBeInTheDocument();
});

test("ticks of a new chat survive a reload; ticks changed in a saved chat are saved on it", async () => {
  localStorage.clear();
  const other = { ...source, id: "s2", title: "Week 4" };
  const more = { "GET /v1/projects/:id/sources": { sources: [source, other] } };
  const first = renderApp("/projects/p1?chat=new", routes(planView(), more));
  await userEvent.click(await screen.findByRole("checkbox", { name: "Use Week 4 in this chat" }));
  first.unmount();
  renderApp("/projects/p1?chat=new", routes(planView(), more));
  await vi.waitFor(() => expect(screen.getByRole("checkbox", { name: "Use Week 4 in this chat" })).not.toBeChecked());
  expect(screen.getByRole("checkbox", { name: "Use Week 3 in this chat" })).toBeChecked();
  cleanup();

  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      ...more,
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "hi"), message(1, "assistant", "hello")] },
      "PATCH /v1/chats/:id": { chat: { ...chat, sources: ["s1"] } },
    }),
  );
  await screen.findByText("hello");
  await userEvent.click(screen.getByRole("checkbox", { name: "Use Week 4 in this chat" }));
  await vi.waitFor(() => expect(body(calls, "PATCH", "/v1/chats/c1")).toEqual({ sources: ["s1"] }));
});

test("a source that could not be read is not ticked or counted, says why from the list, and can be tried again", async () => {
  const broken = { ...source, id: "s2", kind: "web", title: "gone.example/x", url: "https://gone.example/x", status: "failed", errorMessage: "Nothing could be read from this source." };
  const { calls } = renderApp(
    "/projects/p1?chat=new",
    routes(planView(), {
      "GET /v1/projects/:id/sources": { sources: [source, broken] },
      "POST /v1/sources/:id/retry": { source: broken, extraction: { contentHash: "h2", kind: "web", status: "failed", errorMessage: "The page answered 404 again.", createdAt: now, updatedAt: now }, chunkCount: 0 },
    }),
  );
  const panel = await screen.findByRole("region", { name: "Sources" });
  const box = await within(panel).findByRole("checkbox", { name: "gone.example/x could not be read" });
  expect(box).not.toBeChecked();
  expect(box).toBeDisabled();
  expect(await within(panel).findByText("Nothing could be read from this source.")).toBeInTheDocument();
  // The reason comes with the list: the source is not read on its own for it.
  expect(calls.some((c) => c.method === "GET" && c.path === "/v1/sources/s2")).toBe(false);
  // Every readable source is ticked, so nothing says "1 of 2".
  expect(within(panel).queryByText(/of 2/)).not.toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Week 3 is read and ready" })).toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("button", { name: "Try again" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/sources/s2/retry")).toBe(true);
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/sources")).toBe(false);
  expect(await within(panel).findByText("The page answered 404 again.")).toBeInTheDocument();
});

test("a source is renamed in place from its menu, and removed after saying what happens", async () => {
  let list = [source, { ...source, id: "s2", title: "Week 4" }];
  const { calls } = renderApp(
    "/projects/p1?chat=new",
    routes(planView(), {
      "GET /v1/projects/:id/sources": () => ({ sources: list }),
      "PATCH /v1/sources/:id": (req: FakeRequest) => {
        list = list.map((x) => (x.id === req.params.id ? { ...x, title: (req.body as { title: string }).title } : x));
        return { source: list.find((x) => x.id === req.params.id) };
      },
      "DELETE /v1/sources/:id": (req: FakeRequest) => {
        list = list.filter((x) => x.id !== req.params.id);
        return { sourceId: req.params.id, deleted: false, changedPlanIds: ["pl1"] };
      },
    }),
  );
  const panel = await screen.findByRole("region", { name: "Sources" });
  await userEvent.click(await within(panel).findByRole("button", { name: "More for Week 4" }));
  const menu = screen.getByRole("menu", { name: "More for Week 4" });
  // Rename first, what loses something last.
  expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Rename", "Remove…"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
  const name = within(panel).getByLabelText("Source name");
  await userEvent.clear(name);
  await userEvent.type(name, "Week 4 notes{Enter}");
  expect(body(calls, "PATCH", "/v1/sources/s2")).toEqual({ title: "Week 4 notes" });
  expect(await within(panel).findByRole("button", { name: "Week 4 notes" })).toBeInTheDocument();

  await userEvent.click(within(panel).getByRole("button", { name: "More for Week 4 notes" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
  const ask = screen.getByRole("alertdialog", { name: "Remove “Week 4 notes”?" });
  expect(ask).toHaveTextContent("keep their citations");
  // Escape and Cancel lose nothing.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(within(panel).getByRole("button", { name: "More for Week 4 notes" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove source" }));
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sources/s2")).toBe(true);
  await vi.waitFor(() => expect(within(panel).queryByText("Week 4 notes")).not.toBeInTheDocument());
  // A plan not started that read it is read again.
  await vi.waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/projects/p1/plans").length).toBeGreaterThan(1));
});

test("a source read only by its title is marked, and the reader says what could not be read; a removed one says so and keeps its text", async () => {
  const titleOnly = { ...source, id: "s2", kind: "youtube", title: "A talk", accessLevel: "metadata" };
  const removed = { ...source, removedAt: now };
  const limitation = "Only this video's title and channel name could be read, not what is said in it.";
  renderApp(
    "/projects/p1?chat=new",
    routes(planView(), {
      "GET /v1/projects/:id/sources": { sources: [source, titleOnly] },
      "GET /v1/sources/:id": (req: FakeRequest) =>
        req.params.id === "s2"
          ? { source: titleOnly, extraction: { contentHash: "h2", kind: "youtube", status: "ready", accessLevel: "metadata", text: "A talk", limitations: [limitation], createdAt: now, updatedAt: now }, chunkCount: 1 }
          : { source: removed, extraction: { contentHash: "h", kind: "pdf", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 },
    }),
  );
  const panel = await screen.findByRole("region", { name: "Sources" });
  const mark = await within(panel).findByText("Title only");
  await vi.waitFor(() => expect(mark).toHaveAttribute("title", limitation));
  await userEvent.click(within(panel).getByRole("button", { name: "A talk" }));
  const reader = await screen.findByRole("region", { name: "Source" });
  expect(await within(reader).findByText(limitation, { exact: false })).toBeInTheDocument();
  cleanup();

  renderApp("/projects/p1?source=s1&at=0-7", routes(planView(), { "GET /v1/sources/:id": { source: removed, extraction: { contentHash: "h", kind: "pdf", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 } }));
  const gone = await screen.findByRole("region", { name: "Source" });
  expect(await within(gone).findByText(/This source was removed/)).toBeInTheDocument();
  expect(within(gone).getByText("A limit")).toHaveClass("spot");
  // Nothing to rename on a removed source.
  expect(within(gone).queryByRole("button", { name: "Week 3" })).not.toBeInTheDocument();
});

test("Open the file opens a link source's link, an uploaded source's own file, and is not offered for pasted text", async () => {
  renderApp("/projects/p1?source=s1", routes(planView(), { "GET /v1/sources/:id": { source: { ...source, uploadId: "u1" }, extraction: { contentHash: "h", kind: "pdf", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 } }));
  const uploaded = await screen.findByRole("region", { name: "Source" });
  expect(await within(uploaded).findByRole("link", { name: "Open the file" })).toHaveAttribute("href", "/api/v1/sources/s1/file");
  cleanup();

  renderApp("/projects/p1?source=s1", routes(planView(), { "GET /v1/sources/:id": { source: { ...source, kind: "web", url: "https://example.org/limits" }, extraction: { contentHash: "h", kind: "web", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 } }));
  const linked = await screen.findByRole("region", { name: "Source" });
  expect(await within(linked).findByRole("link", { name: "Open the file" })).toHaveAttribute("href", "https://example.org/limits");
  cleanup();

  renderApp("/projects/p1?source=s1", routes(planView(), { "GET /v1/sources/:id": { source: { ...source, kind: "text" }, extraction: { contentHash: "h", kind: "text", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 } }));
  const pasted = await screen.findByRole("region", { name: "Source" });
  await within(pasted).findByText("A limit describes…");
  expect(within(pasted).queryByRole("link", { name: "Open the file" })).not.toBeInTheDocument();
});

test("the reader's title renames the source", async () => {
  const { calls } = renderApp("/projects/p1?source=s1", routes(planView(), { "PATCH /v1/sources/:id": { source: { ...source, title: "Week 3, limits" } } }));
  const reader = await screen.findByRole("region", { name: "Source" });
  await userEvent.click(await within(reader).findByRole("button", { name: "Week 3" }));
  const name = within(reader).getByLabelText("Source name");
  await userEvent.type(name, " draft{Escape}");
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  await userEvent.click(within(reader).getByRole("button", { name: "Week 3" }));
  await userEvent.clear(within(reader).getByLabelText("Source name"));
  await userEvent.type(within(reader).getByLabelText("Source name"), "Week 3, limits{Enter}");
  expect(body(calls, "PATCH", "/v1/sources/s1")).toEqual({ title: "Week 3, limits" });
});

test("a failed item says why in the engine's words, and Try again makes it again, on the card and in the Studio", async () => {
  let current = planView({ status: "failed", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1" }), item("b", 2, 0, { type: "quiz", title: "Check", status: "failed", errorMessage: "The model account is out of credit.", sources: [{ sourceId: "s1" }] })]);
  const { calls } = renderApp(
    OPENED,
    routes(() => current, {
      "POST /v1/plans/:id/items/:itemId/retry": () => {
        current = { ...current, plan: { ...current.plan, status: "running" }, items: current.items.map((i) => (i.id === "b" ? { ...i, status: "queued", errorMessage: undefined } : i)) };
        return current;
      },
    }),
  );
  const card = await cardOf();
  expect(await within(card).findByText("The model account is out of credit.")).toBeInTheDocument();
  // The plan read carries the reason; progress is not read for it.
  expect(calls.some((c) => c.path.endsWith("/progress"))).toBe(false);
  const studio = screen.getByRole("region", { name: STUDIO });
  expect(within(studio).getByRole("group", { name: "Plan: Unit 1" })).toHaveTextContent("Failed · 1 of 2 made");
  await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/pl1/items/b/retry")).toBe(true);
  await vi.waitFor(() => expect(within(card).queryByText("The model account is out of credit.")).not.toBeInTheDocument());
  await vi.waitFor(() => expect(within(studio).getByRole("group", { name: "Plan: Unit 1" })).toHaveTextContent("Making · 1 of 2 made"));
});

test("an issue about an item is said on its row in its short words, with the fix its code names; the rest under the plan", async () => {
  const issues = ['"Recap" reads no sources: pick at least one', '"Clip" is in a format that can\'t be made yet', "The plan is over its budget"];
  const view = {
    ...planView(undefined, [item("a", 1, 0, { title: "Recap" }), item("v", 1, 1, { title: "Clip", type: "video", sources: [{ sourceId: "s1" }] })]),
    issues,
    issueDetails: [
      { code: "no_sources", message: issues[0]!, short: "Reads no sources: pick at least one", itemId: "a" },
      { code: "format_not_ready", message: issues[1]!, short: "Its format can't be made yet", itemId: "v" },
      { code: "over_budget", message: issues[2]!, short: "Over budget" },
    ],
  };
  renderApp(OPENED, routes(view));
  const card = await cardOf();
  const row = within(card).getByText("Reads no sources: pick at least one").closest(".itw")!;
  expect(within(row as HTMLElement).getByRole("button", { name: "Details for Recap" })).toBeInTheDocument();
  // The full sentence, which names the item, is not repeated anywhere.
  expect(within(card).queryByText(issues[0]!)).not.toBeInTheDocument();
  expect(within(card).getByText("Before it can start:")).toHaveTextContent("The plan is over its budget");
  const clip = within(card).getByText("Its format can't be made yet").closest(".itw") as HTMLElement;
  expect(within(clip).getByRole("button", { name: "Change format" })).toBeInTheDocument();
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Pick sources" }));
  const editor = within(card).getByRole("form", { name: "Item details" });
  expect(within(within(editor).getByRole("group", { name: "Sources" })).getByRole("button", { name: "Week 3" })).toHaveAttribute("aria-pressed", "false");
});

test("a discarded plan says so; a stopped one says Stopped and Resume starts it again, on the card and in the Studio", async () => {
  renderApp(OPENED, routes(planView({ status: "discarded" })));
  const discarded = await cardOf();
  expect(await within(discarded).findByText("Discarded")).toBeInTheDocument();
  expect(within(discarded).queryByRole("button", { name: /Resume|Start/ })).not.toBeInTheDocument();
  cleanup();
  let current = planView({ status: "cancelled", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1", sources: [{ sourceId: "s1" }] }), item("b", 2, 0, { status: "cancelled", sources: [{ sourceId: "s1" }] })]);
  const { calls } = renderApp(
    OPENED,
    routes(() => current, {
      "POST /v1/plans/:id/resume": () => {
        current = { ...current, plan: { ...current.plan, status: "running" }, items: current.items.map((i) => (i.id === "b" ? { ...i, status: "queued" } : i)) };
        return current;
      },
    }),
  );
  const card = await cardOf();
  expect(await within(card).findByText("Stopped")).toBeInTheDocument();
  // Card and Studio say the same thing about a stopped plan: how much was made.
  expect(within(card).getByText("1 of 2 made")).toBeInTheDocument();
  const studio = screen.getByRole("region", { name: STUDIO });
  expect(within(studio).getByRole("group", { name: "Plan: Unit 1" })).toHaveTextContent("Stopped · 1 of 2 made");
  await userEvent.click(within(card).getByRole("button", { name: "Resume" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/pl1/resume")).toBe(true);
  await vi.waitFor(() => expect(within(card).queryByText("Stopped")).not.toBeInTheDocument());
  await vi.waitFor(() => expect(within(studio).getByRole("group", { name: "Plan: Unit 1" })).toHaveTextContent("Making"));
});

test("the chat menu renames the chat, and deletes it after saying what goes; the next chat opens", async () => {
  const older = { ...chat, id: "c2", title: "Older", messageCount: 2 };
  let chats = [{ ...chat, title: "Limits", messageCount: 2 }, older];
  const { calls } = renderApp(
    "/projects/p1?chat=c1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": () => ({ chats }),
      "GET /v1/chats/:id": (req: FakeRequest) => ({ chat: chats.find((c) => c.id === req.params.id), messages: [message(0, "user", req.params.id === "c1" ? "first chat" : "older chat")] }),
      "PATCH /v1/chats/:id": (req: FakeRequest) => {
        chats = chats.map((c) => (c.id === req.params.id ? { ...c, title: (req.body as { title: string }).title } : c));
        return { chat: chats.find((c) => c.id === req.params.id) };
      },
      "DELETE /v1/chats/:id": (req: FakeRequest) =>
        calls.filter((c) => c.method === "DELETE").length === 1 ? [409, { error: "chat_busy", message: "A reply is being written in this chat; wait for it" }] : ((chats = chats.filter((c) => c.id !== req.params.id)), { chatId: req.params.id, deletedPlanIds: [], keptPlanIds: [] }),
    }),
  );
  await screen.findByText("first chat");
  // The chat's title opens its menu: the project's chats with when each was used, then New chat, Rename and Delete.
  await userEvent.click(screen.getByRole("button", { name: "Limits" }));
  expect(screen.getByRole("button", { name: /^Older/ })).toHaveTextContent(/ago|now|yesterday|\d/);
  expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Rename this chat" }));
  const name = screen.getByLabelText("Chat name");
  await userEvent.clear(name);
  await userEvent.type(name, "Limits, part 1{Enter}");
  expect(body(calls, "PATCH", "/v1/chats/c1")).toEqual({ title: "Limits, part 1" });
  expect(await screen.findByRole("button", { name: /Limits, part 1/ })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Limits, part 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete this chat…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete “Limits, part 1”?" });
  expect(ask).toHaveTextContent("Its messages go.");
  await userEvent.click(within(ask).getByRole("button", { name: "Delete chat" }));
  // Busy: said calmly, nothing gone.
  expect(await within(ask).findByText(/still writing a reply/)).toBeInTheDocument();
  await userEvent.click(within(ask).getByRole("button", { name: "Delete chat" }));
  expect(await screen.findByText("older chat")).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Older/ })).toBeInTheDocument();
});

test("a plan with nothing made shows no Play", async () => {
  renderApp(OPENED, routes(planView({ status: "failed", kickedOffAt: now }, [item("a", 1, 0, { status: "failed", sources: [{ sourceId: "s1" }] })]), { "GET /v1/plans/:id/progress": { plan: { id: "pl1", projectId: "p1", status: "failed" }, stages: [], counts: { total: 1, done: 0 }, items: [] } }));
  const card = await cardOf();
  expect(within(card).getByText("Failed")).toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: /^Play/ })).not.toBeInTheDocument();
  expect(within(card).queryByRole("link", { name: /^Play/ })).not.toBeInTheDocument();
});

test("typing / lists the engine's commands; Tab completes one", async () => {
  renderApp("/projects/p1", routes(planView()));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await screen.findByRole("button", { name: "Tools" });
  await userEvent.type(box, "/");
  const list = screen.getByRole("listbox", { name: "Commands" });
  // Grouped as the engine groups them: what is made, then plans, then what answers in the chat; each by its own title.
  expect(within(list).getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["set of flashcards, /flashcards", "quiz, /quiz", "Make a plan, /plan", "Explain it back, /teachback", "Map the ideas, /mindmap"]);
  expect(list).toHaveTextContent("Make · opens its sheet, filled in");
  expect(list).toHaveTextContent("In the chat · makes nothing");
  await userEvent.type(box, "pl");
  await userEvent.keyboard("{Tab}");
  expect(box).toHaveValue("/plan ");
  expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
});

test("Escape cancels renaming the project", async () => {
  const { calls } = renderApp("/projects/p1", routes(planView()));
  await userEvent.click(await screen.findByRole("button", { name: "Project menu" }));
  await userEvent.click(screen.getByRole("button", { name: "Rename" }));
  await userEvent.type(screen.getByLabelText("Project title"), " typo{Escape}");
  expect(screen.queryByLabelText("Project title")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: /^Calculus I\b/ })).toBeInTheDocument();
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("a Markdown source reads as formatted text", async () => {
  const md = { ...source, kind: "text", title: "cells.md" };
  renderApp(
    "/projects/p1?source=s1",
    routes(planView(), {
      "GET /v1/sources/:id": { source: md, extraction: { contentHash: "h", kind: "text", status: "ready", text: "# Cell respiration\n\nCells make **ATP**.\n\n- glycolysis\n- Krebs cycle", createdAt: now, updatedAt: now }, chunkCount: 1 },
    }),
  );
  const reader = await screen.findByRole("region", { name: "Source" });
  expect(await within(reader).findByRole("heading", { name: "Cell respiration" })).toBeInTheDocument();
  expect(within(reader).getByText("ATP").tagName).toBe("STRONG");
  expect(within(reader).getAllByRole("listitem")).toHaveLength(2);
  expect(reader.textContent).not.toContain("# Cell");
});

test("Discard asks first, since a discarded plan can't be started", async () => {
  const { calls } = renderApp(OPENED, routes(planView(), { "POST /v1/plans/:id/cancel": planView({ status: "discarded" }) }));
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Discard" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.path === "/v1/plans/pl1/cancel")).toBe(false);
  await userEvent.click(within(card).getByRole("button", { name: "Discard" }));
  await userEvent.click(screen.getByRole("button", { name: "Discard plan" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/pl1/cancel")).toBe(true);
  expect(await within(card).findByText("Discarded")).toBeInTheDocument();
});

test("an item uses an earlier one by a kind picked from the engine's list, said in its label with what it means", async () => {
  let current = planView(undefined, [item("a", 1, 0, { title: "Limits", sources: [{ sourceId: "s1" }] }), item("b", 2, 0, { title: "Check", type: "quiz", sources: [{ sourceId: "s1" }] })]);
  const { calls } = renderApp(
    OPENED,
    routes(() => current, {
      "POST /v1/plans/:id/edges": (req: FakeRequest) => {
        current = { ...current, edges: [req.body as PlanView["edges"][number]] };
        return current;
      },
    }),
  );
  const card = await cardOf();
  await userEvent.click(within(card).getByRole("button", { name: "Details for Check" }));
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const editor = within(card).getByRole("form", { name: "Item details" });
  await userEvent.click(within(editor).getByText("Brief, condition and place in the plan"));
  const how = within(editor).getByRole("combobox", { name: "How it uses it" });
  expect(within(how).getAllByRole("option").map((o) => o.textContent)).toEqual(["Builds on", "Fixes"]);
  expect(editor).toHaveTextContent("May rely on what the earlier item made, without going over it again.");
  await userEvent.selectOptions(how, "fix_of");
  expect(editor).toHaveTextContent("Works on what was missed in the earlier item");
  await userEvent.selectOptions(within(editor).getByRole("combobox", { name: "Earlier item" }), "a");
  await userEvent.click(within(editor).getByRole("button", { name: "Use it" }));
  expect(body(calls, "POST", "/v1/plans/pl1/edges")).toEqual({ from: "a", to: "b", kind: "fix_of" });
  expect(await within(editor).findByRole("button", { name: "Stop using Limits" })).toBeInTheDocument();
  expect(within(editor).getByText("Fixes", { selector: ".chip" })).toBeInTheDocument();
});

test("Play shows what it plays even while a source is open beside the chat", async () => {
  const current = { ...planView({ status: "done", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1", title: "Limits, one screen at a time" })]), counts: { total: 1, done: 0 } };
  const byte = { id: "o1", type: "byte", title: "Limits, one screen at a time", projectId: "p1", planId: "pl1", itemId: "a", payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: "A limit is where a function heads." }], cites: [] }] }, citations: [], createdAt: now, updatedAt: now };
  renderApp(`${OPENED}&source=s1`, routes(() => current, { "GET /v1/outputs/:id": { output: byte } }));
  const card = await cardOf();
  await userEvent.click(within(card).getAllByRole("button", { name: "Play Limits, one screen at a time" })[0]!);
  expect(await screen.findByRole("complementary", { name: "Playing" })).toBeInTheDocument();
});

test("a cite in a playing byte is a number at its claim that opens the exact words", async () => {
  const text = "Intro. A limit exists only when both one-sided limits agree. More.";
  const current = { ...planView({ status: "done", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1", title: "Limits" })]), counts: { total: 1, done: 0 } };
  const byte = {
    id: "o1", type: "byte", title: "Limits", projectId: "p1", planId: "pl1", itemId: "a", citations: [], createdAt: now, updatedAt: now,
    payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "heading", text: "Both sides" }, { type: "text", text: "A limit needs both sides to agree." }], cites: [{ sourceId: "s1", spot: "passage", block: 1, locator: { charStart: 7, charEnd: 61 }, quote: "both one-sided limits agree" }] }] },
  };
  renderApp(`${OPENED}&play=o1`, routes(() => current, {
    "GET /v1/outputs/:id": { output: byte },
    "GET /v1/sources/:id": { source, extraction: { contentHash: "h", kind: "pdf", status: "ready", text, createdAt: now, updatedAt: now }, chunkCount: 1 },
  }));
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  const mark = await within(playing).findByRole("button", { name: /^Source 1: Week 3/ });
  // The mark sits at the end of the words it supports.
  expect(mark.closest("p")).toHaveTextContent("A limit needs both sides to agree.");
  await userEvent.click(mark);
  const reader = await screen.findByRole("region", { name: "Source" });
  expect(await within(reader).findByText("both one-sided limits agree", { selector: "mark" })).toHaveClass("spot");
});

test("marking a thing done in the Studio player updates the plan card at once", async () => {
  let current = { ...planView({ status: "done", kickedOffAt: now }, [item("a", 1, 0, { status: "done", outputId: "o1", title: "Limits, one screen at a time" })]), counts: { total: 1, done: 0 } };
  const byte = { id: "o1", type: "byte", title: "Limits, one screen at a time", projectId: "p1", planId: "pl1", itemId: "a", payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: "A limit is where a function heads." }], cites: [] }] }, citations: [], createdAt: now, updatedAt: now };
  renderApp(`${OPENED}&play=o1`, routes(() => current, {
    "GET /v1/outputs/:id": { output: byte },
    "POST /v1/plans/:id/items/:itemId/done": () => {
      current = { ...current, items: current.items.map((i) => ({ ...i, done: true })), counts: { total: 1, done: 1 } };
      return { item: { id: "a", done: true }, counts: { total: 1, done: 1 } };
    },
  }));
  const card = await cardOf();
  expect(within(card).getByText("All made")).toBeInTheDocument();
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  // A one-card set: through its card to its end, which marks it done.
  await userEvent.click(await within(playing).findByRole("button", { name: /Finish/ }));
  expect(await within(card).findByText("Done")).toBeInTheDocument();
  expect(within(card).getByText("1 of 1 gone through")).toBeInTheDocument();
});

test("an archived project says so with Restore beside it, and Restore brings it back", async () => {
  const { calls } = renderApp("/projects/p1", {
    ...routes(planView()),
    "GET /v1/projects/:id": { project: { ...project, archivedAt: now } },
    "POST /v1/projects/:id/unarchive": { project },
  });
  const note = (await screen.findByText(/This project is archived/)).closest(".notice") as HTMLElement;
  await userEvent.click(within(note).getByRole("button", { name: "Restore" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/p1/unarchive")).toBe(true);
  await vi.waitFor(() => expect(screen.queryByText(/This project is archived/)).not.toBeInTheDocument());
});

test("an item's details open with Enter and fold away with Escape, focus back on its row", async () => {
  renderApp(OPENED, routes(planView()));
  const card = await cardOf();
  const row = within(card).getByRole("button", { name: "Details for Item a" });
  row.focus();
  await userEvent.keyboard("{Enter}");
  const details = within(card).getByRole("region", { name: "Item details" });
  within(details).getByRole("button", { name: "Edit" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(within(card).queryByRole("region", { name: "Item details" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(within(card).getByRole("button", { name: "Details for Item a" })).toHaveFocus());
  await userEvent.keyboard("{Enter}");
  expect(within(card).getByRole("region", { name: "Item details" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(within(card).queryByRole("region", { name: "Item details" })).not.toBeInTheDocument();
});

test("a file that can never be read offers Remove, not Try again", async () => {
  const junk = { ...source, id: "s3", kind: "unknown", title: "scan", status: "failed", retryable: false, errorMessage: "Nothing could be read from this source. This kind of file could not be read." };
  renderApp("/projects/p1?chat=new", routes(planView(), { "GET /v1/projects/:id/sources": { sources: [source, junk] } }));
  const panel = await screen.findByRole("region", { name: "Sources" });
  expect(await within(panel).findByText(/This kind of file could not be read/)).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("button", { name: "Remove" }));
  expect(await screen.findByText("Remove “scan”?")).toBeInTheDocument();
});

test("when Open Sourcebook's server does not answer, the project keeps a way home, says the work is safe, and comes back by itself", async () => {
  let down = true;
  renderApp("/projects/p1", {
    ...routes(planView()),
    "GET /v1/projects/:id": () => (down ? [502, { error: "engine_unreachable", message: "The engine did not answer." }] : { project: { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now } }),
  });
  expect(await screen.findByText("Can't reach Open Sourcebook right now")).toBeInTheDocument();
  expect(screen.getByText(/Your work is safe/)).toBeInTheDocument();
  expect(screen.queryByText(/engine/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  down = false;
  window.dispatchEvent(new Event("online"));
  // Coming back draws the whole project again; on a busy machine that can take longer than a find's second.
  expect(await screen.findByText("Calculus I", {}, { timeout: 4000 })).toBeInTheDocument();
});

test("a /plan message shows the command as a tag, not a raw slash word", async () => {
  renderApp(
    "/projects/p1?chat=c1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 1 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "/plan I have an exam next week")] },
    }),
  );
  const said = (await screen.findByText("I have an exam next week", { exact: false })).closest(".me")!;
  expect(within(said as HTMLElement).getByText("Make a plan")).toBeInTheDocument();
  expect(said.textContent).not.toContain("/plan");
});

const providers = {
  connector: { configured: true, reachable: true },
  providers: [
    {
      id: "claude", label: "Claude Code", mark: { path: "M2 2h20v20H2z", color: "#D97757" }, local: true, added: true, enabled: true, state: "ready", headline: "Ready", default: true, defaultModel: "haiku", defaultEffort: "medium", pick: "agent:claude",
      models: [
        { id: "haiku", pick: "agent:claude:haiku", label: "Haiku", shown: true, favorite: false },
        { id: "sonnet", pick: "agent:claude:sonnet", label: "Sonnet", shown: false, favorite: false },
        { id: "opus", pick: "agent:claude:opus", label: "Opus", shown: true, favorite: true },
      ],
      efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "max", label: "Max" }],
    },
    { id: "codex", label: "Codex", local: true, added: true, enabled: true, state: "unavailable", headline: "Can't run yet", detail: "Open Sourcebook can't run Codex yet.", pick: "agent:codex", models: [], efforts: [] },
    { id: "other", label: "Other agent", local: true, added: true, enabled: false, state: "ready", headline: "Ready", pick: "agent:other", models: [], efforts: [] },
    { id: "pi", label: "Pi", local: true, added: false, enabled: true, state: "ready", headline: "Ready", pick: "agent:pi", models: [], efforts: [] },
  ],
};

test("Chat answers with opens on the agents that are on, A to Z, their shown models and efforts, says it only answers the chat, and a pick is kept on the chat", async () => {
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Limits", messageCount: 0 }] },
      "GET /v1/chats/:id": { chat: { ...chat, title: "Limits" }, messages: [] },
      "GET /v1/providers": providers,
      "PATCH /v1/chats/:id": (req: FakeRequest) => ({ chat: { ...chat, title: "Limits", messageCount: 0, ...(req.body as object) } }),
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Chat answers with Claude Code, Haiku, Medium. Change" }));
  const dialog = screen.getByRole("dialog", { name: "Who answers this chat" });
  expect(dialog).toHaveTextContent("Only the chat. It never decides what makes a video, a quiz or anything else");
  // Only agents in the list and on, A to Z; none is marked as the default.
  expect(within(within(dialog).getByRole("tablist")).getAllByRole("tab").map((t) => t.lastElementChild?.textContent)).toEqual(["Claude Code", "Codex"]);
  expect(within(dialog).queryByText(/^default$/i)).toBeNull();
  // A hidden model is not offered.
  expect(within(within(dialog).getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["Haiku", "Opus"]);
  await userEvent.click(within(dialog).getByRole("tab", { name: "Codex" }));
  expect(within(dialog).getByRole("link", { name: "How to connect" })).toHaveAttribute("href", "/settings?provider=codex#providers");
  await userEvent.click(within(dialog).getByRole("tab", { name: "Claude Code" }));
  await userEvent.click(within(dialog).getByRole("option", { name: /Opus/ }));
  expect(body(calls, "PATCH", "/v1/chats/c1")).toEqual({ answerer: "agent:claude:opus" });
  expect(await screen.findByRole("button", { name: "Chat answers with Claude Code, Opus, Medium. Change" })).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "Max" }));
  expect(calls.filter((c) => c.method === "PATCH" && c.path === "/v1/chats/c1").at(-1)?.body).toEqual({ effort: "max" });
  // The fake engine keeps only what the last PATCH sent, so the chip shows the default model with the new effort.
  expect(await screen.findByRole("button", { name: /^Chat answers with .*, Max. Change$/ })).toBeInTheDocument();
});

test("a new chat's pick and effort go with its first message", async () => {
  const { calls } = renderApp(
    "/projects/p1?chat=new",
    routes(planView(), {
      "GET /v1/providers": providers,
      "POST /v1/projects/:id/chats": [201, { chat }],
      "POST /v1/chats/:id/messages": { chat: { ...chat, answerer: "agent:claude:opus", effort: "low", messageCount: 2 }, messages: [message(0, "user", "hi"), message(1, "assistant", "hello")] },
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Chat answers with Claude Code, Haiku, Medium. Change" }));
  await userEvent.click(within(screen.getByRole("listbox", { name: "Models" })).getByRole("option", { name: "Opus" }));
  await userEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "Low" }));
  await userEvent.type(screen.getByLabelText("Message"), "hi{Enter}");
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toMatchObject({ text: "hi", answerer: "agent:claude:opus", effort: "low" });
  expect(await screen.findByRole("button", { name: "Chat answers with Claude Code, Opus, Low. Change" })).toBeInTheDocument();
});

test("above the chat box, a banner says when the agent can't be reached, and Check again asks the connector again", async () => {
  let reachable = false;
  const { calls } = renderApp("/projects/p1", routes(planView(), { "GET /v1/providers": () => ({ ...sampleProviders, connector: { configured: true, reachable } }) }));
  const banner = await screen.findByText("Your agent can't be reached. Start the connector on this computer, then check again.");
  expect(screen.queryByText("Set up a provider")).not.toBeInTheDocument();
  reachable = true;
  await userEvent.click(within(banner.parentElement!).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByText(/Your agent can't be reached/)).not.toBeInTheDocument());
  expect(calls.some((c) => c.path === "/v1/providers" && c.query.get("fresh") === "1")).toBe(true);
  expect(screen.getByRole("button", { name: /^Chat answers with/ })).toBeInTheDocument();
});

test("the chat reads the one shared providers load: a failed load says Couldn't reach the engine, and Try again asks once more", async () => {
  let up = false;
  const { calls } = renderApp("/projects/p1", routes(planView(), { "GET /v1/providers": () => (up ? sampleProviders : [503, { error: "unavailable", message: "Down." }]) }));
  const again = await screen.findByRole("button", { name: "Couldn't reach the engine. Try again." });
  expect(screen.queryByText("Set up a provider")).not.toBeInTheDocument();
  // Only the shared load asked; the chat has no copy of its own.
  expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/providers")).toHaveLength(1);
  up = true;
  await userEvent.click(again);
  expect(await screen.findByRole("button", { name: /^Chat answers with/ })).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/providers")).toHaveLength(2);
});

// ── Things made at once, and the Studio as a place to make ──────────────────

function directView(id: string, extra: Partial<Item> = {}, plan: Partial<PlanView["plan"]> = {}): PlanView {
  return {
    plan: { id, projectId: "p1", title: `Thing ${id}`, version: 1, status: "running", createdAt: now, updatedAt: now, kickedOffAt: now, direct: true, chatId: "c1", ...plan },
    stages: [],
    items: [item(`${id}-i`, 1, 0, { type: "quiz", title: `Quiz ${id}`, plannedAs: ["5 questions"], status: "running", job: { id: "j", status: "running", stage: "make", progress: 0.2, attempt: 1, step: "Writing question 2 of 5" } as Item["job"], ...extra })],
    edges: [],
    counts: { total: 1, done: 0 },
    estimateUsd: 0,
    issues: [],
  };
}

test("a thing made at once shows in the chat as its own row with its live step and Stop, not a plan card", async () => {
  const thing = directView("d1");
  const { calls } = renderApp("/projects/p1?chat=c1", {
    ...routes(thing),
    "GET /v1/projects/:id/chats": { chats: [{ ...chat, title: "Quiz", messageCount: 2 }] },
    "GET /v1/chats/:id": {
      chat: { ...chat, title: "Quiz", messageCount: 2 },
      messages: [message(0, "user", "/quiz the loops"), message(1, "assistant", "Making a five-question quiz on the loops.", { pieces: [say("Making a five-question quiz on the loops."), { kind: "plan", planId: "d1", action: "created", made: "made" }] })],
    },
    "POST /v1/plans/:id/cancel": { ...thing, plan: { ...thing.plan, status: "cancelled" } },
  });
  const row = await within(await screen.findByRole("region", { name: "Chat" })).findByRole("group", { name: "Quiz d1" });
  expect(screen.queryByRole("article", { name: /^Plan:/ })).not.toBeInTheDocument();
  expect(row).toHaveTextContent("quiz · 5 questions");
  expect(row).toHaveTextContent("Writing question 2 of 5");
  // The person's command shows as the format's name.
  expect(screen.getByText("Quiz", { selector: ".ref.said" })).toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "Stop" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/d1/cancel")).toBe(true);
  expect(await within(row).findByText("Stopped before it was made.")).toBeInTheDocument();
});

test("once made, the card plays it; the next message carries what is open", async () => {
  const thing = directView("d1", { status: "done", outputId: "o1", job: undefined });
  const quiz = { id: "o1", type: "quiz", title: "Quiz d1", projectId: "p1", planId: "d1", itemId: "d1-i", payload: { questions: [] }, citations: [], createdAt: now, updatedAt: now };
  const { calls } = renderApp("/projects/p1?chat=c1", {
    ...routes({ ...thing, plan: { ...thing.plan, status: "done" } }),
    "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 2 }] },
    "GET /v1/chats/:id": { chat: { ...chat, messageCount: 2 }, messages: [message(0, "user", "/quiz"), message(1, "assistant", "Made.", { pieces: [{ kind: "plan", planId: "d1", action: "created", made: "made" }] })] },
    "GET /v1/outputs/:id": { output: quiz },
    "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 4 }, messages: [message(2, "user", "make it shorter")], plans: [] },
  });
  const row = await within(await screen.findByRole("region", { name: "Chat" })).findByRole("group", { name: "Quiz d1" });
  // A card, as in Made here: no hint under it.
  expect(row).not.toHaveTextContent("Just say so here");
  await userEvent.click(within(row).getByRole("button", { name: "Play Quiz d1" }));
  await screen.findByRole("complementary", { name: "Playing" });
  await userEvent.type(screen.getByLabelText("Message"), "make it shorter{Enter}");
  expect(body(calls, "POST", "/v1/chats/c1/messages")).toMatchObject({ text: "make it shorter", opened: "d1-i" });
});

test("Make has a tile per shape from the registry; a tile opens its make sheet, which makes it only when its button is pressed", async () => {
  const made = directView("d2", {}, { chatId: undefined });
  const views: PlanView[] = [];
  const { calls } = renderApp("/projects/p1", {
    ...routes(planView()),
    "GET /v1/projects/:id/plans": () => ({ plans: views.map((v) => ({ ...v.plan, counts: v.counts })) }),
    "POST /v1/projects/:id/make/settle": { settings: { cards: 20, kinds: ["recall", "cloze"] }, plannedAs: "Your agent · 20 cards", issues: [] },
    "POST /v1/projects/:id/make": () => (views.push(made), made),
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  const tiles = within(studio).getByRole("group", { name: "Make" });
  await within(tiles).findByRole("button", { name: "quiz" });
  // From the registry: every shape by its own name, one that can't be made yet held back; the plan row sits under them.
  expect(within(tiles).getAllByRole("button").map((b) => b.textContent)).toEqual(["video", "flashcards", "quiz"]);
  expect(within(tiles).getByRole("button", { name: "video" })).toBeDisabled();
  expect(within(studio).getByRole("button", { name: /^Plan a whole subject/ })).toHaveTextContent("Items in order, made one after another");
  await userEvent.click(within(tiles).getByRole("button", { name: "flashcards" }));
  const sheet = await screen.findByRole("region", { name: "Make a set of flashcards" });
  expect(screen.queryByRole("region", { name: STUDIO })).not.toBeInTheDocument();
  // It starts from the shape's defaults: the count is Auto, with no number.
  expect(within(within(sheet).getByRole("group", { name: "Cards" })).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.type(within(sheet).getByLabelText("What it covers"), "one-sided limits");
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/p1/make")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Make the flashcards" }));
  await waitFor(() => expect(body(calls, "POST", "/v1/projects/p1/make")).toEqual({ format: "flashcards", about: "one-sided limits", sources: ["s1"], settings: {} }));
  // Made, the right column is back on Make and Made here, with the thing being made in the one progress look.
  const back = await screen.findByRole("region", { name: STUDIO });
  const row = await within(back).findByRole("group", { name: "Quiz d2" });
  expect(row).toHaveTextContent("Making · Writing question 2 of 5");
  expect(within(row).getByRole("progressbar")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Make a set of flashcards" })).not.toBeInTheDocument();
});

test("the make sheet says quietly what the maker says about the thing before it is made, and never blocks it", async () => {
  const NOTE = "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.";
  renderApp("/projects/p1", {
    ...routes(planView()),
    "GET /v1/projects/:id/plans": { plans: [] },
    "POST /v1/projects/:id/make/settle": { settings: { cards: 20 }, plannedAs: "flashcards · 20", issues: [], notices: [NOTE] },
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(within(studio).getByRole("group", { name: "Make" })).findByRole("button", { name: "flashcards" }));
  const form = await screen.findByRole("region", { name: "Make a set of flashcards" });
  expect(await within(form).findByText(NOTE)).toBeInTheDocument();
  expect(within(form).queryByText("It can't be made here now:")).not.toBeInTheDocument();
  await userEvent.type(within(form).getByLabelText("What it covers"), "x");
  expect(screen.getByRole("button", { name: "Make the flashcards" })).toBeEnabled();
  // Back goes to Make and Made here, asking first since something was typed.
  await userEvent.click(screen.getByRole("button", { name: "Back to Made here" }));
  await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard what you filled in?" })).getByRole("button", { name: "Discard" }));
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

test("a new shape gets its tile and make sheet from the registry alone, and one that cannot be made here says why on its tile", async () => {
  const audio = { id: "audio", label: "audio", plural: "audio walk-throughs", singular: "audio walk-through", colorSlot: 4, icon: "listen", blurb: "a spoken walk-through to listen to, with no picture", settings: [{ key: "minutes", label: "Length", kind: "number", min: 0, max: 60, step: 1, unit: "min" }], defaults: { minutes: 0 } };
  const problem = "Audio needs a voice, and this computer has none set up: pick one in Settings, under Voice.";
  const blocked = renderApp("/projects/p1", { ...routes(planView()), "GET /v1/formats": { formats: [...formats, { ...audio, ready: false, problem }] } });
  let tiles = within(await screen.findByRole("region", { name: STUDIO })).getByRole("group", { name: "Make" });
  const tile = await within(tiles).findByRole("button", { name: "audio" });
  expect(tile).toBeDisabled();
  expect(tile).toHaveAttribute("title", problem);
  blocked.unmount();
  cleanup();
  renderApp("/projects/p1", {
    ...routes(planView()),
    "GET /v1/formats": { formats: [...formats, { ...audio, ready: true }] },
    "POST /v1/projects/:id/make/settle": { settings: { minutes: 6 }, plannedAs: "Your agent · about 6 min", issues: [] },
  });
  tiles = within(await screen.findByRole("region", { name: STUDIO })).getByRole("group", { name: "Make" });
  await userEvent.click(await within(tiles).findByRole("button", { name: "audio" }));
  const sheet = await screen.findByRole("region", { name: "Make an audio walk-through" });
  expect(within(sheet).getByRole("group", { name: "Length" })).toHaveTextContent("0 min");
  expect(screen.getByRole("button", { name: "Make the audio" })).toBeEnabled();
});

test("Plan a whole subject asks what to get through in its sheet and writes the plan in the chat", async () => {
  const { calls } = renderApp("/projects/p1", {
    ...routes(planView()),
    "POST /v1/projects/:id/chats": [201, { chat }],
    "POST /v1/chats/:id/messages": { chat: { ...chat, messageCount: 1 }, messages: [message(0, "user", "/plan my exam on the 12th")] },
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(within(studio).getByRole("button", { name: /^Plan a whole subject/ }));
  const sheet = await screen.findByRole("region", { name: "Plan a whole subject" });
  await userEvent.type(within(sheet).getByLabelText("What do you want to get through?"), "my exam on the 12th");
  await userEvent.click(within(sheet).getByRole("button", { name: "Write the plan" }));
  await screen.findAllByText("my exam on the 12th");
  expect((body(calls, "POST", "/v1/chats/c1/messages") as { text: string }).text).toBe("/plan my exam on the 12th");
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

test("Made here lists every made thing in the feed's order, a plan as one row with Open, and the player goes through them all", async () => {
  const older = planView({ status: "running", kickedOffAt: "2026-11-10T08:00:00.000Z" }, [item("a", 1, 0, { status: "done", outputId: "o1", title: "Plan item" })]);
  const newer = directView("d3", { status: "done", outputId: "o2", job: undefined }, { kickedOffAt: "2026-11-11T08:00:00.000Z", status: "done" });
  const output = (id: string, title: string) => ({ id, type: "byte", title, projectId: "p1", payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: `Inside ${title}` }], cites: [] }] }, citations: [], createdAt: now, updatedAt: now });
  renderApp("/projects/p1", {
    ...routes(older),
    "GET /v1/projects/:id/plans": { plans: [{ ...older.plan, counts: older.counts }, { ...newer.plan, counts: newer.counts }] },
    "GET /v1/plans/:id": ({ params }: { params: Record<string, string> }) => (params.id === "d3" ? newer : older),
    "GET /v1/outputs/:id": ({ params }: { params: Record<string, string> }) => ({ output: output(params.id!, params.id === "o2" ? "Quiz d3" : "Plan item") }),
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  const list = await within(studio).findByRole("list", { name: "Made here" });
  await within(list).findByRole("group", { name: "Quiz d3" });
  // Newest first, every type in one list: the thing made at once, then the plan.
  const rows = within(list).getAllByRole("listitem").map((li) => li.textContent ?? "");
  expect(rows[0]).toContain("Quiz d3");
  expect(rows[1]).toContain("Plan: Unit 1");
  expect(within(list).getByRole("group", { name: "Plan: Unit 1" })).toHaveTextContent("Making · 1 of 1 made");
  await userEvent.click(within(list).getByRole("button", { name: "Play Quiz d3" }));
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  expect(within(playing).getByRole("heading", { name: "Quiz d3" })).toBeInTheDocument();
  // ↓ goes on, ↑ goes back.
  await userEvent.keyboard("{ArrowDown}");
  expect(await within(playing).findByRole("heading", { name: "Plan item" })).toBeInTheDocument();
  await userEvent.keyboard("{ArrowUp}");
  expect(await within(playing).findByRole("heading", { name: "Quiz d3" })).toBeInTheDocument();
});

test("a thing to read says Open and a thing to go through says Play, both outlined; a plan with no plan panel opens its card in the chat", async () => {
  const guide = { id: "guide", label: "guide", colorSlot: 5, icon: "book", settings: [], defaults: {}, ready: true };
  const notes = directView("d4", { type: "guide", title: "Week 3 notes", status: "done", outputId: "o4", job: undefined }, { status: "done", kickedOffAt: "2026-11-11T08:00:00.000Z" });
  const plan = planView({ status: "cancelled", kickedOffAt: "2026-11-10T08:00:00.000Z" }, [item("a", 1, 0, { status: "done", outputId: "o1" }), item("b", 1, 1, { status: "cancelled" })]);
  renderApp("/projects/p1", {
    ...routes(plan),
    "GET /v1/formats": { formats: [...formats, guide] },
    "GET /v1/projects/:id/plans": { plans: [{ ...plan.plan, counts: plan.counts }, { ...notes.plan, counts: notes.counts }] },
    "GET /v1/plans/:id": ({ params }: { params: Record<string, string> }) => (params.id === "d4" ? notes : plan),
  });
  const studio = await screen.findByRole("region", { name: STUDIO });
  const open = await within(studio).findByRole("button", { name: "Open Week 3 notes" });
  expect(open).toHaveTextContent("Open");
  expect(open).toHaveClass("obtn");
  const row = within(studio).getByRole("group", { name: "Plan: Unit 1" });
  expect(row).toHaveTextContent("Stopped · 1 of 2 made");
  expect(within(row).getByRole("button", { name: "Open Unit 1" })).toHaveClass("obtn");
  await userEvent.click(within(row).getByRole("button", { name: "Open Unit 1" }));
  expect(await cardOf()).toBeInTheDocument();
});

// ── The chat opens the make sheet, the plan and the sources it reads ─────────

test("a reply that proposes a thing opens its make sheet on the right, filled in, and makes nothing", async () => {
  const shown: unknown[] = [];
  const unplug = registerRightView("make", (view) => {
    shown.push(view);
    return <section aria-label="The make sheet">{view.shape}</section>;
  });
  const proposal = { kind: "make", format: "quiz", title: "Limits check", about: "One-sided limits.", sources: ["s1"], settings: { questions: 5 }, plannedAs: "5 questions", notices: [], issues: [], state: "open" };
  const reply = () => message(1, "assistant", "I filled in a quiz. Check it on the right, then press Make.", { pieces: [say("I filled in a quiz. Check it on the right, then press Make."), proposal] });
  const { calls } = renderApp("/projects/p1", {
    ...routes(planView()),
    "POST /v1/projects/:id/chats": [201, { chat }],
    "GET /v1/chats/:id": () => ({ chat: { ...chat, messageCount: 2 }, messages: [message(0, "user", "make me a quiz on limits"), reply()] }),
    "POST /v1/chats/:id/messages": () => ({ chat: { ...chat, messageCount: 2 }, messages: [message(0, "user", "make me a quiz on limits"), reply()], plans: [] }),
  });
  try {
    await userEvent.type(await screen.findByLabelText("Message"), "make me a quiz on limits{Enter}");
    expect(await screen.findByRole("region", { name: "The make sheet" })).toHaveTextContent("quiz");
    // Filled in from the proposal, with where it sits so the sheet can mark it made or closed.
    expect(shown.at(-1)).toEqual({ kind: "make", shape: "quiz", prefill: { title: "Limits check", about: "One-sided limits.", sources: ["s1"], settings: { questions: 5 }, notices: [], issues: [], chatId: "c1", messageId: "m1", piece: 1 } });
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/make"))).toBe(false);
    // The chat keeps the short reply and a row that opens the sheet again.
    const row = screen.getByRole("group", { name: "Limits check, its make sheet" });
    expect(row).toHaveTextContent("not made yet");
    expect(within(row).getByRole("button", { name: "Open its sheet" })).toBeInTheDocument();
  } finally {
    unplug();
  }
});

test("a proposal already made or closed never opens the sheet by itself; made, it is the thing's card with Play", async () => {
  const made = directView("d9", { status: "done", outputId: "o9", title: "Limits check", job: undefined }, { status: "done" });
  const piece = (state: string, extra = {}) => ({ kind: "make", format: "quiz", title: "Limits check", about: "", sources: ["s1"], settings: {}, plannedAs: "", notices: [], issues: [], state, ...extra });
  renderApp("/projects/p1?chat=c1", {
    ...routes(made),
    "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 3 }] },
    "GET /v1/chats/:id": { chat: { ...chat, messageCount: 3 }, messages: [message(0, "user", "a quiz"), message(1, "assistant", "Filled in.", { pieces: [say("Filled in."), piece("made", { planId: "d9" })] }), message(2, "assistant", "Another.", { pieces: [say("Another."), { ...piece("closed"), title: "Spare" }] })] },
  });
  const chatPanel = await screen.findByRole("region", { name: "Chat" });
  const row = await within(chatPanel).findByRole("group", { name: "Limits check" });
  expect(within(row).getByRole("button", { name: "Play Limits check" })).toHaveClass("obtn");
  expect(within(chatPanel).getByText("Spare")).toBeInTheDocument();
  expect(within(chatPanel).getByText("· not made")).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: /^Make a/ })).not.toBeInTheDocument();
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

test("the sources chip says what the chat reads and changes it with the Sources panel's ticks", async () => {
  const second = { ...source, id: "s2", title: "Week 4" };
  renderApp("/projects/p1", routes(planView(), { "GET /v1/projects/:id/sources": { sources: [source, second] } }));
  await userEvent.click(await screen.findByRole("button", { name: "This chat reads 2 sources. Change" }));
  const pop = screen.getByRole("dialog", { name: "This chat reads" });
  expect(pop).toHaveTextContent("Same ticks as the Sources panel. What you make from this chat reads these too.");
  await userEvent.click(within(pop).getByRole("checkbox", { name: "Read Week 4 in this chat" }));
  const panel = screen.getByRole("region", { name: "Sources" });
  expect(within(panel).getByText("1 of 2 used")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "This chat reads 1 of 2 sources. Change" })).toBeInTheDocument();
  await userEvent.click(within(pop).getByRole("button", { name: "Use all 2" }));
  expect(within(panel).getByText("2 of 2 used")).toBeInTheDocument();
  // Add sources opens the one adder.
  await userEvent.click(within(pop).getByRole("button", { name: "Add sources" }));
  expect(await screen.findByRole("dialog", { name: "Add sources to Calculus I" })).toBeInTheDocument();
});

test("a project address with ?plan= opens that plan on the right when a plan view is plugged in, with the chat's compact card beside it", async () => {
  const unplug = registerRightView("plan", (view) => <section aria-label="The plan panel">{view.planId}</section>);
  try {
    renderApp("/projects/p1?chat=c1&plan=pl1", routes(planView({ chatId: "c1" }), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "/plan"), message(1, "assistant", "Here is a plan.", { pieces: [say("Here is a plan."), { kind: "plan", planId: "pl1", action: "created" }] })] },
    }));
    expect(await screen.findByRole("region", { name: "The plan panel" })).toHaveTextContent("pl1");
    const card = await within(await screen.findByRole("region", { name: "Chat" })).findByRole("group", { name: "Plan: Unit 1" });
    expect(card).toHaveTextContent("3 items · Not started");
  } finally {
    unplug();
  }
});

test("with a plan view plugged in, a plan in the chat is a compact card that opens it on the right", async () => {
  const unplug = registerRightView("plan", (view) => <section aria-label="The plan panel">{view.planId}</section>);
  try {
    renderApp("/projects/p1?chat=c1", routes(planView({ chatId: "c1" }), {
      "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 2 }] },
      "GET /v1/chats/:id": { chat, messages: [message(0, "user", "/plan"), message(1, "assistant", "Here is a plan.", { pieces: [say("Here is a plan."), { kind: "plan", planId: "pl1", action: "created" }] })] },
    }));
    const card = await within(await screen.findByRole("region", { name: "Chat" })).findByRole("group", { name: "Plan: Unit 1" });
    expect(card).toHaveTextContent("3 items · Not started");
    expect(screen.queryByRole("article", { name: "Plan: Unit 1" })).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("region", { name: "The plan panel" })).toHaveTextContent("pl1");
  } finally {
    unplug();
  }
});

function planSent(more: Record<string, unknown> = {}, view: () => PlanView = () => planView({ chatId: "c1" })) {
  return routes(view, {
    "GET /v1/projects/:id/chats": { chats: [{ ...chat, messageCount: 0 }] },
    "GET /v1/chats/:id": { chat, messages: [] },
    "POST /v1/chats/:id/messages": {
      chat: { ...chat, messageCount: 2 },
      messages: [message(0, "user", "/plan Revision"), message(1, "assistant", "Here is a plan.", { pieces: [say("Here is a plan."), { kind: "plan", planId: "pl1", action: "created" }] })],
    },
    ...more,
  });
}

test("a plan just written in the open chat opens on the right when nothing else is open there", async () => {
  const unplug = registerRightView("plan", (view) => <section aria-label="The plan panel">{view.planId}</section>);
  try {
    renderApp("/projects/p1?chat=c1", planSent());
    await userEvent.type(await screen.findByLabelText("Message"), "/plan Revision{Enter}");
    expect(await screen.findByRole("region", { name: "The plan panel" })).toHaveTextContent("pl1");
  } finally {
    unplug();
  }
});

test("a plan written while a player is open stays a card in the chat and a row in Made here: the player stays", async () => {
  const unplug = registerRightView("plan", (view) => <section aria-label="The plan panel">{view.planId}</section>);
  const current = { ...planView({ status: "done", kickedOffAt: now, chatId: "c1" }, [item("a", 1, 0, { status: "done", outputId: "o1", title: "Limits, one screen at a time" })]), counts: { total: 1, done: 0 } };
  const byte = { id: "o1", type: "byte", title: "Limits, one screen at a time", projectId: "p1", planId: "pl1", itemId: "a", payload: { schemaVersion: 2, bits: [{ id: "b1", kind: "plain", blocks: [{ type: "text", text: "A limit is where a function heads." }], cites: [] }] }, citations: [], createdAt: now, updatedAt: now };
  try {
    renderApp("/projects/p1?chat=c1&play=o1", planSent({ "GET /v1/outputs/:id": { output: byte } }, () => current));
    expect(await screen.findByRole("complementary", { name: "Playing" })).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText("Message"), "/plan Revision{Enter}");
    expect(await within(screen.getByRole("region", { name: "Chat" })).findByRole("group", { name: "Plan: Unit 1" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Playing" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "The plan panel" })).not.toBeInTheDocument();
  } finally {
    unplug();
  }
});

test("a made thing's row in Made here says its size and a done tick from the engine, and nothing it was not sent", async () => {
  const made = directView("d1", { status: "done", outputId: "o1", title: "Limits, 12 cards", type: "flashcards", madeAs: ["12 cards"], job: undefined }, { status: "done" });
  renderApp("/projects/p1", routes(made, { "GET /v1/projects/:id/outputs": { outputs: sampleOutputs } }));
  const studio = await screen.findByRole("region", { name: STUDIO });
  const row = await within(studio).findByRole("group", { name: "Limits, 12 cards" });
  await waitFor(() => expect(row).toHaveTextContent("12 cards"));
  expect(row).toHaveTextContent("done");
});

test("a made thing with no size from the engine shows its format and nothing else", async () => {
  const made = directView("d1", { status: "done", outputId: "o3", title: "Not rendered yet", type: "flashcards", madeAs: ["99 cards"], job: undefined }, { status: "done" });
  renderApp("/projects/p1", routes(made, { "GET /v1/projects/:id/outputs": { outputs: sampleOutputs } }));
  const studio = await screen.findByRole("region", { name: STUDIO });
  const row = await within(studio).findByRole("group", { name: "Not rendered yet" });
  expect(row).not.toHaveTextContent("99 cards");
  expect(row).not.toHaveTextContent("done");
});

test("a source row says how long it is when the engine knows, and its kind alone when it does not", async () => {
  renderApp("/projects/p1", routes(planView(), { "GET /v1/projects/:id/sources": { sources: sampleSources } }));
  const panel = await screen.findByRole("region", { name: "Sources" });
  expect(await within(panel).findByText("PDF · 24 pages")).toBeInTheDocument();
  expect(within(panel).getByText("link")).toBeInTheDocument();
});

// ── Deleting from Made here ──────────────────────────────────────────────────

/** A project whose Made here lists these views; DELETE takes one out of the engine's list, or answers `refuse`. */
function deletable(views: PlanView[], refuse?: [number, unknown]) {
  let list = [...views];
  const byId = (id: string) => list.find((v) => v.plan.id === id);
  return {
    ...routes(views[0]!),
    "GET /v1/projects/:id/plans": () => ({ plans: list.map((v) => ({ ...v.plan, counts: v.counts })) }),
    "GET /v1/plans/:id": ({ params }: { params: Record<string, string> }) => byId(params.id!) ?? [404, { error: "not_found", message: "Plan not found" }],
    "POST /v1/plans/:id/cancel": ({ params }: { params: Record<string, string> }) => {
      const v = byId(params.id!)!;
      const stopped = { ...v, plan: { ...v.plan, status: "cancelled" as const } };
      list = list.map((x) => (x.plan.id === v.plan.id ? stopped : x));
      return stopped;
    },
    "DELETE /v1/plans/:id": ({ params }: { params: Record<string, string> }) => {
      if (refuse) return refuse;
      const v = byId(params.id!);
      if (!v) return [404, { error: "not_found", message: "Plan not found" }];
      list = list.filter((x) => x !== v);
      return { planId: v.plan.id, deleted: { items: v.items.length, outputs: v.items.filter((i) => i.outputId).length, jobs: 1, files: 0 } };
    },
  };
}
const deleted = (calls: FakeRequest[]) => calls.filter((c) => c.method === "DELETE").map((c) => c.path);
const madeTab = () => within(screen.getByRole("tablist", { name: "Panels" })).getByRole("tab", { name: /^Made/ });

test("a made thing is deleted from its ⋯ after saying what goes, and the list and the Made tab follow", async () => {
  const made = directView("d1", { status: "done", outputId: "o1", title: "Limits check", job: undefined }, { status: "done" });
  const other = directView("d2", { status: "done", outputId: "o2", title: "Kept quiz", job: undefined }, { status: "done", kickedOffAt: "2026-11-11T08:00:00.000Z" });
  const { calls } = renderApp("/projects/p1", deletable([made, other]));
  const list = await within(await screen.findByRole("region", { name: STUDIO })).findByRole("list", { name: "Made here" });
  const row = await within(list).findByRole("group", { name: "Limits check" });
  expect(madeTab()).toHaveTextContent("Made · 2");
  await userEvent.click(within(row.parentElement!).getByRole("button", { name: "More for Limits check" }));
  const menu = screen.getByRole("menu", { name: "More for Limits check" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Delete…"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete “Limits check” for good?" });
  expect(ask).toHaveTextContent("This quiz goes for good: it leaves Made here and the Library. This can't be undone.");
  // Cancel keeps it.
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(deleted(calls)).toEqual([]);
  await userEvent.click(within(row.parentElement!).getByRole("button", { name: "More for Limits check" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(within(list).queryByRole("group", { name: "Limits check" })).not.toBeInTheDocument());
  expect(deleted(calls)).toEqual(["/v1/plans/d1"]);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(within(list).getByRole("group", { name: "Kept quiz" })).toBeInTheDocument();
  expect(madeTab()).toHaveTextContent("Made · 1");
});

test("a failed or stopped thing that made nothing goes at once, and two or more clear together from the foot of the list", async () => {
  const failed = directView("d1", { status: "failed", title: "Broken quiz", errorMessage: "No maker answered", job: undefined }, { status: "failed" });
  const stopped = directView("d2", { status: "cancelled", title: "Stopped quiz", job: undefined }, { status: "cancelled", kickedOffAt: "2026-11-11T08:00:00.000Z" });
  const third = directView("d3", { status: "cancelled", title: "Another stopped", job: undefined }, { status: "cancelled", kickedOffAt: "2026-11-11T09:00:00.000Z" });
  const made = directView("d4", { status: "done", outputId: "o4", title: "Kept quiz", job: undefined }, { status: "done" });
  const { calls } = renderApp("/projects/p1", deletable([failed, stopped, third, made]));
  const studio = await screen.findByRole("region", { name: STUDIO });
  const list = await within(studio).findByRole("list", { name: "Made here" });
  await within(list).findByRole("group", { name: "Broken quiz" });
  // One at once: no question.
  await userEvent.click(within(list).getByRole("button", { name: "More for Broken quiz" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  await waitFor(() => expect(within(list).queryByRole("group", { name: "Broken quiz" })).not.toBeInTheDocument());
  // The two stopped ones clear together; the made thing stays.
  await userEvent.click(within(studio).getByRole("button", { name: "Clear failed and stopped" }));
  await waitFor(() => expect(within(list).queryByRole("group", { name: "Stopped quiz" })).not.toBeInTheDocument());
  expect(within(list).queryByRole("group", { name: "Another stopped" })).not.toBeInTheDocument();
  expect([...deleted(calls)].sort()).toEqual(["/v1/plans/d1", "/v1/plans/d2", "/v1/plans/d3"]);
  expect(within(list).getByRole("group", { name: "Kept quiz" })).toBeInTheDocument();
  expect(within(studio).queryByRole("button", { name: "Clear failed and stopped" })).not.toBeInTheDocument();
  expect(madeTab()).toHaveTextContent("Made · 1");
});

test("with only one failed or stopped thing there is nothing to clear together", async () => {
  const stopped = directView("d2", { status: "cancelled", title: "Stopped quiz", job: undefined }, { status: "cancelled" });
  renderApp("/projects/p1", deletable([stopped]));
  const studio = await screen.findByRole("region", { name: STUDIO });
  await within(studio).findByRole("group", { name: "Stopped quiz" });
  expect(within(studio).queryByRole("button", { name: "Clear failed and stopped" })).not.toBeInTheDocument();
});

test("a thing being made is stopped from its ⋯ first, and only then can be deleted", async () => {
  const thing = directView("d1");
  const { calls } = renderApp("/projects/p1", deletable([thing]));
  const list = await within(await screen.findByRole("region", { name: STUDIO })).findByRole("list", { name: "Made here" });
  await within(list).findByRole("group", { name: "Quiz d1" });
  await userEvent.click(within(list).getByRole("button", { name: "More for Quiz d1" }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: /^Delete…/ })).toBeDisabled();
  expect(within(menu).getByRole("menuitem", { name: /^Delete…/ })).toHaveTextContent("stop it first");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));
  expect(await within(list).findByText(/Stopped/)).toBeInTheDocument();
  await userEvent.click(within(list).getByRole("button", { name: "More for Quiz d1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(within(list).queryByRole("group", { name: "Quiz d1" })).not.toBeInTheDocument());
  expect(deleted(calls)).toEqual(["/v1/plans/d1"]);
});

test("a plan is deleted from its ⋯ once it is stopped, after saying its items and what was made from it go", async () => {
  const running = planView({ status: "running", kickedOffAt: "2026-11-10T08:00:00.000Z" }, [item("a", 1, 0, { status: "done", outputId: "o1" }), item("b", 1, 1, { status: "queued" }), item("c", 1, 2, { status: "pending" })]);
  const { calls } = renderApp("/projects/p1", deletable([running]));
  const list = await within(await screen.findByRole("region", { name: STUDIO })).findByRole("list", { name: "Made here" });
  const row = await within(list).findByRole("group", { name: "Plan: Unit 1" });
  await userEvent.click(within(row).getByRole("button", { name: "More for plan Unit 1" }));
  expect(screen.getByRole("menuitem", { name: /^Delete…/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
  await waitFor(() => expect(row).toHaveTextContent("Stopped"));
  await userEvent.click(within(row).getByRole("button", { name: "More for plan Unit 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete the plan “Unit 1” for good?" });
  expect(ask).toHaveTextContent("Its 3 items and the 1 thing made from it go for good: they leave Made here and the Library. This can't be undone.");
  await userEvent.click(within(ask).getByRole("button", { name: "Delete plan" }));
  await waitFor(() => expect(within(list).queryByRole("group", { name: "Plan: Unit 1" })).not.toBeInTheDocument());
  expect(deleted(calls)).toEqual(["/v1/plans/pl1"]);
  expect(await screen.findByText("Nothing yet. What you make shows up here, and plays here.")).toBeInTheDocument();
});

test("a delete the engine refuses because it is still being made says to stop it first, and keeps the row", async () => {
  const plan = planView({ status: "done", kickedOffAt: "2026-11-10T08:00:00.000Z" }, [item("a", 1, 0, { status: "done", outputId: "o1" })]);
  renderApp("/projects/p1", deletable([plan], [409, { error: "plan_running", message: "This is still being made; stop it first" }]));
  const list = await within(await screen.findByRole("region", { name: STUDIO })).findByRole("list", { name: "Made here" });
  const row = await within(list).findByRole("group", { name: "Plan: Unit 1" });
  await userEvent.click(within(row).getByRole("button", { name: "More for plan Unit 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete plan" }));
  expect(await within(screen.getByRole("alertdialog")).findByText("It is still being made. Stop it first, then delete it.")).toBeInTheDocument();
  expect(within(list).getByRole("group", { name: "Plan: Unit 1" })).toBeInTheDocument();
});

test("the project menu deletes the project after the same question the Home card asks, then goes Home", async () => {
  const { calls } = renderApp(
    "/projects/p1",
    routes(planView(), {
      "GET /v1/projects/:id": ({ query }: FakeRequest) => ({ project, ...(query.get("counts") === "1" ? { counts: { chats: 2, plans: 1, outputs: 5, sources: 3 } } : {}) }),
      "DELETE /v1/projects/:id": { projectId: "p1", deleted: { chats: 2, plans: 1, outputs: 5, sources: 3 } },
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Project menu" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete Calculus I?" });
  expect(await within(ask).findByText(/Its 3 sources, 5 made things, 2 chats, and 1 plan go for good\./)).toBeInTheDocument();
  expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Archive instead", "Delete"]);
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Project menu" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
  await userEvent.click(await within(screen.getByRole("alertdialog")).findByRole("button", { name: "Delete" }));
  expect(await screen.findByText(/Deleted “Calculus I” with 3 sources/)).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
});

test("Download the file is the label for an uploaded source the engine sends as a download", async () => {
  renderApp("/projects/p1?source=s1", routes(planView(), { "GET /v1/sources/:id": { source: { ...source, kind: "text", uploadId: "u1" }, extraction: { contentHash: "h", kind: "text", status: "ready", text: "A limit describes…", createdAt: now, updatedAt: now }, chunkCount: 1 } }));
  const reader = await screen.findByRole("region", { name: "Source" });
  expect(await within(reader).findByRole("link", { name: "Download the file" })).toHaveAttribute("href", "/api/v1/sources/s1/file");
  expect(within(reader).queryByRole("link", { name: "Open the file" })).not.toBeInTheDocument();
});
