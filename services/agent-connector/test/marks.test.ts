/** The logos the picker shows: each agent's own and each model maker's, told from the adapter or the model's name. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter } from "../src/agents/claude.ts";
import { MAKERS, makerOf, marks, marksOf, type Mark } from "../src/agents/marks.ts";
import { createDefaultAgents } from "../src/agents/registry.ts";
import { openCodeAdapter, readOpenCodeModels } from "../src/agents/opencode.ts";

test("each mark is one path of drawing commands in a 24 box, with a brand colour or the text's", () => {
  for (const [name, mark] of Object.entries(marks) as Array<[string, Mark]>) {
    assert.match(mark.path, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, name);
    if (mark.color !== undefined) assert.match(mark.color, /^#[0-9A-F]{6}$/, name);
  }
  assert.equal(new Set(MAKERS.map((maker) => maker.id)).size, MAKERS.length);
});

test("every registered agent brings a logo the engine takes: plain drawing commands, a #rrggbb colour or none", () => {
  for (const agent of createDefaultAgents().list()) {
    assert.ok(agent.mark, agent.id);
    // The engine's own check (engine/src/chat/agent/connector.ts, markOf).
    assert.ok(agent.mark.path.length <= 6_000, agent.id);
    assert.match(agent.mark.path, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, agent.id);
    if (agent.mark.color !== undefined) assert.match(agent.mark.color, /^#[0-9a-f]{6}$/i, agent.id);
  }
});

test("every agent shows its brand's own mark, never a tile of initials", () => {
  const byId = Object.fromEntries(createDefaultAgents().list().map((agent) => [agent.id, agent.mark]));
  assert.equal(byId.cursor, marks.cursor);
  assert.equal(byId.copilot, marks.githubcopilot);
  // The Google agent carries Antigravity's own mark, in the text's colour; its models carry Google's Gemini spark.
  assert.equal(byId.antigravity, marks.antigravity);
  assert.equal((marks.antigravity as Mark).color, undefined);
  assert.notEqual(marks.antigravity.path, marks.gemini.path);
  // A tile was a rounded frame drawn with its letters as bars; no mark is one now.
  for (const [name, mark] of Object.entries(marks) as Array<[string, Mark]>) assert.ok(!mark.path.startsWith("M5 2H19A3 3 0 0 1 22 5V19"), name);
});

test("a model's maker is told from its id or name, whoever hosts it", () => {
  const maker = (name: string) => makerOf(readOpenCodeModels([name])[0]!)?.id;
  assert.equal(maker("anthropic/claude-sonnet-4-5"), "anthropic");
  assert.equal(maker("github-copilot/claude-opus-4"), "anthropic");
  assert.equal(maker("openai/gpt-5"), "openai");
  assert.equal(maker("openai/o3-mini"), "openai");
  assert.equal(maker("groq/gpt-oss-120b"), "openai");
  assert.equal(maker("google/gemini-2.5-pro"), "google");
  assert.equal(maker("opencode/kimi-k2"), "moonshot");
  assert.equal(maker("deepseek/deepseek-chat"), "deepseek");
  assert.equal(maker("groq/llama-3.3-70b"), "meta");
  assert.equal(maker("mistral/devstral-medium"), "mistral");
  assert.equal(maker("opencode/qwen3-coder"), "alibaba");
  assert.equal(maker("opencode/big-pickle"), undefined);
});

test("status gets the agent's mark, each model's maker once named, and those makers' marks", () => {
  const claude = claudeAdapter();
  const said = marksOf(claude, claude.models);
  assert.equal(said.mark, marks.claude);
  assert.ok(said.models!.every((model) => model.maker === "anthropic"));
  assert.deepEqual(Object.keys(said.makers!), ["anthropic"]);
  assert.deepEqual(said.makers!.anthropic, { label: "Anthropic", mark: marks.anthropic });

  const open = marksOf(openCodeAdapter(), readOpenCodeModels(["opencode/big-pickle", "opencode/grok-code", "anthropic/claude-haiku-4-5", "openai/gpt-5"]));
  assert.deepEqual(open.models!.map((model) => model.maker), [undefined, undefined, "anthropic", "openai"]);
  assert.deepEqual(Object.keys(open.makers!).sort(), ["anthropic", "openai"]);

  assert.deepEqual(marksOf({}, [{ id: "big", label: "Big" }]), { models: [{ id: "big", label: "Big" }] });
  assert.deepEqual(marksOf({}, undefined), {});
  // A maker the adapter names that is not one of Open Sourcebook's is told from the name instead.
  assert.equal(marksOf({ maker: "nobody" }, [{ id: "gpt-5", label: "GPT-5" }]).models![0]!.maker, "openai");
});
