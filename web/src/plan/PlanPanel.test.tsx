import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormatDescriptor, Item, PlanStatus, PlanView, Stage } from "../api/types";
import { formats as baseFormats, itemStopRoutes, sampleMakeTimes, sampleProviders, sampleVideoFormat, type FakeRequest } from "../test/fakeEngine";
import { renderWithEngine } from "../test/renderWithEngine";
import { localDay } from "./days";
import { PlanNew } from "./PlanNew";
import { PlanPanel } from "./PlanPanel";
import { itemMaker, phaseOf, planTimeWords, watchMinutes } from "./panelModel";

const formats = [sampleVideoFormat, ...baseFormats.filter((f) => f.id !== "video")] as FormatDescriptor[];

function item(id: string, level: number, type: string, extra: Partial<Item> = {}): Item {
  return { id, level, ord: 0, type, title: `Item ${id}`, settings: {}, enabled: true, status: "pending", sources: [{ sourceId: "s1" }], done: false, ...extra };
}

function view(status: PlanStatus, items: Item[], stages: Stage[] = []): PlanView {
  return {
    plan: { id: "p1", projectId: "pr1", title: "the whole cell cycle", status, version: 1, createdAt: "", updatedAt: "", ...(status === "draft" || status === "approved" ? {} : { kickedOffAt: "2026-11-12T09:00:00.000Z" }) },
    stages,
    items,
    edges: [],
    counts: { total: items.length, done: items.filter((i) => i.done).length },
    estimateUsd: 0,
    issues: [],
  };
}

const sources = { sources: [{ id: "s1", kind: "pdf", title: "Chapter 12", status: "ready" }, { id: "s2", kind: "note", title: "Lab notes", status: "ready" }] };

function show(v: PlanView, routes: Record<string, unknown> = {}) {
  const changes: PlanView[] = [];
  const played: string[] = [];
  const closed = vi.fn();
  const engine = renderWithEngine(<PlanPanel planId="p1" projectId="pr1" onClose={closed} onPlanChange={(x) => changes.push(x)} onPlay={(id) => played.push(id)} />, {
    "GET /v1/plans/:id": v,
    "GET /v1/projects/:id/sources": sources,
    ...routes,
  });
  return { ...engine, changes, played, closed };
}

/** A 3 minute video has a past run (about 4 min); a 10 minute one has none. */
const draftItems = () => [
  item("a", 1, "video", { title: "One cell becomes two", settings: { minutes: 3 } }),
  item("b", 1, "video", { title: "Why a cell checks itself", ord: 1, settings: { minutes: 3 } }),
  item("c", 2, "quiz", { title: "Practice exam" }),
  item("d", 3, "flashcards", { title: "Fix what you missed", parentId: "c", condition: { kind: "metric", metric: "score", below: 0.7 } }),
];

describe("a plan before Start", () => {
  it("with several agents ready and none picked, Start asks who makes the open items and starts with that pick", async () => {
    let starts = 0;
    const { calls } = show(view("draft", draftItems()), {
      "GET /v1/providers": { ...sampleProviders, picks: {} },
      "POST /v1/plans/:id/approve": view("approved", draftItems()),
      "POST /v1/plans/:id/start": () => (++starts === 1 ? [409, { error: "pick_needed", message: "Pick who makes it in Settings, What makes what." }] : view("running", draftItems())),
      "POST /v1/plans/:id/maker": { ...view("draft", draftItems()), changed: ["a", "b"], unchanged: [] },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^Start/ }));
    const picker = await screen.findByRole("dialog", { name: "Made by, for videos" });
    expect(within(picker).getByText("Pick who makes this")).toBeInTheDocument();
    expect(screen.queryByText(/What makes what/)).not.toBeInTheDocument();
    await userEvent.click(within(picker).getByRole("option", { name: /A One/ }));
    await userEvent.click(within(picker).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(starts).toBe(2));
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/plans/p1/maker")?.body).toEqual({ agent: "agent:alpha:a-one", effort: null, items: ["a", "b"] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ticks each item, says who makes it and how long, and Start adds up the times from past runs", async () => {
    show(view("draft", draftItems(), [{ level: 1, label: "The big picture" }]));
    expect(await screen.findByRole("heading", { name: "Plan: the whole cell cycle" })).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByText("1 · The big picture")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Make One cell becomes two" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getAllByText(/video · Z Mid · medium · about 4 min/)).toHaveLength(2));
    // Two videos of about 4 min each; the quiz and flashcards are made without an agent, so they add nothing.
    expect(screen.getByRole("button", { name: /^Start · about 8 min$/ })).toBeInTheDocument();
    expect(screen.getByText(/videos Z Mid · medium, no review/)).toBeInTheDocument();
    expect(screen.getByText("Made by your defaults:")).toBeInTheDocument();
  });

  it("names who makes an item by its model and effort, as the make sheet does, never by the maker's own word", async () => {
    const items = draftItems();
    items[0] = { ...items[0]!, plannedAs: ["Your agent", "3 min"] };
    show(view("draft", items));
    const row = (await screen.findByText("One cell becomes two")).closest(".plp-it") as HTMLElement;
    await waitFor(() => expect(row).toHaveTextContent("video · 3 min · Z Mid · medium · about 4 min"));
    expect(row).not.toHaveTextContent("Your agent");
  });

  it("a made item says what it is without the maker's word", async () => {
    show(view("cancelled", [item("a", 1, "video", { title: "One cell becomes two", status: "done", outputId: "o1", settings: { minutes: 3 }, madeAs: ["Your agent", "3 min"] })]));
    const row = (await screen.findByText("One cell becomes two")).closest(".plp-it") as HTMLElement;
    expect(row).toHaveTextContent("video · 3 min");
    expect(row).not.toHaveTextContent("Your agent");
  });

  it("says just Start, and no time yet, when any ticked item has no past run", async () => {
    const items = draftItems();
    items[1] = { ...items[1]!, settings: { minutes: 10 } };
    show(view("draft", items));
    await waitFor(() => expect(screen.getByText(/Why a cell checks itself/).closest(".plp-it")).toHaveTextContent("no time yet"));
    const start = screen.getByRole("button", { name: "Start" });
    // The note sits beside Start, on its line.
    expect(start.parentElement).toHaveTextContent("Startno time yet");
    expect(screen.getByText("no time yet", { selector: ".plp-notime" })).toHaveAttribute("title", "Some of it has not been made here with these picks.");
  });

  it("draws a branch indented under the item its condition is about, with the condition on its line", async () => {
    show(view("draft", draftItems()));
    const branch = (await screen.findByText("Fix what you missed")).closest("[data-testid=item]") as HTMLElement;
    expect(branch).toHaveAttribute("data-depth", "1");
    expect(branch.style.marginLeft).toBe("28px");
    expect(branch).toHaveTextContent("If you score under 70% on “Practice exam”");
  });

  it("unticking leaves an item out", async () => {
    const { calls } = show(view("draft", draftItems()), { "PATCH /v1/plans/:id/items/:itemId": (r: FakeRequest) => view("draft", draftItems().map((i) => (i.id === r.params.itemId ? { ...i, ...(r.body as object) } : i))) });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Make Practice exam" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
    expect(await screen.findByRole("checkbox", { name: "Make Practice exam" })).toHaveAttribute("aria-checked", "false");
  });

  it("opening an item shows the make sheet's own settings and Made by box, and Save sends only what changed", async () => {
    const { calls } = show(view("draft", draftItems()), { "PATCH /v1/plans/:id/items/:itemId": view("draft", draftItems()) });
    await userEvent.click(await screen.findByRole("button", { name: "Change One cell becomes two" }));
    const form = screen.getByRole("form", { name: "Change One cell becomes two" });
    expect(within(form).getByLabelText("Title")).toHaveValue("One cell becomes two");
    expect(within(form).getByText("Made by")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: /Zeta Agent/ })).toBeInTheDocument();
    expect(within(form).getByRole("group", { name: "Length, min" })).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "More" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ settings: { minutes: 4 } }));
  });

  it("Change for all picks one maker and sends it for every item", async () => {
    const { calls } = show(view("draft", draftItems()), { "POST /v1/plans/:id/maker": { ...view("draft", draftItems()), changed: ["a", "b"], unchanged: [{ itemId: "c", why: "Made without your agent" }] } });
    await userEvent.click(await screen.findByRole("button", { name: "Change for all" }));
    const dialog = await screen.findByRole("dialog", { name: "Made by, for every item in this plan" });
    await userEvent.click(within(dialog).getByRole("option", { name: /Z Big/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/v1/plans/p1/maker")?.body).toEqual({ agent: "agent:zeta:z-big", effort: "medium" }));
    expect(await screen.findByText("1 left as it was: Made without your agent.")).toBeInTheDocument();
  });
});

describe("a plan that runs", () => {
  const running = () => [
    item("a", 1, "video", { title: "One cell becomes two", status: "done", outputId: "o1", settings: { minutes: 3 } }),
    item("b", 2, "video", { title: "Why a cell checks itself", status: "running", settings: { minutes: 3 }, job: { id: "j", status: "running", stage: "writing", progress: 0.4, step: "drawing scene 3 of 7", attempt: 1 } }),
    item("c", 3, "quiz", { title: "Practice exam", status: "failed", errorMessage: "your agent stopped answering" }),
    item("d", 3, "video", { title: "One page to keep", ord: 1, settings: { minutes: 3 } }),
    item("e", 3, "flashcards", { title: "Flashcards to keep", ord: 2, status: "queued" }),
  ];

  it("has one progress line per item in the shared look, Play on what is made, a Stop on each item the engine is making, none on one not started, and one Stop all", async () => {
    const { calls, played } = show(view("running", running()), { "POST /v1/plans/:id/cancel": view("cancelled", running()) });
    expect(await screen.findByText("Making", { selector: ".plp-top .making-st" })).toBeInTheDocument();
    expect(screen.getByText("1 of 5 made")).toBeInTheDocument();
    const live = screen.getByText("Why a cell checks itself").closest(".making") as HTMLElement;
    expect(live).toHaveClass("making", "row");
    expect(live).toHaveTextContent("Making · drawing scene 3 of 7");
    expect(within(live).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    const failed = screen.getByText("Practice exam").closest(".making") as HTMLElement;
    expect(failed).toHaveClass("failed");
    expect(failed).toHaveTextContent("Couldn't be made: your agent stopped answering");
    expect(within(failed).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("One page to keep").closest(".making")).toHaveClass("waiting");
    expect(screen.getAllByRole("button", { name: "Stop all" })).toHaveLength(1);
    expect(within(live).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    // Not started yet: the engine stops only an item it is making, so there is nothing to stop.
    expect(within(screen.getByText("One page to keep").closest(".making") as HTMLElement).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(screen.getByText("Flashcards to keep").closest(".making") as HTMLElement).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: "Stop" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Play One cell becomes two" }));
    expect(played).toEqual(["o1"]);
    await userEvent.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/plans/p1/cancel")).toBe(true));
    expect(await screen.findByText("Stopped", { selector: ".plp-top .making-st" })).toBeInTheDocument();
  });

  it("Stop on one item stops only it, the plan goes on, and Go on makes it again", async () => {
    const { calls } = show(view("running", running()), itemStopRoutes(view("running", running())));
    const live = (await screen.findByText("Why a cell checks itself")).closest(".making") as HTMLElement;
    await userEvent.click(within(live).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/p1/items/b/stop")).toBe(true));
    const stopped = (await screen.findByText("Why a cell checks itself")).closest(".making") as HTMLElement;
    await waitFor(() => expect(stopped).toHaveClass("stopped"));
    expect(stopped).toHaveTextContent("Stopped");
    expect(screen.getByText("Making", { selector: ".plp-top .making-st" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/plans/p1/cancel")).toBe(false);
    await userEvent.click(within(stopped).getByRole("button", { name: "Go on" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/p1/items/b/retry")).toBe(true));
  });
});

describe("a stopped plan", () => {
  const stopped = () => [
    item("a", 1, "video", { title: "One cell becomes two", status: "done", outputId: "o1", done: true, settings: { minutes: 3 } }),
    item("b", 2, "video", { title: "Why a cell checks itself", status: "cancelled", settings: { minutes: 3 } }),
    item("c", 2, "quiz", { title: "Practice exam", ord: 1, status: "cancelled" }),
  ];

  it("offers Resume, and changes the maker of only what is left", async () => {
    const { calls } = show(view("cancelled", stopped()), {
      "POST /v1/plans/:id/resume": view("running", stopped()),
      "POST /v1/plans/:id/maker": { ...view("cancelled", stopped()), changed: ["b"], unchanged: [] },
    });
    expect(await screen.findByText("Stopped", { selector: ".plp-top .making-st" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 made")).toBeInTheDocument();
    const left = screen.getByText("Why a cell checks itself").closest(".plp-item") as HTMLElement;
    expect(left).toHaveClass("wait");
    await waitFor(() => expect(left).toHaveTextContent("Not made · Z Mid · medium · about 4 min"));
    // The made one has no Change; the one made without an agent has none either.
    expect(screen.queryByRole("button", { name: "Change who makes One cell becomes two" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change who makes Practice exam" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Change maker for what's left" }));
    let dialog = await screen.findByRole("dialog", { name: "Made by, for every item not made yet" });
    await userEvent.click(within(dialog).getByRole("option", { name: /Z Small/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/plans/p1/maker").at(-1)?.body).toEqual({ agent: "agent:zeta:z-small", effort: "medium" }));

    await userEvent.click(screen.getByRole("button", { name: "Change who makes Why a cell checks itself" }));
    dialog = await screen.findByRole("dialog", { name: "Made by, for videos" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/plans/p1/maker").at(-1)?.body).toEqual({ agent: "agent:zeta:z-mid", effort: "medium", items: ["b"] }));

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/plans/p1/resume")).toBe(true));
  });
});

describe("days on a plan", () => {
  it("show only when the person gave some, with how each stage stands", async () => {
    const today = localDay();
    const items = [item("a", 1, "video", { status: "done", outputId: "o1", done: true }), item("b", 2, "quiz", { status: "done", outputId: "o2" })];
    show(view("done", items, [{ level: 1, label: "Start", dueOn: "2020-01-06" }, { level: 2, label: "Check", dueOn: today }]));
    expect(await screen.findByText("All made")).toBeInTheDocument();
    expect(screen.getByText(/· done$/, { selector: ".plp-day" })).toBeInTheDocument();
    expect(screen.getByText("Today", { selector: ".plp-day" })).toBeInTheDocument();
    expect(screen.getByText(/Days only show when you gave one/)).toBeInTheDocument();
  });

  it("are not drawn at all when none was given", async () => {
    show(view("draft", draftItems()));
    await screen.findByText("Not started");
    expect(document.querySelector(".plp-day")).toBeNull();
    expect(screen.queryByText(/Days only show/)).toBeNull();
  });
});

describe("Plan a whole subject", () => {
  it("asks the chat for the plan the way it always has, with what to get through", async () => {
    const asked: string[] = [];
    const closed = vi.fn();
    renderWithEngine(<PlanNew projectId="pr1" sources={["s1"]} onAsk={(t) => asked.push(t)} onClose={closed} />, { "GET /v1/projects/:id/sources": sources });
    expect(screen.getByRole("heading", { name: "Plan a whole subject" })).toBeInTheDocument();
    expect(await screen.findByText("Chapter 12", { selector: ".chip" })).toBeInTheDocument();
    expect(screen.queryByText("Lab notes")).toBeNull();
    expect(screen.getByLabelText("What do you want to get through?")).toHaveAttribute("placeholder", "What do you want to get through, and by when?");
    await userEvent.type(screen.getByLabelText("What do you want to get through?"), "The whole cell cycle");
    await userEvent.click(screen.getByRole("button", { name: "Write the plan" }));
    expect(asked).toEqual(["/plan The whole cell cycle"]);
    expect(closed).toHaveBeenCalled();
  });
});

describe("the panel's sums", () => {
  it("reads where a plan stands from its status", () => {
    expect(phaseOf(view("approved", []))).toBe("draft");
    expect(phaseOf(view("failed", []))).toBe("stopped");
    expect(phaseOf(view("cancelled", []))).toBe("stopped");
  });

  it("never adds up a time when one part has none, and says nothing for things made without an agent", () => {
    const rail = sampleProviders.providers;
    const fast = itemMaker(item("a", 1, "video", { settings: { minutes: 3 } }), formats, rail, sampleProviders.picks, sampleMakeTimes);
    const slow = itemMaker(item("b", 1, "video", { settings: { minutes: 10 } }), formats, rail, sampleProviders.picks, sampleMakeTimes);
    const quiz = itemMaker(item("c", 1, "quiz"), formats, rail, sampleProviders.picks, sampleMakeTimes);
    expect(planTimeWords([fast, fast])?.text).toBe("about 8 min");
    expect(planTimeWords([fast, slow])).toEqual({ text: "no time yet", sub: "none made here", muted: true });
    expect(planTimeWords([quiz])).toBeUndefined();
  });

  it("says how long to watch only when every length is set", () => {
    expect(watchMinutes([item("a", 1, "video", { settings: { minutes: 3 } }), item("b", 1, "video", { settings: { minutes: 4 } })], formats)).toBe(7);
    expect(watchMinutes([item("a", 1, "video", { settings: { minutes: 3 } }), item("b", 1, "video")], formats)).toBeUndefined();
  });
});
