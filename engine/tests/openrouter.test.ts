import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter";
import type { FetchLike } from "../src/types";

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

describe("OpenRouter provider", () => {
  it("sends an OpenAI-shaped chat/completions request and parses fenced JSON", async () => {
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;
    const provider = new OpenRouterProvider({
      apiKey: "secret-key",
      model: "google/gemini-3.6-flash",
      fetchImpl: responseFetch({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }, (input, init) => {
        capturedURL = String(input);
        capturedInit = init;
      }),
    });
    await expect(provider.generateJSON<{ ok: boolean }>(request)).resolves.toEqual({ ok: true });
    expect(capturedURL).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(capturedInit?.body ?? "{}"));
    expect(body.model).toBe("google/gemini-3.6-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-key");
  });

  it("honors a custom baseURL and surfaces the HTTP status on failure", async () => {
    let capturedURL = "";
    const provider = new OpenRouterProvider({
      apiKey: "secret-key",
      baseURL: "https://openrouter.test/v1/",
      fetchImpl: async (input) => {
        capturedURL = String(input);
        return new Response("too many", { status: 429 });
      },
    });
    await expect(provider.generateJSON(request)).rejects.toMatchObject({ code: "UPSTREAM_HTTP", status: 429 });
    expect(capturedURL).toBe("https://openrouter.test/v1/chat/completions");
  });

  it("sends image bytes as a data-URI image_url part and parses the description", async () => {
    let captured: any;
    const provider = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch(
        { choices: [{ message: { content: '{"title":"Sunset","caption":"A sunset over the bay","textContent":"RE"}' } }] },
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
    expect(captured.response_format).toEqual({ type: "json_object" });
    const parts = captured.messages[1].content;
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("caption");
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${btoa("png-bytes")}`);
    expect(JSON.stringify(captured)).not.toContain("secret-key");
  });

  it("sends audio bytes as an input_audio part and parses the transcription", async () => {
    let captured: any;
    const provider = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch(
        { choices: [{ message: { content: '{"text":"hello world","language":"en"}' } }] },
        (_input, init) => {
          captured = JSON.parse(String(init?.body ?? "{}"));
        },
      ),
    });
    const bytes = new TextEncoder().encode("audio-bytes").buffer as ArrayBuffer;
    await expect(provider.transcribeAudio(bytes, "audio/mpeg")).resolves.toEqual({ text: "hello world", language: "en" });
    const parts = captured.messages[1].content;
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Transcribe");
    expect(parts[1].type).toBe("input_audio");
    expect(parts[1].input_audio.data).toBe(btoa("audio-bytes"));
    expect(parts[1].input_audio.format).toBe("mp3");
  });

  it("resolves undefined instead of throwing when media extraction fails", async () => {
    const bytes = new TextEncoder().encode("png-bytes").buffer as ArrayBuffer;
    const upstream = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    await expect(upstream.describeImage(bytes, "image/png")).resolves.toBeUndefined();

    const nonsense = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch({ choices: [{ message: { content: "not json at all" } }] }),
    });
    await expect(nonsense.transcribeAudio(bytes, "audio/mpeg")).resolves.toBeUndefined();

    const unconfigured = new OpenRouterProvider();
    await expect(unconfigured.describeImage(bytes, "image/png")).resolves.toBeUndefined();

    let called = false;
    const empty = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: async (input, init) => {
        called = true;
        return responseFetch({})(input, init);
      },
    });
    await expect(empty.describeImage(new ArrayBuffer(0), "image/png")).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("sends YouTube understanding as a video_url part", async () => {
    let capturedInit: RequestInit | undefined;
    const provider = new OpenRouterProvider({
      apiKey: "secret-key",
      fetchImpl: responseFetch({ choices: [{ message: { content: '{"title":"t"}' } }] }, (_input, init) => {
        capturedInit = init;
      }),
    });
    await expect(provider.generateYouTubeJSON<{ title: string }>({ ...request, youtubeURL: "https://www.youtube.com/watch?v=abc123" })).resolves.toEqual({ title: "t" });
    const body = JSON.parse(String(capturedInit?.body ?? "{}"));
    const parts = body.messages[1].content;
    expect(parts[0]).toEqual({ type: "video_url", video_url: { url: "https://www.youtube.com/watch?v=abc123" } });
    expect(parts[1]).toEqual({ type: "text", text: request.userPrompt });
  });
});
