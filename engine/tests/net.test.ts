import { describe, expect, it } from "vitest";
import {
  boundedFetch,
  hostname,
  isHTTPURL,
  isRateLimitError,
  isRateLimitOrServerError,
  isRecord,
  isTimeoutOrNetworkError,
  withRateLimitRetry,
} from "../src/net";

describe("URL helpers", () => {
  it("accepts only http(s) URLs", () => {
    expect(isHTTPURL("https://example.com/a")).toBe(true);
    expect(isHTTPURL("http://example.com")).toBe(true);
    expect(isHTTPURL("ftp://example.com")).toBe(false);
    expect(isHTTPURL("not a url")).toBe(false);
  });

  it("returns the hostname or undefined", () => {
    expect(hostname("https://www.example.com/x?y=1")).toBe("www.example.com");
    expect(hostname("nope")).toBeUndefined();
    expect(hostname(undefined)).toBeUndefined();
  });

  it("recognizes plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("boundedFetch", () => {
  it("returns the response when the fetch succeeds", async () => {
    const response = await boundedFetch("https://x.test", async () => new Response("ok"), {}, 1_000);
    expect(await response?.text()).toBe("ok");
  });

  it("returns undefined on failure or timeout", async () => {
    const failed = await boundedFetch(
      "https://x.test",
      async () => {
        throw new Error("boom");
      },
      {},
      1_000,
    );
    expect(failed).toBeUndefined();

    const slow = await boundedFetch(
      "https://x.test",
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      {},
      5,
    );
    expect(slow).toBeUndefined();
  });
});

describe("error classification", () => {
  it("separates rate limits from server errors", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error("quota exceeded"))).toBe(true);
    expect(isRateLimitError({ status: 503 })).toBe(false);
    expect(isRateLimitOrServerError({ status: 503 })).toBe(true);
    expect(isRateLimitOrServerError(new Error("model overloaded"))).toBe(true);
    expect(isRateLimitOrServerError({ status: 400 })).toBe(false);
    expect(isRateLimitOrServerError("string")).toBe(false);
  });

  it("recognizes timeouts and network codes", () => {
    expect(isTimeoutOrNetworkError({ code: "NETWORK" })).toBe(true);
    expect(isTimeoutOrNetworkError(new Error("request timed out"))).toBe(true);
    expect(isTimeoutOrNetworkError(new Error("bad json"))).toBe(false);
  });
});

describe("withRateLimitRetry", () => {
  it("retries rate-limited calls on the given schedule and then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
        return "done";
      },
      [10, 20],
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("done");
    expect(waits).toEqual([10, 20]);
  });

  it("does not retry non-rate-limit errors", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("invalid json");
        },
        [10],
        async () => {},
      ),
    ).rejects.toThrow("invalid json");
    expect(calls).toBe(1);
  });

  it("gives up after the schedule is exhausted", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("quota"), { status: 429 });
        },
        [1, 1],
        async () => {},
      ),
    ).rejects.toThrow("quota");
    expect(calls).toBe(3);
  });
});
