import { describe, expect, it } from "vitest";
import type { ItemJob } from "../api/types";
import { waitingLine } from "./waiting";

const job = (waiting?: ItemJob["waiting"]): ItemJob => ({ id: "j", status: "waiting", stage: "waiting", progress: 0.4, attempt: 1, step: "Waiting for your agent's plan…", ...(waiting ? { waiting } : {}) });
const words = "Your agent's plan has reached its limit. Open Sourcebook will carry on when it is available again. What was made of this quiz so far is kept.";

describe("what a waiting item says", () => {
  it("is nothing for an item that does not wait", () => {
    expect(waitingLine(job())).toBeUndefined();
  });

  it("is the engine's words, with the agent's own words on its reset left as they are", () => {
    expect(waitingLine(job({ reason: "agent_limit", words: `${words} It said it resets 3pm.`, since: "", nextTryAt: "", tries: 1, resets: "3pm" }))).toBe(`${words} It said it resets 3pm.`);
  });

  it("reads a reset time the agent gave in this device's clock, and invents none", () => {
    const now = new Date(2026, 10, 18, 10, 0);
    const resetsAt = new Date(2026, 10, 18, 15, 0).toISOString();
    const line = waitingLine(job({ reason: "agent_limit", words, since: "", nextTryAt: "", tries: 1, resetsAt }), now)!;
    expect(line.startsWith(`${words} It resets at `)).toBe(true);
    expect(line).toMatch(/3:00/);
    expect(waitingLine(job({ reason: "agent_limit", words, since: "", nextTryAt: "", tries: 1 }), now)).toBe(words);
  });
});
