/**
 * A way out to the web for the programs the toolbox hands an address to and that fetch on their own (ffmpeg, ffprobe,
 * yt-dlp). They follow redirects, read playlists and ask the site's own APIs by themselves, so the address the agent
 * gave is not the only one they open. Each is started with this relay as its proxy: every request it makes, every
 * redirect and every playlist part included, comes here first, is checked like any other toolbox address
 * (`checkUrl`) and goes to the checked address only. Plain http is fetched here; https comes as a tunnel to a host and
 * port, which is checked the same way before the tunnel is opened. The relay listens on this computer only, asks
 * for a password made for this one call, and is closed when the call ends.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { checkUrl, openPinned, Refused, type Web } from "./net.ts";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/** Runs `use` with the relay's address (http://user:password@127.0.0.1:port), closing the relay when it ends. */
export async function withRelay<T>(web: Web, use: (proxy: string) => Promise<T>): Promise<T> {
  const password = randomBytes(18).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`opensourcebook:${password}`).toString("base64")}`);
  const allowed = (req: IncomingMessage) => {
    const given = Buffer.from(String(req.headers["proxy-authorization"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (!allowed(req)) return void res.writeHead(407, { "proxy-authenticate": 'Basic realm="opensourcebook"', connection: "close" }).end();
    forward(req, res, web).catch(() => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
  });
  server.on("connection", (s) => (sockets.add(s), s.once("close", () => sockets.delete(s))));
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!allowed(req)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="opensourcebook"\r\nConnection: close\r\n\r\n');
    tunnel(String(req.url ?? ""), client, head, web);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    return await use(`http://opensourcebook:${password}@127.0.0.1:${port}`);
  } finally {
    server.close();
    for (const s of sockets) s.destroy();
  }
}

/** A plain http request, in the absolute form a proxy is sent: checked, then fetched at the checked address. */
async function forward(req: IncomingMessage, res: ServerResponse, web: Web): Promise<void> {
  const raw = String(req.url ?? "");
  if (!/^http:\/\//i.test(raw)) return void res.writeHead(400, { connection: "close" }).end();
  let at;
  try {
    at = await checkUrl(raw, web.resolve, web.allows);
  } catch (e) {
    if (e instanceof Refused) return void res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(e.message);
    throw e;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) if ((size += c.length) <= 1e6) chunks.push(c);
  if (size > 1e6) return void res.writeHead(413, { connection: "close" }).end();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && typeof v === "string") headers[k] = v;
  const upstream = await openPinned(at.url, at, { method: req.method ?? "GET", headers, ...(size ? { body: Buffer.concat(chunks) } : {}) });
  const out: string[] = [];
  for (let i = 0; i + 1 < upstream.rawHeaders.length; i += 2) if (!HOP_BY_HOP.has(upstream.rawHeaders[i]!.toLowerCase())) out.push(upstream.rawHeaders[i]!, upstream.rawHeaders[i + 1]!);
  res.writeHead(upstream.statusCode ?? 502, out);
  upstream.pipe(res);
  res.on("close", () => upstream.destroy());
}

/** An https tunnel to host:port, opened only to the checked address. */
function tunnel(target: string, client: Socket, head: Buffer, web: Web): void {
  const refuse = (why: string): void => void client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${why}`);
  if (!/^[^\s/?#@]+:\d+$/.test(target)) return refuse("not a host and port");
  checkUrl(`https://${target}/`, web.resolve, web.allows).then(
    (at) => {
      const upstream = connectTcp({ host: at.address, port: Number(at.url.port || 443) });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    },
    (e: Error) => refuse(e.message),
  );
}
