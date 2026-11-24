import { describe, expect, it } from "vitest";
import { dayWords, daysFrom, localDay, whenOf } from "./days";

describe("days on stages", () => {
  it("takes today from this device's own calendar, not UTC", () => {
    expect(localDay(new Date(2026, 10, 20, 23, 59))).toBe("2026-11-20");
    expect(localDay(new Date(2027, 0, 3, 0, 1))).toBe("2027-01-03");
  });

  it("counts days and says where one falls", () => {
    expect(daysFrom("2026-11-20", "2026-12-01")).toBe(11);
    expect(daysFrom("2026-12-31", "2027-01-01")).toBe(1);
    expect(whenOf("2026-11-19", "2026-11-20")).toBe("missed");
    expect(whenOf("2026-11-20", "2026-11-20")).toBe("today");
    expect(whenOf("2026-11-27", "2026-11-20")).toBe("soon");
    expect(whenOf("2026-11-28", "2026-11-20")).toBe("later");
  });

  it("says near days in words and others as a short date", () => {
    expect(dayWords("2026-11-20", "2026-11-20")).toBe("Today");
    expect(dayWords("2026-11-21", "2026-11-20")).toBe("Tomorrow");
    expect(dayWords("2026-11-19", "2026-11-20")).toBe("Yesterday");
    const later = dayWords("2026-11-24", "2026-11-20");
    expect(later).toMatch(/24/);
    expect(later).not.toMatch(/2026/);
    expect(dayWords("2027-02-03", "2026-11-20")).toMatch(/2027/);
  });
});
