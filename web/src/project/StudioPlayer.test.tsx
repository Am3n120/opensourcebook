import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { Item, PlanView } from "../api/types";
import { ApiProvider } from "../app/api";
import { baseRoutes, fakeEngine, now, type FakeRequest } from "../test/fakeEngine";
import { StudioPlayer } from "./StudioPlayer";

/** The Studio's player keeps the thing in view by its id: things added to the list while it is open do not move it. */
const chat = { id: "c1", projectId: "p1", messageCount: 0, createdAt: now, updatedAt: now };
const item = (id: string, ord: number, title: string): Item => ({ id, level: 1, ord, type: "quiz", title, settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: `o-${id}` });
const viewOf = (items: Item[]): PlanView => ({
  plan: { id: "pl1", projectId: "p1", title: "Loops", version: 1, status: "done", createdAt: now, updatedAt: now, kickedOffAt: now },
  stages: [{ level: 1 }],
  items,
  edges: [],
  counts: { total: items.length, done: 0 },
  estimateUsd: 0,
  issues: [],
});
const quiz = (id: string, title: string) => ({ id: `o-${id}`, type: "quiz", title, projectId: "p1", planId: "pl1", itemId: id, payload: { questions: [] }, citations: [], createdAt: now, updatedAt: now });

test("an output added to the list while a thread is open keeps the same thing in view, with its thread", async () => {
  const outputs: Record<string, ReturnType<typeof quiz>> = { "o-a": quiz("a", "First"), "o-b": quiz("b", "Second"), "o-n": quiz("n", "New one") };
  const engine = fakeEngine({
    ...baseRoutes,
    "GET /v1/outputs/:id": (req: FakeRequest) => ({ output: outputs[req.params.id!] }),
    "GET /v1/threads": { threads: [] },
    "GET /v1/plans/:id/items/:itemId/thread": { item: { id: "b", planId: "pl1", projectId: "p1", title: "Second", type: "quiz", outputId: "o-b" }, chat, messages: [] },
  });
  const onGo = vi.fn();
  const player = (views: PlanView[]) => (
    <MemoryRouter>
      <ApiProvider client={engine.client}>
        <StudioPlayer outputId="o-b" projectId="p1" views={views} onGo={onGo} onClose={() => undefined} />
      </ApiProvider>
    </MemoryRouter>
  );
  const { rerender } = render(player([viewOf([item("a", 0, "First"), item("b", 1, "Second")])]));
  const playing = await screen.findByRole("complementary", { name: "Playing" });
  // The feed is one screen tall, scrolled to the second thing.
  const feed = playing.querySelector(".feed9") as HTMLDivElement;
  Object.defineProperty(feed, "clientHeight", { configurable: true, value: 100 });
  feed.scrollTop = 100;
  await userEvent.click(within(playing).getByRole("button", { name: "Talk about this" }));
  expect(await screen.findByRole("complementary", { name: "Talk about Second" })).toBeInTheDocument();

  // A new thing is made, and falls before the one in view.
  rerender(player([viewOf([item("n", 0, "New one"), item("a", 1, "First"), item("b", 2, "Second")])]));
  fireEvent.scroll(feed);
  await act(() => new Promise((r) => setTimeout(r, 200)));

  expect(onGo).not.toHaveBeenCalled();
  expect(feed.scrollTop).toBe(200);
  expect(playing.querySelector('section[aria-current="true"]')).toHaveAttribute("aria-label", "Second");
  await waitFor(() => expect(screen.getByRole("complementary", { name: "Talk about Second" })).toBeInTheDocument());
});
