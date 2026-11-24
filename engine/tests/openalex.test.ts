import { describe, expect, it } from "vitest";
import { OpenAlexProvider } from "../src/providers/openalex";
import type { FetchLike, SourceEnvelope } from "../src/types";

const source: SourceEnvelope = {
  originalText: "",
  originalURL: "https://doi.org/10.5555/example-paper",
  kind: "paper",
  title: "Attention Is All You Need",
  text: "A paper about sequence transduction models.",
  references: [{ url: "https://doi.org/10.5555/example-paper", label: "source" }],
  metadata: {},
  accessLevel: "full",
  depthCap: "deep",
  limitations: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenAlex provider", () => {
  it("normalizes authors, venue, citations, references, and paper links", async () => {
    let requestedURL = "";
    const fetchImpl: FetchLike = async (input) => {
      requestedURL = String(input);
      return jsonResponse({
        id: "https://openalex.org/W2741809807",
        title: "Attention Is All You Need",
        doi: "https://doi.org/10.5555/example-paper",
        publication_year: 2017,
        cited_by_count: 123456,
        authorships: [
          { author: { display_name: "Ashish Vaswani" } },
          { author: { display_name: "Noam Shazeer" } },
          { author: { display_name: "Ashish Vaswani" } },
        ],
        primary_location: {
          landing_page_url: "https://papers.example/attention",
          source: { display_name: "NeurIPS" },
        },
        referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2", "not-a-work"],
      });
    };

    const result = await new OpenAlexProvider({ baseURL: "https://openalex.test", fetchImpl }).enrich(source);

    expect(requestedURL).toBe("https://openalex.test/works/https%3A%2F%2Fdoi.org%2F10.5555%2Fexample-paper");
    expect(result).toEqual({
      workURL: "https://openalex.org/W2741809807",
      title: "Attention Is All You Need",
      doiURL: "https://doi.org/10.5555/example-paper",
      landingPageURL: "https://papers.example/attention",
      publicationYear: 2017,
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      venue: "NeurIPS",
      citedByCount: 123456,
      referenceCount: 2,
      references: [{ url: "https://openalex.org/W1" }, { url: "https://openalex.org/W2" }],
    });
  });

  it("sends the mailto param when a polite-pool contact email is configured", async () => {
    let requestedURL = "";
    const fetchImpl: FetchLike = async (input) => {
      requestedURL = String(input);
      return jsonResponse({ id: "https://openalex.org/W1", title: "Attention Is All You Need" });
    };

    await new OpenAlexProvider({ baseURL: "https://openalex.test", fetchImpl, mailto: "team@example.com" }).enrich(source);

    expect(new URL(requestedURL).searchParams.get("mailto")).toBe("team@example.com");
  });

  it("uses a strict title match when identity lookup is unavailable", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/works/")) return new Response("missing", { status: 404 });
      return jsonResponse({
        results: [
          { title: "A different paper", id: "https://openalex.org/W9" },
          { title: "Attention Is All You Need", id: "https://openalex.org/W10", cited_by_count: 4 },
        ],
      });
    };

    const result = await new OpenAlexProvider({ baseURL: "https://openalex.test", fetchImpl }).enrich({
      ...source,
      originalURL: undefined,
      references: [],
    });

    expect(result).toMatchObject({ workURL: "https://openalex.org/W10", title: "Attention Is All You Need", citedByCount: 4 });
  });

  it("retries a 429 once and returns the warmed response", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return jsonResponse({ id: "https://openalex.org/W2741809807", title: "Attention Is All You Need" });
    };

    const result = await new OpenAlexProvider({ baseURL: "https://openalex.test", fetchImpl, retryDelayMs: 5 }).enrich(source);

    expect(calls).toBe(2);
    expect(result).toMatchObject({ workURL: "https://openalex.org/W2741809807" });
  });

  it("does not retry permanent answers", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("gone", { status: 410 });
    };

    await expect(
      new OpenAlexProvider({ baseURL: "https://openalex.test", fetchImpl, retryDelayMs: 5 }).enrich(source),
    ).rejects.toMatchObject({ code: "UPSTREAM_HTTP", status: 410 });
    expect(calls).toBe(1);
  });
});
