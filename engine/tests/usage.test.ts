import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../src/providers/deepseek";
import { GeminiProvider } from "../src/providers/gemini";
import { OpenRouterProvider } from "../src/providers/openrouter";
import { InMemoryUsageSink, SettlingUsageSink, estimateUSD, safeRecord, tokensFromGeminiUsage, tokensFromOpenAIUsage } from "../src/providers/usage";
import type { FetchLike } from "../src/types";

const request = { systemPrompt: "JSON only", userPrompt: "Return {ok:true}", task: "section" as const };

function jsonFetch(body: unknown, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("usage accounting", () => {
  it("estimates USD from token counts and a per-million price", () => {
    expect(estimateUSD({ inputPerMillion: 1, outputPerMillion: 2 }, 1_000_000, 500_000)).toBe(2);
    expect(estimateUSD(undefined, 10, 10)).toBeUndefined();
    expect(estimateUSD({ inputPerMillion: 1, outputPerMillion: 2 }, undefined, 10)).toBeUndefined();
  });

  it("reads token counts from OpenAI- and Gemini-shaped usage objects", () => {
    expect(tokensFromOpenAIUsage({ prompt_tokens: 12, completion_tokens: 34 })).toEqual({ tokensIn: 12, tokensOut: 34 });
    expect(tokensFromGeminiUsage({ promptTokenCount: 5, candidatesTokenCount: 6 })).toEqual({ tokensIn: 5, tokensOut: 6 });
    expect(tokensFromOpenAIUsage(undefined)).toEqual({});
  });

  it("DeepSeek reports one event per call with tokens, task and cost", async () => {
    const sink = new InMemoryUsageSink();
    const provider = new DeepSeekProvider({
      apiKey: "k",
      model: "deepseek-chat",
      prices: { "deepseek-chat": { inputPerMillion: 0.5, outputPerMillion: 1.5 } },
      usageSink: sink,
      fetchImpl: jsonFetch({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }),
    });
    await provider.generateJSON(request);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ provider: "deepseek", model: "deepseek-chat", task: "section", tokensIn: 1_000_000, tokensOut: 1_000_000, usd: 2, ok: true });
    expect(sink.totalUSD()).toBe(2);
  });

  it("OpenRouter and Gemini report failed calls too, without a cost when tokens are unknown", async () => {
    const sink = new InMemoryUsageSink();
    const openrouter = new OpenRouterProvider({ apiKey: "k", usageSink: sink, fetchImpl: jsonFetch({ error: { message: "nope" } }, 500) });
    await expect(openrouter.generateJSON(request)).rejects.toMatchObject({ code: "UPSTREAM_HTTP" });
    const gemini = new GeminiProvider({
      apiKey: "k",
      usageSink: sink,
      fetchImpl: jsonFetch({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }),
    });
    await gemini.generateJSON(request);
    expect(sink.events.map((event) => [event.provider, event.ok, event.usd])).toEqual([
      ["openrouter", false, undefined],
      ["gemini", true, undefined],
    ]);
    expect(sink.events[1]).toMatchObject({ tokensIn: 3, tokensOut: 4 });
  });

  it("a throwing sink never fails the generation", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "k",
      usageSink: { record() { throw new Error("sink down"); } },
      fetchImpl: jsonFetch({ choices: [{ message: { content: '{"ok":true}' } }] }),
    });
    await expect(provider.generateJSON(request)).resolves.toEqual({ ok: true });
  });
});

describe("SettlingUsageSink", () => {
  it("waits for writes still in flight, failed ones included", async () => {
    const written: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const sink = new SettlingUsageSink({
      async record(event) {
        if (event.model === "slow") await slow;
        if (event.model === "broken") throw new Error("write failed");
        written.push(event.model);
      },
    });
    const event = { provider: "p", latencyMs: 1, ok: true };
    safeRecord(sink, { ...event, model: "slow" });
    safeRecord(sink, { ...event, model: "broken" });
    safeRecord(sink, { ...event, model: "fast" });
    let settled = false;
    const waiting = sink.settled().then(() => void (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(written.sort()).toEqual(["fast", "slow"]);
  });
});
