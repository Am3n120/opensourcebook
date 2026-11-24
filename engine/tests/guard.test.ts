import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSourceExtractor } from "../src/extract";
import { defaultFetch } from "../src/extract/context";
import { extractVideoModule } from "../src/extract/video";
import { AddressRefused, checkSourceAddress, dohResolver, guardedFetch, type ResolveName } from "../src/guard";
import type { FetchLike } from "../src/types";
import { verifyPayloadURLs } from "../src/verify";

/** A resolver that calls everything public, so a host written as an address must be judged without it. */
const publicDns: ResolveName = async () => ["93.184.216.34"];

const PRIVATE_SPELLINGS = [
  "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0.0.0.0/", "http://10.1.2.3/", "http://100.64.0.1/",
  "http://169.254.169.254/latest/meta-data/", "http://224.0.0.1/", "http://192.168.0.1/", "http://[::1]/", "http://[::ffff:7f00:1]:14004/api/v1/projects",
  "http://[::ffff:127.0.0.1]/", "http://[::7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b:1::7f00:1]/", "http://[2002:7f00:1::]/", "http://[::ffff:a9fe:a9fe]/",
  "http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00:ec2::254]/", "http://localhost:8790/", "http://re.localhost/",
  "file:///etc/hosts", "ftp://example.org/", "https://user:pw@example.org/",
];

describe("the engine's address guard", () => {
  it("refuses every spelling of this computer or a private network, with or without a resolver", async () => {
    for (const url of PRIVATE_SPELLINGS) {
      await expect(checkSourceAddress(url, publicDns), url).rejects.toBeInstanceOf(AddressRefused);
      await expect(checkSourceAddress(url), url).rejects.toBeInstanceOf(AddressRefused);
    }
    expect((await checkSourceAddress("https://example.org/a", publicDns)).hostname).toBe("example.org");
    expect((await checkSourceAddress("https://[::ffff:93.184.216.34]/", publicDns)).hostname).toBe("[::ffff:5db8:d822]");
  });

  it("refuses a name when any of its addresses is private, or it has none", async () => {
    await expect(checkSourceAddress("https://rebind.example/", async () => ["93.184.216.34", "::ffff:7f00:1"])).rejects.toThrow(/private network/);
    await expect(checkSourceAddress("https://nowhere.example/", async () => [])).rejects.toThrow(/could not be found/);
    await expect(checkSourceAddress("https://down.example/", async () => Promise.reject(new Error("no dns")))).rejects.toThrow(/could not be found/);
  });

  it("looks names up over DNS over HTTPS, A and AAAA, and fails closed when the lookup fails", async () => {
    const asked: string[] = [];
    const doh: FetchLike = async (input) => {
      const url = new URL(String(input));
      asked.push(`${url.searchParams.get("name")} ${url.searchParams.get("type")}`);
      if (url.searchParams.get("name") === "broken.example") return new Response("", { status: 502 });
      const answer = url.searchParams.get("type") === "A" ? [{ type: 5, data: "cname.example." }, { type: 1, data: "127.0.0.1" }] : [{ type: 28, data: "2606:4700::1111" }];
      return Response.json({ Status: 0, Answer: answer });
    };
    const resolve = dohResolver(doh);
    expect(await resolve("sneaky.example")).toEqual(["127.0.0.1", "2606:4700::1111"]);
    expect(asked).toEqual(["sneaky.example A", "sneaky.example AAAA"]);
    await expect(checkSourceAddress("https://sneaky.example/", resolve)).rejects.toThrow(/private network/);
    await expect(checkSourceAddress("https://broken.example/", resolve)).rejects.toThrow(/could not be found/);
  });

  it("follows redirects by hand and refuses a hop to a private address before it is opened", async () => {
    const opened: string[] = [];
    const inner: FetchLike = async (input, init) => {
      const url = String(input);
      opened.push(`${init?.method ?? "GET"} ${url} ${init?.redirect}`);
      if (url === "https://example.org/start") return new Response(null, { status: 301, headers: { location: "/next" } });
      if (url === "https://example.org/next") return new Response(null, { status: 302, headers: { location: "http://[::ffff:7f00:1]:14004/api/v1/projects" } });
      if (url === "https://example.org/named") return new Response(null, { status: 307, headers: { location: "https://inside.example/secret" } });
      if (url === "https://example.org/post") return new Response(null, { status: 303, headers: { location: "https://example.org/landed" } });
      return new Response("ok", { status: 200 });
    };
    const resolve: ResolveName = async (host) => (host === "inside.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const guarded = guardedFetch(inner, { resolve });
    await expect(guarded("https://example.org/start")).rejects.toThrow(/private network/);
    await expect(guarded("https://example.org/named")).rejects.toThrow(/private network/);
    expect(opened.every((o) => o.endsWith(" manual"))).toBe(true);
    expect(opened.some((o) => o.includes("7f00") || o.includes("inside.example"))).toBe(false);
    opened.length = 0;
    expect(await (await guarded("https://example.org/post", { method: "POST", body: "x" })).text()).toBe("ok");
    expect(opened).toEqual(["POST https://example.org/post manual", "GET https://example.org/landed manual"]);
    // A caller that follows redirects itself gets the redirect back, still checked before it was opened.
    expect((await guarded("https://example.org/start", { redirect: "manual" })).status).toBe(301);
  });
});

describe("what the engine opens for a source or a model", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html" }).end(`<title>Private</title><p>${"secret ".repeat(200)}</p><img src="/pic.png">`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("a link source to this computer, in any spelling, is not fetched", async () => {
    const port = base.split(":")[1];
    for (const host of ["127.0.0.1", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "2130706433", "0x7f.1", "127.1", "localhost"]) {
      const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: `http://${host}:${port}/page.html`, sourceKind: "web" });
      expect(source.text, host).not.toMatch(/secret/);
    }
    await expect(defaultFetch(`http://${base}/direct`)).rejects.toBeInstanceOf(AddressRefused);
    expect(hits).toEqual([]);
  });

  it("a model's link to this computer in a card is not opened", async () => {
    const report = await verifyPayloadURLs({ blocks: [{ type: "linkCard", url: `http://${base}/from-a-card`, title: "x" } as never, { type: "image", url: `http://[::ffff:7f00:1]:${base.split(":")[1]}/pic.png` } as never] });
    expect(report.checked).toHaveLength(2);
    expect(report.checked.every((c) => !c.ok)).toBe(true);
    expect(hits).toEqual([]);
  });

  it("the yt-dlp sidecar, Open Sourcebook's own program, is still called, but is never sent a private address to open", async () => {
    const sent: string[] = [];
    const sidecar: FetchLike = async (input) => {
      sent.push(String(input));
      return Response.json({ ok: true, title: "A video" });
    };
    const guarded = guardedFetch(async () => new Response("no"), { resolve: publicDns });
    const base = { sourceText: "", fetchImpl: guarded, sidecarFetchImpl: sidecar, checkAddress: guarded.check, sidecarURL: "http://localhost:8080", timeoutMs: 1_000, maxTextChars: 1_000 };
    expect(await extractVideoModule({ ...base, url: "http://[::ffff:7f00:1]:14004/api/v1/projects" })).toBeUndefined();
    expect(sent).toEqual([]);
    expect((await extractVideoModule({ ...base, url: "https://www.youtube.com/watch?v=abc" }))?.title).toBe("A video");
    expect(sent).toEqual([`http://localhost:8080/extract?url=${encodeURIComponent("https://www.youtube.com/watch?v=abc")}`]);
  });
});
