import { describe, expect, it } from "vitest";
import {
  agentField,
  agentPickOf,
  readAgentFields,
  readReviewerFields,
  reviewerField,
  reviewerPickOf,
  reviewScope,
  settleAgentPick,
  settleReviewerPick,
} from "../src/engines/agent-fields";
import type { ValidationIssue } from "../src/studio/types";

describe("agent fields", () => {
  it("declares the maker and the reviewer as agent fields with their roles", () => {
    expect(agentField("chat")).toMatchObject({ key: "agent", kind: "agent", effortKey: "effort", turnKind: "chat", role: "make" });
    expect(agentField("work", { key: "maker", in: ["x"] }).showWhen).toEqual({ key: "maker", in: ["x"] });
    expect(reviewerField()).toMatchObject({ key: "reviewer", kind: "agent", effortKey: "reviewEffort", role: "review", offValue: "off", turnKind: "work" });
  });

  it("reads good values and says what is wrong with bad ones", () => {
    const issues: ValidationIssue[] = [];
    expect(readAgentFields({ agent: "agent:codex:gpt-5", effort: "high" }, issues)).toEqual({ agent: "agent:codex:gpt-5", effort: "high" });
    expect(readAgentFields({ agent: "auto", effort: "auto" }, issues)).toEqual({ agent: "auto", effort: "auto" });
    expect(issues).toEqual([]);
    readAgentFields({ agent: "codex", effort: 3 }, issues);
    expect(issues.map((issue) => issue.path)).toEqual(["$.agent", "$.effort"]);
    const more: ValidationIssue[] = [];
    readAgentFields({ agent: "off" }, more);
    expect(more).toHaveLength(1);
  });

  it("lets only the reviewer be off", () => {
    const issues: ValidationIssue[] = [];
    expect(readReviewerFields({ reviewer: "off" }, issues)).toEqual({ reviewer: "off" });
    expect(readReviewerFields({ reviewer: "agent:claude:haiku", reviewEffort: "low" }, issues)).toEqual({ reviewer: "agent:claude:haiku", reviewEffort: "low" });
    expect(issues).toEqual([]);
  });

  it("gives the concrete pick and drops auto", () => {
    expect(agentPickOf({ agent: "agent:claude:opus", effort: "high" })).toEqual({ agent: "claude", model: "opus", effort: "high" });
    expect(agentPickOf({ agent: "auto", effort: "auto" })).toEqual({});
    expect(agentPickOf({})).toEqual({});
    expect(reviewerPickOf({ reviewer: "off" })).toBe("off");
    expect(reviewerPickOf({})).toBe("auto");
    expect(reviewerPickOf({ reviewer: "agent:claude:haiku", reviewEffort: "low" })).toEqual({ agent: "claude", model: "haiku", effort: "low" });
  });

  it("settles an open agent from the scope's remembered pick", () => {
    const picks = { quiz: { agent: "codex", model: "gpt-5", effort: "high" } };
    expect(settleAgentPick("quiz", {}, picks)).toEqual({ agent: "agent:codex:gpt-5", effort: "high" });
    expect(settleAgentPick("quiz", { agent: "auto", effort: "auto" }, picks)).toEqual({ agent: "agent:codex:gpt-5", effort: "high" });
    expect(settleAgentPick("flashcards", {}, picks)).toEqual({});
    expect(settleAgentPick("quiz", { agent: "agent:codex:gpt-5", effort: "low" }, picks)).toEqual({});
  });

  it("never gives a remembered effort to another agent", () => {
    const picks = { quiz: { agent: "codex", effort: "xhigh" } };
    expect(settleAgentPick("quiz", { agent: "agent:claude" }, picks)).toEqual({});
    expect(settleAgentPick("quiz", { agent: "agent:codex:other" }, picks)).toEqual({ effort: "xhigh" });
    expect(settleAgentPick("quiz", { agent: "agent:claude" }, { quiz: { effort: "low" } })).toEqual({ effort: "low" });
  });

  it("settles the reviewer from the review scope, which may be off", () => {
    expect(reviewScope("video")).toBe("video.review");
    expect(settleReviewerPick("video", {}, { "video.review": { off: true } })).toEqual({ reviewer: "off" });
    expect(settleReviewerPick("video", { reviewer: "agent:claude" }, { "video.review": { off: true } })).toEqual({});
    expect(settleReviewerPick("video", {}, { "video.review": { agent: "claude", model: "haiku", effort: "low" } })).toEqual({ reviewer: "agent:claude:haiku", reviewEffort: "low" });
    expect(settleReviewerPick("video", { reviewer: "off" }, { "video.review": { agent: "claude" } })).toEqual({});
    expect(settleReviewerPick("video", {}, { video: { agent: "claude" } })).toEqual({});
  });
});
