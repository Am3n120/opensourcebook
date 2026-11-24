import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { FormatDescriptor, Item, PlanView } from "../api/types";
import { Ctx } from "../app/context";
import { localDay, missedStages } from "./days";
import { PlanCard } from "./PlanCard";
import { PlanContext } from "./PlanContext";
import { buildStages } from "./planModel";

const formats: FormatDescriptor[] = [{ id: "quiz", label: "quiz", plural: "quizzes", colorSlot: 3, icon: "check", ready: true, defaults: {}, settings: [] }];

/** A day `n` days from today on this device. */
function inDays(n: number): string {
  const at = new Date();
  at.setDate(at.getDate() + n);
  return localDay(at);
}

function item(id: string, level: number, extra: Partial<Item> = {}): Item {
  return { id, level, ord: 0, type: "quiz", title: `Item ${id}`, settings: {}, enabled: true, status: "pending", sources: [], done: false, ...extra };
}

function view(items: Item[], stages: PlanView["stages"], status: PlanView["plan"]["status"] = "running"): PlanView {
  return {
    plan: { id: "p", projectId: "pr", title: "Term", status, version: 1, createdAt: "", updatedAt: "", kickedOffAt: "2026-11-01T00:00:00Z" } as PlanView["plan"],
    stages,
    items,
    edges: [],
    counts: { total: items.length, done: 0 },
    estimateUsd: 0,
    issues: [],
  };
}

function show(v: PlanView, client: Partial<ApiClient> = {}) {
  const edit = vi.fn(async (run: () => Promise<PlanView>) => (await run(), true));
  const app = { client: client as ApiClient, formats, edgeKinds: [], refreshInbox: () => undefined };
  render(
    <MemoryRouter>
      <Ctx.Provider value={app}>
        <PlanContext.Provider value={{ view: v, formats, sources: [], editable: false, edit, act: async () => true, busy: false }}>
          <PlanCard />
        </PlanContext.Provider>
      </Ctx.Provider>
    </MemoryRouter>,
  );
  return { edit };
}

describe("a stage's day on the plan card", () => {
  it("says when each dated stage is due, and which day was missed with something left", () => {
    show(
      view(
        [item("a", 1), item("b", 2), item("c", 3, { done: true }), item("d", 4)],
        [
          { level: 1, label: "Limits", dueOn: inDays(-2) },
          { level: 2, dueOn: inDays(0) },
          { level: 3, dueOn: inDays(-5) },
        ],
      ),
    );
    const stage = (n: number) => screen.getByRole("region", { name: `Stage ${n}` });
    expect(within(stage(1)).getByRole("button", { name: /^Missed / })).toHaveClass("day", "missed");
    expect(within(stage(2)).getByRole("button", { name: "Due today" })).toHaveClass("today");
    // Gone through: its day is only a date, never "missed".
    expect(within(stage(3)).getByRole("button", { name: /^Due / })).not.toHaveClass("missed");
    expect(within(stage(4)).getByRole("button", { name: "Set a day" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Limits was meant for .+\./);
  });

  it("gives a stage a day, and clears it", async () => {
    const setStageDay = vi.fn(async () => view([], []));
    show(view([item("a", 1)], [{ level: 1, dueOn: inDays(3) }]), { setStageDay } as Partial<ApiClient>);
    await userEvent.click(screen.getByRole("button", { name: /^Due / }));
    const input = screen.getByLabelText("Stage day");
    expect(input).toHaveValue(inDays(3));
    await userEvent.clear(input);
    await userEvent.type(input, inDays(4));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setStageDay).toHaveBeenCalledWith("p", 1, inDays(4));
    await userEvent.click(screen.getByRole("button", { name: /^Due / }));
    await userEvent.click(screen.getByRole("button", { name: "No day" }));
    expect(setStageDay).toHaveBeenLastCalledWith("p", 1, null);
  });

  it("moves missed days on from today with one press", async () => {
    const catchUp = vi.fn(async () => view([], []));
    show(view([item("a", 1), item("b", 2)], [{ level: 1, dueOn: inDays(-3) }, { level: 2, dueOn: inDays(-1) }]), { catchUp } as Partial<ApiClient>);
    expect(screen.getByRole("status")).toHaveTextContent("2 stages' days have passed.");
    await userEvent.click(screen.getByRole("button", { name: "Move the days on" }));
    expect(catchUp).toHaveBeenCalledWith("p", localDay());
  });

  it("offers no days on a plan thrown away", () => {
    show(view([item("a", 1)], [{ level: 1, dueOn: inDays(-3) }], "discarded"));
    expect(screen.queryByRole("button", { name: /Set a day|Missed|Due/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts a stage as missed only while something in it is left", () => {
    const today = "2026-11-20";
    const stages = buildStages([item("a", 1, { done: true }), item("b", 2, { status: "skipped" }), item("c", 3)], [
      { level: 1, dueOn: "2026-11-18" },
      { level: 2, dueOn: "2026-11-18" },
      { level: 3, dueOn: "2026-11-19" },
    ]);
    expect(missedStages(stages, today).map((s) => s.level)).toEqual([3]);
  });
});
