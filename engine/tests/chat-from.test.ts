/** A message from the opensourcebook command tells the agent where the person is, so the reply points at commands, not at the app's card. */
import { expect, it } from "vitest";
import { agentPrompt } from "../src/chat/agent/prompt";
import type { AgentRequest } from "../src/chat/agent/tools";

const base = { sources: [], ticked: undefined, plans: [], history: [] };

it("a message from the terminal is said to be one, with the command to start a plan; one from the app says nothing of it", () => {
  const terminal = agentPrompt({ ...base, request: { text: "make a plan", mentions: [], from: "terminal" } as AgentRequest });
  expect(terminal).toContain("writing from a terminal");
  expect(terminal).toContain("opensourcebook plan start <plan id>");
  const app = agentPrompt({ ...base, request: { text: "make a plan", mentions: [] } as AgentRequest });
  expect(app).not.toContain("terminal");
});
