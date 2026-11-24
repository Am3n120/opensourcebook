/**
 * The worker prices byte and quiz cost estimates for the model that writes
 * them, from the price table (providers/prices.ts). A model the table does
 * not list gives an estimate flagged unpriced, never $0.
 */
import { describe, expect, it } from "vitest";
import { MODEL_PRICES } from "../src/providers/prices";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { WorkerEnv } from "../src/types";
import { writingModel, writingModelPrice } from "../src/wiring";

const byteInput = { settings: { depth: "light", exemplarSummaries: [] }, sourceChars: 4_000, sourceCount: 1 };
const quizInput = { settings: { questions: 10, kinds: ["choice"], difficulty: "auto", passMark: 70, feedback: "afterEach" }, sourceChars: 12_000, sourceCount: 1 };

function estimates(env: Partial<WorkerEnv>) {
  const price = writingModelPrice(env as WorkerEnv, new Date("2026-11-12T00:00:00Z"));
  const registry = createDefaultRegistry({ flashcards: price ? { price } : {}, quiz: price ? { price } : {} });
  return { byte: registry.require("byte").estimateCost(byteInput), quiz: registry.require("quiz").estimateCost(quizInput) };
}

describe("cost estimates in the worker", () => {
  it("pick the model that writes text the way the provider set-up does", () => {
    const keys = { GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o", GEMINI_MODEL: "gemini-3.6-flash", DEEPSEEK_MODEL: "deepseek-v4-flash", OPENROUTER_MODEL: "google/gemini-3.6-flash" };
    expect(writingModel({ ...keys, GENERATION_PROVIDER: "router" } as WorkerEnv)).toBe("deepseek-v4-flash");
    expect(writingModel({ ...keys, GENERATION_PROVIDER: "gemini" } as WorkerEnv)).toBe("gemini-3.6-flash");
    expect(writingModel({ OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "google/gemini-3.6-flash", GENERATION_PROVIDER: "router" } as WorkerEnv)).toBe("google/gemini-3.6-flash");
    expect(writingModel({} as WorkerEnv)).toBeUndefined();
  });

  it("are a non-zero number for a priced model", () => {
    expect(MODEL_PRICES["deepseek-v4-flash"]).toBeDefined();
    const { byte, quiz } = estimates({ DEEPSEEK_API_KEY: "d", DEEPSEEK_MODEL: "deepseek-v4-flash", GENERATION_PROVIDER: "router" });
    for (const estimate of [byte, quiz]) {
      expect(estimate.usd).toBeGreaterThan(0);
      expect(estimate.unpriced).toBeUndefined();
      expect(estimate.basis).not.toContain("no model price set");
    }
  });

  it("are flagged unpriced, not $0, for a model the table does not list", () => {
    const { byte, quiz } = estimates({ DEEPSEEK_API_KEY: "d", DEEPSEEK_MODEL: "a-model-nobody-priced", GENERATION_PROVIDER: "router" });
    for (const estimate of [byte, quiz]) {
      expect(estimate.usd).toBeUndefined();
      expect(estimate.unpriced).toBe(true);
      expect(estimate.basis).toContain("no model price set");
    }
  });
});
