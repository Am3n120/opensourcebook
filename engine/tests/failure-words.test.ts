/**
 * Why making something failed, in words a person reads: one line per cause,
 * a calm generic line for anything else, and never the technical text.
 */
import { describe, expect, it } from "vitest";
import { PipelineError } from "../src/engines/retry";
import { JOB_FAILURE_CODES, failureCodeOf, failureSaidOf, failureWords, withFailureCode } from "../src/jobs/failure-words";
import { JobFailure } from "../src/jobs/lifecycle";
import { BudgetExceededError } from "../src/providers/budget";

const job = (state: Record<string, unknown> = {}, status: "failed" | "dead" = "failed", attempt = 1) => ({ state: state as never, status, attempt });

describe("failure words", () => {
  it("give every cause a short plain line that names the thing, never a code or a raw error", () => {
    for (const code of JOB_FAILURE_CODES) {
      const line = failureWords(job({ failure: code }, code === "gave_up" ? "dead" : "failed", 3), "quiz");
      expect(line, code).toMatch(/^[A-Z].*\.$/);
      expect(line, code).not.toMatch(/_|job|engine|registered|queue|invalid|error|attempt/i);
      expect(line.length, code).toBeLessThanOrEqual(160);
    }
    expect(failureWords(job({ failure: "not_valid" }), "video")).toBe("Open Sourcebook could not get this video right from its sources. Try again, or change its brief or sources.");
  });

  it("say a queue that gave up as tries, and anything unknown calmly", () => {
    expect(failureWords(job({}, "dead", 4), "byte")).toBe("Open Sourcebook tried 4 times and could not make this byte. Try again later.");
    expect(failureWords(job({}, "dead", 1), "byte")).toBe("Open Sourcebook could not make this byte. Try again later.");
    expect(failureWords(job({ failure: "something_new" }))).toBe("Something went wrong while making this item. Try again.");
    expect(failureWords(job())).toBe("Something went wrong while making this item. Try again.");
  });

  it("read the cause from what was thrown", () => {
    expect(failureCodeOf(new JobFailure("Source x does not exist.", false, "source_missing"))).toBe("source_missing");
    expect(failureCodeOf(new JobFailure("whatever", true))).toBeUndefined();
    expect(failureCodeOf(new PipelineError("none", "NO_SOURCE_TEXT"))).toBe("no_source_text");
    expect(failureCodeOf(new PipelineError("flaky", "EMPTY_STRUCTURE"))).toBeUndefined();
    expect(failureCodeOf(new BudgetExceededError(1, 1))).toBe("over_budget");
    expect(failureCodeOf(Object.assign(new Error("402"), { status: 402 }))).toBe("out_of_credit");
    expect(failureCodeOf(new Error("socket hang up"))).toBeUndefined();
  });

  it("say an agent that stopped before it began with its own words, and keep them only beside that cause", () => {
    const said = "The 'some-model' model is not supported when using Codex with a ChatGPT account.";
    const failure = new JobFailure("the agent's turn failed before any tool call", false, "agent_error", said);
    expect(failureSaidOf(failure)).toBe(said);
    expect(failureSaidOf(new JobFailure("x", false, "timed_out"))).toBeUndefined();
    const state = withFailureCode({}, "agent_error", said);
    expect(failureWords(job(state), "video")).toBe(`Your agent stopped before it began on this video. It said: "The 'some-model' model is not supported when using Codex with a ChatGPT account." Fix what it says, then try again.`);
    expect(failureWords(job({ failure: "agent_error" }), "video")).toBe("Your agent stopped before it began on this video. Check that it runs on your computer, then try again.");
    // A later cause clears the words with the code.
    expect(withFailureCode(state, "stopped")).toEqual({ failure: "stopped" });
    expect(withFailureCode(state, undefined)).toEqual({});
  });

  it("keep the cause in the job's state, and clear it when there is none", () => {
    expect(withFailureCode({ outputId: "o" }, "no_provider")).toEqual({ outputId: "o", failure: "no_provider" });
    expect(withFailureCode({ outputId: "o", failure: "no_provider" }, undefined)).toEqual({ outputId: "o" });
  });
});
