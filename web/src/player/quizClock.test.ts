import { describe, expect, it } from "vitest";
import { clockWords, minutesWords, msLeft, timing, warningFor } from "./quizClock";

describe("a quiz's clock", () => {
  it("counts down from Start and never below zero", () => {
    expect(msLeft(1_000, 1, 1_000)).toBe(60_000);
    expect(msLeft(1_000, 1, 31_000)).toBe(30_000);
    expect(msLeft(1_000, 1, 99_000)).toBe(0);
  });

  it("reads as minutes and seconds, with hours only from an hour", () => {
    expect(clockWords(245_000)).toBe("4:05");
    expect(clockWords(3_729_000)).toBe("1:02:09");
    // A part second still showing is a second, so 0:00 is only the end.
    expect(clockWords(400)).toBe("0:01");
    expect(clockWords(0)).toBe("0:00");
  });

  it("keeps the seconds taken and whether the time ran out", () => {
    expect(timing(0, 125_400, 10)).toEqual({ seconds: 125, timedOut: false });
    expect(timing(0, 600_000, 10)).toEqual({ seconds: 600, timedOut: true });
    // Reopened long after it ran out: still the limit, not the hours since.
    expect(timing(0, 9_000_000, 10)).toEqual({ seconds: 600, timedOut: true });
  });

  it("says minutes in words", () => {
    expect(minutesWords(30)).toBe("under a minute");
    expect(minutesWords(61)).toBe("1 minute");
    expect(minutesWords(2_040)).toBe("34 minutes");
  });
});

describe("what a screen reader is told of the clock", () => {
  it("says nothing until 5 minutes left, then 5 minutes, then 1 minute", () => {
    expect(warningFor(5 * 60_000 + 1, 30)).toBe("");
    expect(warningFor(5 * 60_000, 30)).toBe("5 minutes left");
    expect(warningFor(60_001, 30)).toBe("5 minutes left");
    expect(warningFor(60_000, 30)).toBe("1 minute left");
  });

  it("leaves out a mark the limit does not pass", () => {
    expect(warningFor(3 * 60_000, 5)).toBe("");
    expect(warningFor(30_000, 5)).toBe("1 minute left");
    expect(warningFor(30_000, 1)).toBe("");
  });
});
