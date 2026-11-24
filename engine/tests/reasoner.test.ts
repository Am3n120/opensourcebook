import { describe, expect, it } from "vitest";
import { MediaBudgetError, MediaCapabilityError } from "../src/providers/media";
import { StructuredReasoner } from "../src/providers/reasoner";
import type { StructuredProvider } from "../src/types";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("StructuredReasoner", () => {
  const provider = (answer: unknown): StructuredProvider & { calls: number } => ({
    name: "text-provider",
    calls: 0,
    async generateJSON<T>() {
      this.calls += 1;
      return answer as T;
    },
  });

  it("passes a text request through to the provider", async () => {
    const inner = provider({ ok: true });
    const reasoner = new StructuredReasoner(inner);
    expect(reasoner.name).toBe("text-provider");
    expect(reasoner.seesImages).toBe(false);
    expect(await reasoner.reasonJSON({ systemPrompt: "s", userPrompt: "u", task: "planning" }, {})).toEqual({ ok: true });
    expect(inner.calls).toBe(1);
  });

  it("refuses pictures, an empty budget and a cancelled job without calling", async () => {
    const inner = provider({});
    const reasoner = new StructuredReasoner(inner);
    await expect(reasoner.reasonJSON({ systemPrompt: "s", userPrompt: "u", images: [{ bytes: bytes("x"), contentType: "image/png" }] }, {})).rejects.toBeInstanceOf(MediaCapabilityError);
    await expect(reasoner.reasonJSON({ systemPrompt: "s", userPrompt: "u" }, { remainingUSD: () => 0 })).rejects.toBeInstanceOf(MediaBudgetError);
    const controller = new AbortController();
    controller.abort();
    await expect(reasoner.reasonJSON({ systemPrompt: "s", userPrompt: "u" }, { signal: controller.signal })).rejects.toThrow();
    expect(inner.calls).toBe(0);
  });
});
