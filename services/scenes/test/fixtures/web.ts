/**
 * Small web servers on this computer for the toolbox's tests, and a web in which one of them stands in for the public
 * internet: 127.0.0.1 counts as public, while every other address (::1, the private ranges) is judged as it really
 * is. A server on [::1] then stands in for something private the toolbox must never reach; it keeps every request it
 * gets, so a test can show it got none.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { addressText, isPublicAddress } from "../../../../common/addresses.ts";
import { connectPinned, resolveHost, type Web } from "../../src/toolbox/net.ts";

export interface Served {
  /** http://host:port, with no path. */
  origin: string;
  port: number;
  /** Every request it got, as METHOD path. */
  hits: string[];
  close(): Promise<void>;
}

export async function serve(host: "127.0.0.1" | "::1", answer: (req: IncomingMessage, res: ServerResponse) => void, port = 0): Promise<Served> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    answer(req, res);
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, host, () => resolve()));
  const bound = (server.address() as { port: number }).port;
  return {
    origin: `http://${host.includes(":") ? `[${host}]` : host}:${bound}`,
    port: bound,
    hits,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** The real web, except that 127.0.0.1 stands in for a public address. */
export const loopbackAsPublic = (resolve = resolveHost): Web => ({
  resolve,
  connect: connectPinned,
  allows: (b) => addressText(b).address === "127.0.0.1" || isPublicAddress(b),
});
