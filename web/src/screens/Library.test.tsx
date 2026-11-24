import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now, sampleOutputs } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const out = (id: string, type: string, projectId?: string) => ({
  id, type, title: `Output ${id}`, schemaVersion: 1, costUsd: 0.05, createdAt: now, updatedAt: now, ...(projectId ? { projectId } : {}),
});
const routes = {
  "GET /v1/projects": { projects: [{ id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now }] },
  "GET /v1/outputs": ({ query }: { query: URLSearchParams }) =>
    query.get("cursor") ? { outputs: [out("o3", "byte")] } : { outputs: [out("o1", "byte", "p1"), out("o2", "byte")], nextCursor: "c1" },
  "GET /v1/projects/:id/outputs": { outputs: [out("o1", "byte", "p1")] },
};

test("lists everything made with its format tile and project, no money, and pages on", async () => {
  renderApp("/library", routes);
  const first = (await screen.findByText("Output o1")).closest("a")!;
  expect(first).toHaveAttribute("href", "/outputs/o1");
  expect(await within(first).findByText(/Calculus I/)).toBeInTheDocument();
  expect(first.querySelector('.ftile[data-format="flashcards"]')).not.toBeNull();
  expect(first.textContent).not.toMatch(/\$/);
  expect(within(screen.getByText("Output o2").closest("a")!).getByText(/No project/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Output o3")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
});

test("format chips come from the engine and filter by type", async () => {
  const { calls } = renderApp("/library", routes);
  const group = await screen.findByRole("group", { name: "Format" });
  await userEvent.click(await within(group).findByRole("button", { name: /video/ }));
  expect(within(group).getByRole("button", { name: /video/ })).toHaveAttribute("aria-pressed", "true");
  expect(calls.filter((c) => c.path === "/v1/outputs").at(-1)?.query.get("type")).toBe("video");
});

test("filters by project, or by things made with no project", async () => {
  const { calls } = renderApp("/library", routes);
  const select = await screen.findByRole("combobox", { name: "Project" });
  await within(select).findByRole("option", { name: "Calculus I" });
  await userEvent.selectOptions(select, "p1");
  expect(calls.some((c) => c.path === "/v1/projects/p1/outputs")).toBe(true);
  await userEvent.selectOptions(select, "none");
  expect(calls.filter((c) => c.path === "/v1/outputs").at(-1)?.query.get("project")).toBe("none");
});

test("search finds things by their words, keeps them in the address, and says when nothing matches", async () => {
  const { calls } = renderApp("/library", {
    ...routes,
    "GET /v1/outputs": ({ query }: { query: URLSearchParams }) => (query.get("q") === "nothing" ? { outputs: [] } : { outputs: [out("o1", "byte", "p1")] }),
  });
  const box = await screen.findByRole("searchbox", { name: "Search the Library" });
  await userEvent.type(box, "glycolysis");
  await screen.findByText("Output o1");
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/v1/outputs").at(-1)?.query.get("q")).toBe("glycolysis"));
  await userEvent.clear(box);
  await userEvent.type(box, "nothing");
  expect(await screen.findByText("Nothing matches “nothing”")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "clear the search" }));
  expect(await screen.findByText("Output o1")).toBeInTheDocument();
  expect(box).toHaveValue("");
});

test("a card shows what its format put in its glimpse: a frame of the video, else its first words", async () => {
  renderApp("/library", {
    ...routes,
    "GET /v1/outputs": {
      outputs: [
        { ...out("o1", "video"), glimpse: { text: "The gradient drives ATP synthase.", media: { kind: "video", url: "/v1/assets/v1" } } },
        { ...out("o2", "byte"), glimpse: { text: "Three names, one idea" } },
        out("o3", "quiz"),
      ],
    },
  });
  const video = (await screen.findByText("Output o1")).closest("a")!;
  expect(video.querySelector("video")?.getAttribute("src")).toBe("/api/v1/assets/v1#t=1");
  const byte = screen.getByText("Output o2").closest("a")!;
  expect(within(byte).getByText("Three names, one idea")).toBeInTheDocument();
  const quiz = screen.getByText("Output o3").closest("a")!;
  expect(quiz.querySelector('.ftile[data-format="quiz"]')).not.toBeNull();
});

test("the list shows the same face as a small thumbnail", async () => {
  renderApp("/library?view=list", { ...routes, "GET /v1/outputs": { outputs: [{ ...out("o1", "byte", "p1"), glimpse: { text: "Three names, one idea" } }] } });
  const row = (await screen.findByText("Output o1")).closest("a")!;
  expect(row.querySelector(".face.thumb .said")?.textContent).toBe("Three names, one idea");
});

test("chips say how many of each shape there are, the meta line says shape and project, and Grid and List switch the layout", async () => {
  renderApp("/library", {
    ...routes,
    "GET /v1/outputs": { outputs: [out("o1", "quiz", "p1"), out("o2", "quiz"), out("o3", "flashcards")] },
  });
  const group = await screen.findByRole("group", { name: "Format" });
  expect(await within(group).findByRole("button", { name: "All · 3" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "quiz · 2" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "flashcards · 1" })).toBeInTheDocument();
  expect(within((await screen.findByText("Output o1")).closest("a")!).getByText("quiz · Calculus I")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Library", hidden: true })).toHaveClass("sr-only");
  await userEvent.click(screen.getByRole("button", { name: "List" }));
  expect(document.querySelector(".libitems")).toHaveClass("list");
  await userEvent.click(screen.getByRole("button", { name: "Grid" }));
  expect(document.querySelector(".libitems")).toHaveClass("gallery");
});

test("a card says how big the thing is and ticks it done, as the engine sends them; nothing when absent", async () => {
  renderApp("/library", { ...routes, "GET /v1/outputs": { outputs: sampleOutputs } });
  const cards = (await screen.findByText("Limits, 12 cards")).closest("a")!;
  expect(cards).toHaveTextContent("12 cards");
  expect(cards).toHaveTextContent("done");
  const guide = screen.getByText("One page to keep").closest("a")!;
  expect(guide).toHaveTextContent("0.5 page");
  expect(guide).not.toHaveTextContent("done");
  const video = screen.getByText("Not rendered yet").closest("a")!;
  expect(video.querySelector(".sb")?.textContent).toBe("video · No project");
});

test("a thing made at once has a ⋯ with Delete… that asks first and deletes its one-item plan; one inside a larger plan has none", async () => {
  const plan = (id: string, direct: boolean) => ({ id, projectId: "p1", title: id, version: 1, status: "done", createdAt: now, updatedAt: now, counts: { total: 1, done: 1 }, ...(direct ? { direct: true } : {}) });
  const { calls } = renderApp("/library", {
    ...routes,
    "GET /v1/outputs": { outputs: [{ ...out("o1", "flashcards", "p1"), planId: "d1", itemId: "d1-i" }, { ...out("o2", "quiz", "p1"), planId: "big", itemId: "b1" }] },
    "GET /v1/projects/:id/plans": { plans: [plan("d1", true), plan("big", false)] },
    "DELETE /v1/plans/:id": { planId: "d1", deleted: { items: 1, outputs: 1, jobs: 1, files: 0 } },
  });
  await userEvent.click(await screen.findByRole("button", { name: "More for Output o1" }));
  expect(screen.queryByRole("button", { name: "More for Output o2" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete “Output o1” for good?" });
  expect(ask).toHaveTextContent("This set of flashcards goes for good: it leaves Made here and the Library. This can't be undone.");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
  await vi.waitFor(() => expect(screen.queryByText("Output o1")).not.toBeInTheDocument());
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/plans/d1"]);
  expect(screen.getByText("Output o2")).toBeInTheDocument();
});

test("the size and done tick sit in a part that never shrinks, apart from the shortening name", async () => {
  renderApp("/library", {
    ...routes,
    "GET /v1/outputs": { outputs: [{ ...out("o1", "byte", "p1"), done: true, size: { cards: 12 } }] },
  });
  const link = (await screen.findByText("Output o1")).closest("a")!;
  const sb = link.querySelector(".sb")!;
  expect(sb.querySelector(".sbl")).not.toBeNull();
  const fixed = sb.querySelector(".sbr")!;
  expect(fixed.textContent).toMatch(/done/);
  expect(sb.querySelector(".sbl")!.textContent).not.toMatch(/done/);
});
