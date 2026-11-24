import { describe, expect, it } from "vitest";
import cases from "./fixtures/time-buckets.json";
import { reviewScope, timeBucket, timingKey, usableTiming } from "../src/studio/timing";

describe("time buckets", () => {
  for (const item of cases.cases) {
    it(item.name, () => {
      const descriptor = item.timing ? { timing: item.timing } : {};
      expect(timeBucket(descriptor, item.settings) ?? null).toBe(item.bucket);
    });
  }
});

describe("timing key", () => {
  const defaults = { defaultModels: { chat: "haiku", work: "opus" }, defaultEfforts: { work: "high" } };

  it("is the pick as picked", () => {
    expect(timingKey({ agent: "claude", model: "sonnet", effort: "low" }, "work", defaults)).toEqual({ agent: "claude", model: "sonnet", effort: "low" });
  });

  it("falls to the adapter's default for that kind of turn, then to the model the connector reported", () => {
    expect(timingKey({ agent: "claude" }, "work", defaults)).toEqual({ agent: "claude", model: "opus", effort: "high" });
    expect(timingKey({ agent: "claude" }, "chat", defaults)).toEqual({ agent: "claude", model: "haiku", effort: "" });
    expect(timingKey({ agent: "codex" }, "chat", {}, "gpt-5")).toEqual({ agent: "codex", model: "gpt-5", effort: "" });
    expect(timingKey({ agent: "codex" }, "chat")).toEqual({ agent: "codex", model: "", effort: "" });
  });

  it("prefers the pick over what the connector reported", () => {
    expect(timingKey({ agent: "claude", model: "sonnet" }, "chat", {}, "other").model).toBe("sonnet");
  });
});

describe("what can be kept", () => {
  it("needs an agent and seconds above zero", () => {
    expect(usableTiming({ seconds: 5, agent: "claude" })).toBe(true);
    expect(usableTiming({ seconds: 0, agent: "claude" })).toBe(false);
    expect(usableTiming({ seconds: 5, agent: "" })).toBe(false);
    expect(usableTiming(undefined)).toBe(false);
  });

  it("names a review's scope after its format", () => {
    expect(reviewScope("video")).toBe("video.review");
  });
});
