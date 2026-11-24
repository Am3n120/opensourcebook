/**
 * A model account that is out of credit (402) or whose key is refused
 * (401, 403) fails once, in plain words: no retry inside an engine, no
 * provider fallback wait, no queue redelivery; the chat reply and the job's
 * failure reason say what happened without the key or vendor jargon.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { withRetry } from "../src/engines/retry";
import { accountProblem, accountRefusal, isFinalProviderError } from "../src/net";
import { DeepSeekProviderError } from "../src/providers/deepseek";
import { OpenRouterProviderError } from "../src/providers/openrouter";
import { createProviderRouter } from "../src/providers/router";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { PlanRunner } from "../src/studio/plan-runner";
import type { StructuredProvider } from "../src/types";
import { handleRequest } from "../src/index";
import { CLIENT_TOKEN, FakeExtractor, authed, bodyOf, createTestEngine } from "./support/engine-harness";

const outOfCredit = () => new DeepSeekProviderError("DeepSeek request failed (402)", "UPSTREAM_HTTP", 402);
const TEXT = "Sunlight holds every colour. Air molecules scatter short wavelengths, such as blue, far more strongly than long ones.";

describe("account errors", () => {
  it("say what happened in plain words, naming only the provider", () => {
    expect(accountProblem(outOfCredit())).toBe("The DeepSeek account is out of credit, so no model could be called. Add credit or set another provider, then try again.");
    expect(accountProblem(new OpenRouterProviderError("OpenRouter request failed (401)", "UPSTREAM_HTTP", 401))).toBe(
      "The OpenRouter key was refused, so no model could be called. Check the key, then try again.",
    );
    expect(accountProblem(new DeepSeekProviderError("DeepSeek request failed (429)", "UPSTREAM_HTTP", 429))).toBeUndefined();
    expect([402, 401, 403, 429].map((status) => accountRefusal(new DeepSeekProviderError("x", "UPSTREAM_HTTP", status)))).toEqual(["outOfCredit", "keyRefused", "keyRefused", undefined]);
    expect(isFinalProviderError(new DeepSeekProviderError("x", "UPSTREAM_HTTP", 403))).toBe(true);
    expect(isFinalProviderError(new DeepSeekProviderError("x", "UPSTREAM_HTTP", 503))).toBe(false);
  });

  it("are not retried by an engine step", async () => {
    let attempts = 0;
    const slept: number[] = [];
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw outOfCredit();
        },
        { maxAttempts: 3, sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toMatchObject({ status: 402 });
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  it("are not waited out or passed along by the provider router", async () => {
    const tried: string[] = [];
    const failing = (name: string, error: Error): StructuredProvider => ({
      name,
      async generateJSON() {
        tried.push(name);
        throw error;
      },
    });
    const router = createProviderRouter({ deepseek: failing("deepseek", outOfCredit()), openrouter: failing("openrouter", new Error("unused")) });
    const started = Date.now();
    await expect(router.generateJSON({ systemPrompt: "s", userPrompt: "u", task: "planning" })).rejects.toMatchObject({ status: 402 });
    expect(tried).toEqual(["deepseek"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("end a chat reply with what happened, once", async () => {
    let calls = 0;
    const engine = createTestEngine({
      answer: () => {
        calls += 1;
        throw outOfCredit();
      },
    });
    const call = async (path: string, method = "GET", body?: unknown) => bodyOf(await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps));
    const project = (await call("/v1/projects", "POST", { title: "Light" })).project;
    await call("/v1/sources", "POST", { text: TEXT, projectId: project.id });
    const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).chat;
    const sent = await call(`/v1/chats/${chat.id}/messages`, "POST", { text: "Why is the sky blue?" });
    expect(sent.messages[1].text).toBe("I couldn't write a reply. The DeepSeek account is out of credit, so no model could be called. Add credit or set another provider, then try again.");
    expect(sent.messages[1].failed).toEqual({ reason: "outOfCredit" });
    expect(calls).toBe(1);
  });

  it("fail a plan's job once, not retryable, with the reason in plain words", async () => {
    const url = "https://example.test/sky";
    const extractor = new FakeExtractor({ [url]: { text: TEXT, title: "Sky colour notes", kind: "web" } });
    const registry = createDefaultRegistry();
    let calls = 0;
    const engine = createTestEngine({
      registry,
      extractor,
      answer: () => {
        calls += 1;
        throw outOfCredit();
      },
    });
    const { repos } = engine.deps;
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const project = await repos.projects.create({ ownerId, title: "Light" });
    const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, url });
    const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Sky" });
    const node = await repos.plans.addNode({ planId: plan.id, ord: 0, level: 0, type: "byte", title: "Sky", prompt: "Why the sky is blue." });
    await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    const queue: string[] = [];
    const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
    engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
    await repos.plans.setStatus(plan.id, "approved");
    await runner.kickOff(plan.id);
    const jobId = queue.shift()!;
    // Acked, not handed back to the queue for redelivery.
    expect(await engine.deliver(jobId)).toBe("ack");
    expect(calls).toBe(1);
    expect(await engine.deps.jobs.get(jobId)).toMatchObject({
      status: "failed",
      retryable: false,
      errorMessage: "The DeepSeek account is out of credit, so no model could be called. Add credit or set another provider, then try again.",
    });
    expect(queue).toEqual([]);
    // The plan view carries the reason on the failed item itself, in words about the item.
    engine.deps.plans = runner;
    const view = await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}`), engine.deps));
    expect(view.items[0]).toMatchObject({
      status: "failed",
      errorMessage: "The model account is out of credit, so this set of flashcards was not made. Add credit, then try again.",
    });
    const progress = await bodyOf(await handleRequest(authed(`/v1/plans/${plan.id}/progress`), engine.deps));
    expect(progress.items[0].job).toMatchObject({
      errorMessage: "The model account is out of credit, so this set of flashcards was not made. Add credit, then try again.",
      errorDetail: "The DeepSeek account is out of credit, so no model could be called. Add credit or set another provider, then try again.",
    });
  });
});
