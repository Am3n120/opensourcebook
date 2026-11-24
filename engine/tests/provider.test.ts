import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/providers/gemini";
import { DeepSeekProvider } from "../src/providers/deepseek";
import { ProviderRouter } from "../src/providers/router";
import type {
  AudioTranscribingProvider,
  AudioTranscription,
  FetchLike,
  ImageDescribingProvider,
  ImageDescription,
  StructuredGenerationRequest,
  StructuredProvider,
  UsageEvent,
} from "../src/types";

const request = {
  systemPrompt: "JSON only",
  userPrompt: "Return {ok:true}",
};

function responseFetch(body: unknown, inspect?: (input: RequestInfo | URL, init?: RequestInit) => void): FetchLike {
  return async (input, init) => {
    inspect?.(input, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("provider adapters", () => {
  it("maps Gemini JSON output and sends no secret in the body", async () => {
    let captured = "";
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch({ candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }] }, (_input, init) => {
        captured = String(init?.body ?? "");
      }),
    });
    await expect(provider.generateJSON<{ ok: boolean }>(request)).resolves.toEqual({ ok: true });
    expect(captured).not.toContain("secret-key");
  });

  it("maps DeepSeek JSON output", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch({ choices: [{ message: { content: '{"ok":true}' } }] }),
    });
    await expect(provider.generateJSON<{ ok: boolean }>(request)).resolves.toEqual({ ok: true });
  });

  it("records a call it stopped waiting for as a timeout, and an HTTP failure as http", async () => {
    const events: UsageEvent[] = [];
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const slow = new DeepSeekProvider({ apiKey: "k", fetchImpl: hang, timeoutMs: 5, usageSink: { record: (event) => void events.push(event) } });
    await expect(slow.generateJSON(request)).rejects.toThrow("DeepSeek request timed out");
    const refused = new DeepSeekProvider({ apiKey: "k", fetchImpl: async () => new Response("no", { status: 500 }), usageSink: { record: (event) => void events.push(event) } });
    await expect(refused.generateJSON(request)).rejects.toThrow();
    expect(events.map((event) => [event.ok, event.error, event.usd])).toEqual([
      [false, "timeout", undefined],
      [false, "http", undefined],
    ]);
  });

  it("routes content access to Gemini and planning/repair to DeepSeek", async () => {
    const calls: string[] = [];
    const provider = (name: string): StructuredProvider => ({
      name,
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push(name);
        return { ok: true } as T;
      },
    });
    const router = new ProviderRouter({ gemini: provider("gemini"), deepseek: provider("deepseek") });
    await router.generateJSON({ ...request, task: "research" });
    await router.generateJSON({ ...request, task: "repair" });
    await router.generateJSON({ ...request, depth: "veryDeep" });
    expect(calls).toEqual(["gemini", "deepseek", "gemini"]);
  });

  it("fails clearly when a provider key is absent", async () => {
    await expect(new GeminiProvider().generateJSON(request)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(new DeepSeekProvider().generateJSON(request)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("uses DeepSeek as the default text engine and falls back to Gemini on 429", async () => {
    const calls: string[] = [];
    const flakyDeepSeek: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        const error = new Error("DeepSeek request failed (429)") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };
    const healthyGemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: healthyGemini, deepseek: flakyDeepSeek });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["deepseek", "gemini"]);
  });

  it("falls back to Gemini when DeepSeek stalls and times out", async () => {
    const calls: string[] = [];
    const stalledDeepSeek: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        const error = new Error("DeepSeek request timed out") as Error & { code: string };
        error.code = "NETWORK";
        throw error;
      },
    };
    const healthyGemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: healthyGemini, deepseek: stalledDeepSeek });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "repair" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["deepseek", "gemini"]);
  });

  it("skips a rate-limited provider during its cooldown window instead of re-hitting it", async () => {
    const calls: string[] = [];
    let deepseekFailures = 0;
    const flakyDeepSeek: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        deepseekFailures += 1;
        const error = new Error("DeepSeek request failed (429)") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };
    const healthyGemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: healthyGemini, deepseek: flakyDeepSeek, rateLimitCooldownMs: 60_000 });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    // First call: deepseek 429 → cooldown set → gemini serves. Second call:
    // deepseek is inside its window and is skipped outright.
    expect(calls).toEqual(["deepseek", "gemini", "gemini"]);
    expect(deepseekFailures).toBe(1);
  });

  it("tries a cooling provider again once its window expires", async () => {
    const calls: string[] = [];
    let fail = true;
    const recoveringDeepSeek: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        if (fail) {
          const error = new Error("DeepSeek request failed (429)") as Error & { status: number };
          error.status = 429;
          throw error;
        }
        return { ok: true } as T;
      },
    };
    const healthyGemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: healthyGemini, deepseek: recoveringDeepSeek, rateLimitCooldownMs: 5 });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail = false;
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["deepseek", "gemini", "deepseek"]);
  });

  it("falls back to DeepSeek when grounded research hits a Gemini 429", async () => {
    const calls: string[] = [];
    const rateLimitedGemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateGroundedJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini-grounded");
        const error = new Error("Gemini request failed (429)") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };
    const textEngine: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: rateLimitedGemini, deepseek: textEngine });
    await expect(router.generateGroundedJSON<{ ok: boolean }>({ ...request, task: "research" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["gemini-grounded", "deepseek"]);
  });

  it("does not retry text tasks on the other provider for non-rate-limit errors", async () => {
    const calls: string[] = [];
    const broken: StructuredProvider = {
      name: "deepseek",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("deepseek");
        throw new Error("Provider returned invalid JSON");
      },
    };
    const other: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ gemini: other, deepseek: broken });
    await expect(router.generateJSON({ ...request, task: "section" })).rejects.toThrow("invalid JSON");
    expect(calls).toEqual(["deepseek"]);
  });

  it("sends image bytes as inlineData and parses the description", async () => {
    let captured: any;
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch(
        { candidates: [{ content: { parts: [{ text: '{"title":"Sunset","caption":"A sunset over the bay","textContent":"RE"}' }] } }] },
        (_input, init) => {
          captured = JSON.parse(String(init?.body ?? "{}"));
        },
      ),
    });
    const bytes = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;
    await expect(provider.describeImage(bytes, "image/png")).resolves.toEqual({
      title: "Sunset",
      caption: "A sunset over the bay",
      textContent: "RE",
    });
    const parts = captured.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[0].inlineData.data).toBe(btoa("png-bytes"));
    expect(parts[1].text).toContain("caption");
    expect(JSON.stringify(captured)).not.toContain("secret-key");
  });

  it("sends audio bytes as inlineData and parses the transcription", async () => {
    let captured: any;
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch(
        { candidates: [{ content: { parts: [{ text: '{"text":"hello world","language":"en"}' }] } }] },
        (_input, init) => {
          captured = JSON.parse(String(init?.body ?? "{}"));
        },
      ),
    });
    const bytes = new TextEncoder().encode("audio-bytes").buffer as ArrayBuffer;
    await expect(provider.transcribeAudio(bytes, "audio/mpeg")).resolves.toEqual({ text: "hello world", language: "en" });
    const parts = captured.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe("audio/mpeg");
    expect(parts[0].inlineData.data).toBe(btoa("audio-bytes"));
    expect(parts[1].text).toContain("Transcribe");
  });

  it("resolves undefined instead of throwing when media extraction fails", async () => {
    const bytes = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;
    const upstream = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    await expect(upstream.describeImage(bytes, "image/png")).resolves.toBeUndefined();

    const nonsense = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch({ candidates: [{ content: { parts: [{ text: "not json at all" }] } }] }),
    });
    await expect(nonsense.transcribeAudio(bytes, "audio/mpeg")).resolves.toBeUndefined();

    const unconfigured = new GeminiProvider();
    await expect(unconfigured.describeImage(bytes, "image/png")).resolves.toBeUndefined();

    let called = false;
    const empty = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: async (input, init) => {
        called = true;
        return responseFetch({})(input, init);
      },
    });
    await expect(empty.describeImage(new ArrayBuffer(0), "image/png")).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("provider router with OpenRouter", () => {
  const healthy = (name: string, calls: string[]): StructuredProvider => ({
    name,
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      calls.push(name);
      return { ok: true } as T;
    },
  });
  const rateLimited = (name: string, calls: string[]): StructuredProvider => ({
    name,
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      calls.push(name);
      const error = new Error(`${name} request failed (429)`) as Error & { status: number };
      error.status = 429;
      throw error;
    },
  });

  it("orders text tasks deepseek → openrouter → gemini", async () => {
    const calls: string[] = [];
    const router = new ProviderRouter({
      deepseek: rateLimited("deepseek", calls),
      openrouter: rateLimited("openrouter", calls),
      gemini: healthy("gemini", calls),
    });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["deepseek", "openrouter", "gemini"]);
  }, 20_000);

  it("routes research, longContext, and veryDeep to openrouter first", async () => {
    const calls: string[] = [];
    const router = new ProviderRouter({
      deepseek: healthy("deepseek", calls),
      openrouter: healthy("openrouter", calls),
      gemini: healthy("gemini", calls),
    });
    await router.generateJSON({ ...request, task: "research" });
    await router.generateJSON({ ...request, task: "longContext" });
    await router.generateJSON({ ...request, depth: "veryDeep" });
    expect(calls).toEqual(["openrouter", "openrouter", "openrouter"]);
  });

  it("falls back to gemini when openrouter is rate-limited on research", async () => {
    const calls: string[] = [];
    const router = new ProviderRouter({
      deepseek: healthy("deepseek", calls),
      openrouter: rateLimited("openrouter", calls),
      gemini: healthy("gemini", calls),
    });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "research" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["openrouter", "gemini"]);
  });

  it("skips a cooling deepseek and hits openrouter next", async () => {
    const calls: string[] = [];
    const router = new ProviderRouter({
      deepseek: rateLimited("deepseek", calls),
      openrouter: healthy("openrouter", calls),
      gemini: healthy("gemini", calls),
      rateLimitCooldownMs: 60_000,
    });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    await expect(router.generateJSON<{ ok: boolean }>({ ...request, task: "section" })).resolves.toEqual({ ok: true });
    // First call: deepseek 429 → cooldown set → openrouter serves. Second
    // call: deepseek is inside its window and openrouter is hit directly.
    expect(calls).toEqual(["deepseek", "openrouter", "openrouter"]);
  });

  it("serves grounded research from openrouter when it is healthy", async () => {
    const calls: string[] = [];
    const gemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateGroundedJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini-grounded");
        return { ok: true } as T;
      },
    };
    const router = new ProviderRouter({ openrouter: healthy("openrouter", calls), gemini, deepseek: healthy("deepseek", calls) });
    await expect(router.generateGroundedJSON<{ ok: boolean }>({ ...request, task: "research" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["openrouter"]);
  });

  it("falls through grounded research openrouter → gemini grounded → deepseek", async () => {
    const calls: string[] = [];
    const gemini: StructuredProvider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateGroundedJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
        calls.push("gemini-grounded");
        const error = new Error("Gemini request failed (429)") as Error & { status: number };
        error.status = 429;
        throw error;
      },
    };
    const router = new ProviderRouter({ openrouter: rateLimited("openrouter", calls), gemini, deepseek: healthy("deepseek", calls) });
    await expect(router.generateGroundedJSON<{ ok: boolean }>({ ...request, task: "research" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["openrouter", "gemini-grounded", "deepseek"]);
  });

  it("prefers openrouter for media and falls back to gemini, then undefined", async () => {
    const bytes = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;
    const calls: string[] = [];
    const withVision = (name: string, result?: ImageDescription): ImageDescribingProvider => ({
      name,
      async generateJSON<T>(): Promise<T> {
        return {} as T;
      },
      describeImage: async () => {
        calls.push(name);
        return result;
      },
    });
    const router = new ProviderRouter({
      openrouter: withVision("openrouter", { caption: "from openrouter" }),
      gemini: withVision("gemini", { caption: "from gemini" }),
    });
    await expect(router.describeImage(bytes, "image/png")).resolves.toEqual({ caption: "from openrouter" });
    expect(calls).toEqual(["openrouter"]);

    // OpenRouter has no caption → Gemini is the last-resort fallback.
    const fallback = new ProviderRouter({
      openrouter: withVision("openrouter", undefined),
      gemini: withVision("gemini", { caption: "from gemini" }),
    });
    await expect(fallback.describeImage(bytes, "image/png")).resolves.toEqual({ caption: "from gemini" });
    expect(calls).toEqual(["openrouter", "openrouter", "gemini"]);

    // Neither provider carries the extension → undefined, structurally checked.
    const textOnly = (name: string): StructuredProvider => ({
      name,
      async generateJSON<T>(): Promise<T> {
        return {} as T;
      },
    });
    const blind = new ProviderRouter({ openrouter: textOnly("openrouter"), gemini: textOnly("gemini") });
    await expect(blind.describeImage(bytes, "image/png")).resolves.toBeUndefined();
    await expect(blind.transcribeAudio(bytes, "audio/mpeg")).resolves.toBeUndefined();
  });

  it("passes audio transcription through openrouter first", async () => {
    const bytes = new TextEncoder().encode("audio-bytes").buffer as ArrayBuffer;
    const calls: string[] = [];
    const withTranscription = (name: string, result?: AudioTranscription): AudioTranscribingProvider => ({
      name,
      async generateJSON<T>(): Promise<T> {
        return {} as T;
      },
      transcribeAudio: async () => {
        calls.push(name);
        return result;
      },
    });
    const router = new ProviderRouter({
      openrouter: withTranscription("openrouter", { text: "hello", language: "en" }),
      gemini: withTranscription("gemini", { text: "gemini transcript" }),
    });
    await expect(router.transcribeAudio(bytes, "audio/mpeg")).resolves.toEqual({ text: "hello", language: "en" });
    expect(calls).toEqual(["openrouter"]);
  });
});

describe("YouTube routing", () => {
  const ytRequest = { systemPrompt: "JSON only", userPrompt: "Return {}", youtubeURL: "https://www.youtube.com/watch?v=abc123" };
  function withVideo(name: string, fail?: boolean): StructuredProvider {
    return {
      name,
      async generateJSON<T>(): Promise<T> { throw new Error("not used"); },
      async generateYouTubeJSON<T>(): Promise<T> {
        if (fail) {
          const error = new Error(`${name} failed (429)`) as Error & { status: number };
          error.status = 429;
          throw error;
        }
        return { by: name } as T;
      },
    };
  }

  it("prefers OpenRouter for video, falling back to Gemini on failure", async () => {
    const router = new ProviderRouter({ openrouter: withVideo("openrouter"), gemini: withVideo("gemini") });
    await expect(router.generateYouTubeJSON<{ by: string }>(ytRequest)).resolves.toEqual({ by: "openrouter" });

    const failing = new ProviderRouter({ openrouter: withVideo("openrouter", true), gemini: withVideo("gemini") });
    await expect(failing.generateYouTubeJSON<{ by: string }>(ytRequest)).resolves.toEqual({ by: "gemini" });
  });

  it("still throws the routing error when no video provider exists", async () => {
    const router = new ProviderRouter({});
    await expect(router.generateYouTubeJSON(ytRequest)).rejects.toMatchObject({ code: "GEMINI_VIDEO_UNAVAILABLE" });
  });
});

describe("provider JSON salvage parsing", () => {
  it("rescues prose-wrapped JSON in both providers' parsers", async () => {
    const { parseDeepSeekJSON } = await import("../src/providers/deepseek");
    const { parseOpenRouterJSON } = await import("../src/providers/openrouter");
    const wrapped = 'Here is the JSON you asked for:\n{"ok": true, "n": 2}\nHope this helps!';
    expect(parseDeepSeekJSON<{ ok: boolean; n: number }>(wrapped)).toEqual({ ok: true, n: 2 });
    expect(parseOpenRouterJSON<{ ok: boolean; n: number }>(wrapped)).toEqual({ ok: true, n: 2 });
  });

  it("still rejects genuinely invalid JSON", async () => {
    const { parseDeepSeekJSON } = await import("../src/providers/deepseek");
    expect(() => parseDeepSeekJSON("not json at all")).toThrow(/invalid JSON/i);
  });
});
