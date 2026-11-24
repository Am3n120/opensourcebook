import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { redesignRoutes, sampleActivity, type FakeRequest } from "../test/fakeEngine";
import { renderApp } from "../test/render";
import { ACTIVITY_REFRESH_MS, duration, linkOf, tokens } from "./activityWords";

afterEach(() => vi.useRealTimers());

test("Settings › Advanced has a row that opens the Activity page", async () => {
  renderApp("/settings#advanced", redesignRoutes);
  await userEvent.click(await screen.findByRole("link", { name: "See what the agents are doing" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings#advanced");
});

test("shows what is being made now, small totals, and every turn with its time, tokens and tool calls, in plain words and no money", async () => {
  renderApp("/settings/activity", redesignRoutes);
  const now = await screen.findByRole("region", { name: "Being made now" });
  expect(within(now).getByText("The spindle checkpoint")).toBeInTheDocument();
  expect(within(now).getByRole("status")).toHaveTextContent("Making · 4 min so far · Drawing scene 3 of 7");
  expect(within(now).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  expect(within(now).getByText("Cell biology · on zeta, z-mid, medium effort")).toBeInTheDocument();
  expect(within(now).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/projects/p1?plan=d1");

  const totals = screen.getByRole("region", { name: "Totals" });
  expect(totals).toHaveTextContent("Today");
  expect(totals).toHaveTextContent("Turns2");
  expect(totals).toHaveTextContent("Time2 min");
  expect(totals).toHaveTextContent("Tokens read30k");
  expect(totals).toHaveTextContent("Last 7 days");

  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "What for", "Agent", "Took", "Tokens read", "Tokens written", "Tool calls", "How it ended"]);
  const quiz = rows[1]!;
  expect(within(quiz).getByRole("link", { name: "Check the phases" })).toHaveAttribute("href", "/outputs/o9");
  expect(quiz).toHaveTextContent("took 2 min");
  expect(quiz).toHaveTextContent("5k tokens read");
  expect(quiz).toHaveTextContent("2.1k tokens written");
  expect(quiz).toHaveTextContent("12 tool calls");
  expect(quiz).toHaveTextContent("z-mid · low effort");
  expect(quiz).toHaveTextContent("Done");
  const chat = rows[0]!;
  expect(within(chat).getByRole("link", { name: "Mitosis questions" })).toHaveAttribute("href", "/projects/p1?chat=c1");
  expect(chat).toHaveTextContent("chat reply · Cell biology");
  expect(chat).toHaveTextContent("24k from cache");
  expect(chat).toHaveTextContent("3 tool calls");
  const review = rows[2]!;
  expect(review).toHaveTextContent("A fresh look at a video");
  expect(review).toHaveTextContent("Not reported");
  expect(review).toHaveTextContent("1 tool call");
  expect(review).toHaveTextContent("Stopped");
  expect(document.body.textContent).not.toMatch(/\$|cost|usd|price/i);
});

test("filters by shape and by project, asks the engine with them, and pages back with Show older turns", async () => {
  const { calls } = renderApp("/settings/activity", {
    ...redesignRoutes,
    "GET /v1/activity": (req: FakeRequest) => (req.query.get("cursor") ? { ...sampleActivity, making: [], turns: [{ ...sampleActivity.turns[2], turnId: "t0", title: "An older one" }] } : { ...sampleActivity, nextCursor: "12" }),
  });
  await screen.findByRole("table");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Shape" }), "quiz");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p1");
  const asked = calls.filter((c) => c.path === "/v1/activity").at(-1)!;
  expect(asked.query.get("shape")).toBe("quiz");
  expect(asked.query.get("project")).toBe("p1");
  expect(asked.query.get("dayStart")).toMatch(/^\d{4}-\d\d-\d\dT/);
  await userEvent.click(await screen.findByRole("button", { name: "Show older turns" }));
  expect(await screen.findByText("An older one")).toBeInTheDocument();
  expect(calls.filter((c) => c.path === "/v1/activity").at(-1)!.query.get("cursor")).toBe("12");
  expect(screen.queryByRole("button", { name: "Show older turns" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("combobox", { name: "Shape" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["All shapes", "chat reply", "quiz", "video"]);
});

test("says plainly when the connector isn't set up or can't be reached, and when there is nothing yet", async () => {
  const first = renderApp("/settings/activity", { ...redesignRoutes, "GET /v1/activity": { connector: "notSetUp", making: [], turns: [], shapes: [], projects: [] } });
  expect(await screen.findByText(/The agent connector isn't set up/)).toBeInTheDocument();
  expect(screen.getByText("Nothing is being made right now.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
  first.unmount();
  const second = renderApp("/settings/activity", { ...redesignRoutes, "GET /v1/activity": { connector: "unreachable", making: [], turns: [], shapes: [], projects: [] } });
  expect(await screen.findByText(/can't be reached right now/)).toBeInTheDocument();
  second.unmount();
  renderApp("/settings/activity", { ...redesignRoutes, "GET /v1/activity": { ...sampleActivity, making: [], turns: [] } });
  expect(await screen.findByText("No agent turns yet")).toBeInTheDocument();
});

test("reads again by itself every few seconds while something is being made, and Refresh reads at once", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = renderApp("/settings/activity", redesignRoutes);
  await screen.findByRole("table");
  const count = () => calls.filter((c) => c.path === "/v1/activity").length;
  const before = count();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS + 50);
  });
  expect(count()).toBe(before + 1);
  await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  expect(count()).toBe(before + 2);
});

test("stays quiet when nothing is being made", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = renderApp("/settings/activity", { ...redesignRoutes, "GET /v1/activity": { ...sampleActivity, making: [] } });
  await screen.findByRole("table");
  const before = calls.filter((c) => c.path === "/v1/activity").length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 3);
  });
  expect(calls.filter((c) => c.path === "/v1/activity").length).toBe(before);
});

test("times, token counts and links in words", () => {
  expect([8.2, 95, 250, 3600, 3900].map(duration)).toEqual(["8 s", "2 min", "4 min", "1 h", "1 h 5 min"]);
  expect([950, 1200, 2100, 24000, 1_250_000].map(tokens)).toEqual(["950", "1.2k", "2.1k", "24k", "1.3M"]);
  expect(linkOf(undefined)).toBeUndefined();
  expect(linkOf({ projectId: "p 1" })).toBe("/projects/p%201");
  expect(linkOf({ projectId: "p1", planId: "d1", outputId: "o1" })).toBe("/outputs/o1");
});
