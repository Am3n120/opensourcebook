import { describe, expect, it } from "vitest";
import { mergeResearchReferences, researchSource } from "../src/research";
import type { PaperMetadataProvider, SourceEnvelope, StructuredProvider } from "../src/types";

const paper: SourceEnvelope = {
  originalText: "",
  originalURL: "https://arxiv.org/pdf/1706.03762",
  kind: "pdf",
  title: "Attention Is All You Need",
  text: "A paper about sequence transduction models.",
  references: [{ url: "https://arxiv.org/pdf/1706.03762", label: "source" }],
  metadata: {},
  accessLevel: "full",
  depthCap: "deep",
  limitations: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

const openAlex: PaperMetadataProvider = {
  name: "openalex-test",
  async enrich() {
    return {
      workURL: "https://openalex.org/W2741809807",
      title: "Attention Is All You Need",
      doiURL: "https://doi.org/10.18653/v1/N17-3017",
      publicationYear: 2017,
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      venue: "NeurIPS",
      citedByCount: 100,
      referenceCount: 2,
      references: [{ url: "https://openalex.org/W1" }, { url: "https://arxiv.org/pdf/1706.03762" }],
    };
  },
};

const grounded: StructuredProvider = {
  name: "grounded-test",
  async generateJSON<T>(): Promise<T> {
    return {} as T;
  },
  async generateGroundedJSON<T>(): Promise<T> {
    return {
      summary: "Grounded context",
      claims: ["The architecture uses attention."],
      references: [
        { url: "https://openalex.org/W1", title: "Duplicate cited work", reason: "duplicate" },
        { url: "https://example.com/context", title: "Context", reason: "context" },
        { url: "https://arxiv.org/pdf/1706.03762", title: "Source repeated", reason: "source" },
      ],
      limitations: [],
    } as T;
  },
};

describe("paper research enrichment", () => {
  it("merges OpenAlex metadata and grounded references without source duplicates", async () => {
    const result = await researchSource(paper, grounded, openAlex);

    expect(result.paper).toMatchObject({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      venue: "NeurIPS",
      citedByCount: 100,
    });
    expect(result.references.map((reference) => reference.url)).toEqual([
      "https://openalex.org/W2741809807",
      "https://doi.org/10.18653/v1/N17-3017",
      "https://openalex.org/W1",
      "https://example.com/context",
    ]);
    expect(result.references.every((reference) => reference.label === "supplemental")).toBe(true);
    expect(result.limitations).not.toContain("OpenAlex paper metadata enrichment was unavailable");
    expect(mergeResearchReferences(paper, result).map((reference) => [reference.url, reference.label])).toEqual([
      ["https://arxiv.org/pdf/1706.03762", "source"],
      ["https://openalex.org/W2741809807", "supplemental"],
      ["https://doi.org/10.18653/v1/N17-3017", "supplemental"],
      ["https://openalex.org/W1", "supplemental"],
      ["https://example.com/context", "supplemental"],
    ]);
  });

  it("still returns paper metadata when grounded generation is unavailable", async () => {
    const result = await researchSource(paper, undefined, openAlex);
    expect(result.paper?.venue).toBe("NeurIPS");
    expect(result.references.map((reference) => reference.url)).toEqual([
      "https://openalex.org/W2741809807",
      "https://doi.org/10.18653/v1/N17-3017",
      "https://openalex.org/W1",
    ]);
    expect(result.limitations).toContain("Research was skipped because grounded provider access is unavailable");
  });
});

const article: SourceEnvelope = {
  ...paper,
  originalURL: "https://blog.example.com/post#intro",
  canonicalURL: "https://blog.example.com/post",
  kind: "article",
  title: "A post",
  text: "An article body.",
  references: [{ url: "https://blog.example.com/post", label: "source" }],
};

function groundedReturning(response: unknown, seen: unknown[] = []): StructuredProvider {
  return {
    name: "grounded-fixture",
    async generateJSON<T>(): Promise<T> {
      throw new Error("plain generation must not be used for research");
    },
    async generateGroundedJSON<T>(request: unknown): Promise<T> {
      seen.push(request);
      return response as T;
    },
  };
}

function enrichCounter(result: Awaited<ReturnType<PaperMetadataProvider["enrich"]>> | Error) {
  const calls: SourceEnvelope[] = [];
  const provider: PaperMetadataProvider = {
    name: "openalex-fixture",
    async enrich(source) {
      calls.push(source);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { provider, calls };
}

describe("research provider use", () => {
  it("asks the grounded tier with the research task and the source text", async () => {
    const seen: unknown[] = [];
    await researchSource(article, groundedReturning({ summary: "s", references: [] }, seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ task: "research", grounding: true });
    expect((seen[0] as { userPrompt: string }).userPrompt).toContain("An article body.");
    expect((seen[0] as { userPrompt: string }).userPrompt).toContain("https://blog.example.com/post#intro");
  });

  it("does not look up paper metadata for non-paper sources", async () => {
    const { provider, calls } = enrichCounter(undefined);
    const result = await researchSource(article, undefined, provider);
    expect(calls).toHaveLength(0);
    expect(result.paper).toBeUndefined();
    expect(result.references).toEqual([]);
    expect(result.summary).toBe("No supplemental research provider was configured.");
  });

  it("looks up paper metadata for both paper and pdf kinds", async () => {
    for (const kind of ["paper", "pdf"] as const) {
      const { provider, calls } = enrichCounter(undefined);
      const result = await researchSource({ ...paper, kind }, undefined, provider);
      expect(calls).toHaveLength(1);
      expect(result.limitations).toContain("OpenAlex returned no matching paper metadata");
    }
  });

  it("keeps grounded research when the metadata lookup throws", async () => {
    const { provider } = enrichCounter(Object.assign(new Error("egress blocked"), { status: 503 }));
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => void warnings.push(message);
    try {
      const result = await researchSource(
        paper,
        groundedReturning({ summary: "ok", references: [{ url: "https://example.com/a", reason: "context" }] }),
        provider,
      );
      expect(result.paper).toBeUndefined();
      expect(result.references.map((reference) => reference.url)).toEqual(["https://example.com/a"]);
      expect(result.limitations).toContain("OpenAlex paper metadata enrichment was unavailable");
      expect(warnings[0]).toContain("egress blocked");
      expect(warnings[0]).toContain("http 503");
    } finally {
      console.warn = warn;
    }
  });

  it("falls back to paper references when grounded research throws", async () => {
    const failing: StructuredProvider = {
      name: "failing",
      async generateJSON<T>(): Promise<T> {
        return {} as T;
      },
      async generateGroundedJSON<T>(): Promise<T> {
        throw new Error("upstream 500");
      },
    };
    const result = await researchSource(paper, failing, openAlex);
    expect(result.summary).toBe('OpenAlex metadata found for "Attention Is All You Need".');
    expect(result.claims).toEqual([]);
    expect(result.paper?.title).toBe("Attention Is All You Need");
    expect(result.references.map((reference) => reference.url)).toEqual([
      "https://openalex.org/W2741809807",
      "https://doi.org/10.18653/v1/N17-3017",
      "https://openalex.org/W1",
    ]);
    expect(result.limitations).toContain("Grounded research failed; generation must remain within the original source");
  });

  it("says so when grounded research fails and there is no paper", async () => {
    const failing: StructuredProvider = {
      name: "failing",
      async generateJSON<T>(): Promise<T> {
        return {} as T;
      },
      async generateGroundedJSON<T>(): Promise<T> {
        throw new Error("timeout");
      },
    };
    const result = await researchSource(article, failing);
    expect(result.summary).toBe("Supplemental research was unavailable.");
    expect(result.references).toEqual([]);
  });
});

describe("research response cleaning", () => {
  it("drops non-HTTP, malformed and duplicate references and labels the rest supplemental", async () => {
    const result = await researchSource(article, groundedReturning({
      summary: "s",
      references: [
        { url: "javascript:alert(1)", reason: "bad scheme" },
        { url: "ftp://files.example.com/a", reason: "bad scheme" },
        { url: "not a url" },
        { title: "no url" },
        null,
        { url: "https://example.com/a", reason: "  first   reason " },
        { url: "https://example.com/a", reason: "duplicate" },
        { url: "https://example.com/b", domain: "Example B" },
      ],
    }));
    expect(result.references).toEqual([
      {
        url: "https://example.com/a",
        domain: "example.com",
        label: "supplemental",
        relation: "first reason",
        reason: "first reason",
      },
      {
        url: "https://example.com/b",
        domain: "Example B",
        label: "supplemental",
        reason: "Grounded supplemental context",
      },
    ]);
  });

  it("never returns the source itself, matching across fragments and canonical URLs", async () => {
    const result = await researchSource(article, groundedReturning({
      summary: "s",
      references: [
        { url: "https://blog.example.com/post#comments" },
        { url: "https://blog.example.com/post" },
      ],
    }));
    expect(result.references).toEqual([]);
    expect(result.limitations).toContain("Grounding returned no distinct supplemental references");
  });

  it("caps references at 20, claims at 20 and limitations at 10", async () => {
    const result = await researchSource(article, groundedReturning({
      summary: "s",
      claims: Array.from({ length: 30 }, (_, index) => `claim ${index}`),
      references: Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${index}` })),
      limitations: Array.from({ length: 15 }, (_, index) => `limit ${index}`),
    }));
    expect(result.references).toHaveLength(20);
    expect(result.claims).toHaveLength(20);
    expect(result.limitations).toHaveLength(10);
  });

  it("normalizes whitespace, trims the summary and drops empty or non-string entries", async () => {
    const result = await researchSource(article, groundedReturning({
      summary: `  ${"word ".repeat(3_000)}  `,
      claims: ["  spaced\n\nclaim  ", "", "   ", 42, null],
      references: [],
    }));
    expect(result.summary.length).toBe(8_000);
    expect(result.summary.startsWith("word word")).toBe(true);
    expect(result.claims).toEqual(["spaced claim"]);
  });

  it("tolerates a response with no usable fields", async () => {
    const result = await researchSource(article, groundedReturning({ references: "nope", claims: "nope" }));
    expect(result.summary).toBe("");
    expect(result.claims).toEqual([]);
    expect(result.references).toEqual([]);
  });
});

describe("mergeResearchReferences", () => {
  it("puts source references first and filters research that repeats them", () => {
    const merged = mergeResearchReferences(article, {
      summary: "",
      claims: [],
      limitations: [],
      references: [
        { url: "https://blog.example.com/post#x", label: "supplemental", reason: "repeat" },
        { url: "https://example.com/new", label: "supplemental", reason: "new" },
      ],
    });
    expect(merged.map((reference) => [reference.url, reference.label])).toEqual([
      ["https://blog.example.com/post", "source"],
      ["https://example.com/new", "supplemental"],
    ]);
  });
});
