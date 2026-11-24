import { describe, expect, it } from "vitest";
import { candidatesFromCommons, CommonsPictureSearch, stripHTML } from "../src/providers/commons";
import { InMemoryUsageSink } from "../src/providers/usage";
import type { FetchLike } from "../src/types";

describe("CommonsPictureSearch", () => {
  const commonsPage = (index: number, title: string, width: number, licence?: string) => ({
    index,
    title: `File:${title}`,
    imageinfo: [{
      url: `https://upload.example/${title}`,
      descriptionurl: `https://commons.example/wiki/File:${title}`,
      width,
      height: 600,
      mime: "image/jpeg",
      extmetadata: {
        ...(licence ? { LicenseShortName: { value: licence }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" } } : {}),
        Artist: { value: '<a href="//commons.example/wiki/User:Someone">Someone</a>' },
        ImageDescription: { value: "A heart &amp; its <b>valves</b>." },
      },
    }],
  });

  it("keeps search order, licence and credit, and drops unlicensed or small files", () => {
    const payload = {
      query: {
        pages: [
          commonsPage(2, "second.jpg", 2000, "CC BY-SA 4.0"),
          commonsPage(1, "first.jpg", 1200, "Public domain"),
          commonsPage(3, "unlicensed.jpg", 2000),
          commonsPage(4, "small.jpg", 300, "CC0"),
        ],
      },
    };
    const candidates = candidatesFromCommons(payload, 1000);
    expect(candidates.map((candidate) => candidate.title)).toEqual(["first.jpg", "second.jpg"]);
    expect(candidates[1]).toMatchObject({
      licence: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0" },
      credit: "Someone",
      description: "A heart & its valves.",
      contentType: "image/jpeg",
      archive: "Wikimedia Commons",
    });
    expect(candidatesFromCommons({})).toEqual([]);
    expect(stripHTML("<span>Own&nbsp;work</span>")).toBe("Own work");
  });

  it("asks Commons for bitmap files with licence metadata and logs a free call", async () => {
    const usage = new InMemoryUsageSink();
    let requested = "";
    const fetchImpl: FetchLike = async (input) => {
      requested = String(input);
      return Response.json({ query: { pages: [commonsPage(1, "heart.jpg", 1500, "CC0")] } });
    };
    const search = new CommonsPictureSearch({ fetchImpl, usageSink: usage });
    const found = await search.search({ query: "human heart", limit: 3 }, { jobId: "j" });
    expect(found).toHaveLength(1);
    const url = new URL(requested);
    expect(url.searchParams.get("gsrsearch")).toBe("filetype:bitmap human heart");
    expect(url.searchParams.get("gsrlimit")).toBe("3");
    expect(usage.events).toEqual([expect.objectContaining({ provider: "wikimedia-commons", task: "searchPictures", usd: 0, ok: true, jobId: "j" })]);
  });

  it("treats Commons's busy answer as a failure", async () => {
    const usage = new InMemoryUsageSink();
    const fetchImpl: FetchLike = async () => Response.json({ error: { code: "maxlag", info: "busy" } });
    const search = new CommonsPictureSearch({ fetchImpl, usageSink: usage });
    await expect(search.search({ query: "x" }, {})).rejects.toThrow("busy");
    expect(usage.events[0]).toMatchObject({ ok: false });
  });
});
