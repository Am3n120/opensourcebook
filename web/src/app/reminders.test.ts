import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DueStage } from "../api/types";
import { remindOnce, reminderState, reminderText, setReminders } from "./reminders";

const due = (extra: Partial<DueStage>): DueStage => ({
  planId: "pl1", planTitle: "Unit 1", projectId: "p1", level: 1, number: 1, dueOn: "2026-11-20", when: "today", left: 1, total: 1, started: true, ...extra,
});

describe("what a reminder says", () => {
  it("names what is due today and what was missed, today's first to open", () => {
    expect(reminderText([due({ when: "soon" })])).toBeUndefined();
    expect(reminderText([due({ label: "Limits" })])).toEqual({ title: "1 stage due today", body: "Limits (Unit 1)", planId: "pl1", projectId: "p1" });
    const both = reminderText([
      due({ when: "missed", planId: "old", number: 2 }),
      due({ planTitle: "Review", planId: "pl2", projectId: "p2" }),
      due({ number: 3 }),
      due({ number: 4 }),
    ])!;
    expect(both.title).toBe("3 stages due today, 1 missed");
    expect(both.body).toBe("Stage 2 (Unit 1), Stage 1 (Review), Stage 3 (Unit 1) and 1 more");
    expect([both.planId, both.projectId]).toEqual(["pl2", "p2"]);
    expect(reminderText([due({ when: "missed" }), due({ when: "missed" })])!.title).toBe("2 stages missed");
  });
});

describe("reminding on this device", () => {
  let permission: NotificationPermission;
  beforeEach(() => {
    permission = "default";
    vi.stubGlobal("Notification", {
      get permission() {
        return permission;
      },
      requestPermission: vi.fn(async () => (permission = "granted")),
    });
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is off until turned on, asking the browser once, and says when the browser blocks it", async () => {
    expect(reminderState()).toBe("off");
    expect(await setReminders(true)).toBe("on");
    expect(await setReminders(false)).toBe("off");
    permission = "denied";
    expect(reminderState()).toBe("blocked");
    expect(await setReminders(true)).toBe("blocked");
  });

  it("reminds at most once a day, and only when something is due or missed", async () => {
    const client = { due: vi.fn(async () => [due({})]) };
    const show = vi.fn();
    expect(await remindOnce(client, "2026-11-20", show)).toBe(false);
    expect(client.due).not.toHaveBeenCalled();
    await setReminders(true);
    expect(await remindOnce(client, "2026-11-20", show)).toBe(true);
    expect(client.due).toHaveBeenCalledWith("2026-11-20", 0);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "1 stage due today" }));
    expect(await remindOnce(client, "2026-11-20", show)).toBe(false);
    client.due.mockResolvedValueOnce([]);
    expect(await remindOnce(client, "2026-11-21", show)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
