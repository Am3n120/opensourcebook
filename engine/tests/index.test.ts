import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker entry", () => {
  it("answers the health check", async () => {
    const response = await worker.fetch(new Request("https://engine.test/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await worker.fetch(new Request("https://engine.test/nope"));
    expect(response.status).toBe(404);
  });
});
