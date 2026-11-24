/**
 * No request waits on the makers' status once something was heard: a scenes service busy drawing a video answers its
 * status slowly, and every screen used to wait with it. Only the first request after a start waits, and many requests
 * at once ask the service once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the makers' status before a request", () => {
  it("is waited for only the first time, then looked at again in the background, once for many requests", async () => {
    const { refreshMakerStatusSoon } = await import("../src/wiring");
    const { forgetScenesStatus } = await import("../src/engines/video/scenes/client");
    forgetScenesStatus();
    let asked = 0;
    let answer: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        asked += 1;
        await new Promise<void>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ ok: true, styles: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const env = { SCENES_SERVICE_URL: "http://127.0.0.1:9", SCENES_SERVICE_TOKEN: "t" };
    const kept: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void kept.push(p), passThroughOnException: () => undefined };

    // The first request waits for the answer.
    let first = false;
    const firstDone = refreshMakerStatusSoon(env, ctx).then(() => (first = true));
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(first).toBe(false);
    answer!();
    await firstDone;

    // Later, with the status stale, requests go on at once, and the service is asked once for all of them.
    forgetScenesStatus();
    answer = undefined;
    await Promise.all([refreshMakerStatusSoon(env, ctx), refreshMakerStatusSoon(env, ctx), refreshMakerStatusSoon(env, ctx)]);
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(asked).toBe(2);
    answer!();
    await Promise.all(kept);
  });
});
