// @vitest-environment node
/**
 * The app's Content-Security-Policy (worker/csp.ts) holds in every place it
 * is served from: the built app's static files (public/_headers) and
 * `vite dev`; worker/index.test.ts checks the /api Worker's responses.
 */
import { expect, test } from "vitest";
import indexHtml from "../index.html?raw";
import headersFile from "../public/_headers?raw";
import { THEME_SCRIPT_HASH, contentSecurityPolicy, securityHeaders } from "../worker/csp";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

function directives(policy: string): Map<string, string> {
  return new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values.join(" ")]));
}

test("the policy loads scripts, pictures and media only from the app, and the app is never framed", () => {
  const policy = directives(contentSecurityPolicy());
  expect(policy.get("script-src")).toBe(`'self' '${THEME_SCRIPT_HASH}'`);
  expect(policy.get("img-src")).toBe("'self' data: blob:");
  expect(policy.get("media-src")).toBe("'self' blob:");
  expect(policy.get("connect-src")).toBe("'self'");
  expect(policy.get("frame-src")).toBe("https://www.youtube-nocookie.com");
  expect(policy.get("frame-ancestors")).toBe("'none'");
  expect(policy.get("base-uri")).toBe("'none'");
  expect(policy.get("object-src")).toBe("'none'");
  expect(contentSecurityPolicy()).not.toMatch(/unsafe-eval|https?:\/\/(?!www\.youtube-nocookie\.com)|\*/);
  expect(policy.get("script-src")).not.toContain("unsafe-inline");
});

test("the hash it allows is the one inline script in index.html, exactly as written", async () => {
  const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  expect(inline).toHaveLength(1);
  expect(await sha256(inline[0]!)).toBe(THEME_SCRIPT_HASH);
});

test("the built app's static files carry the same headers (public/_headers)", () => {
  const lines = headersFile.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
  expect(lines[0]).toBe("/*");
  const served = Object.fromEntries(lines.slice(1).map((line) => [line.trim().slice(0, line.trim().indexOf(":")), line.trim().slice(line.trim().indexOf(":") + 1).trim()]));
  expect(served).toEqual(securityHeaders());
});

test("`vite dev` sends the policy with a nonce for its own inline module, and vite writes that nonce on its scripts", async () => {
  const path = "../vite.config.ts";
  const config = (await import(/* @vite-ignore */ path)).default as (env: { command: string; mode: string; isPreview?: boolean }) => {
    plugins: Array<{ name?: string; configureServer?: (server: unknown) => void }>;
    html?: { cspNonce?: string };
  };
  const dev = config({ command: "serve", mode: "development" });
  const nonce = dev.html?.cspNonce;
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  const middlewares: Array<(req: { url: string }, res: { setHeader(name: string, value: string): void }, next: () => void) => void> = [];
  dev.plugins.find((plugin) => plugin?.name === "opensourcebook-dev-security-headers")!.configureServer!({ middlewares: { use: (fn: (typeof middlewares)[number]) => middlewares.push(fn) } });
  const sent: Record<string, string> = {};
  middlewares[0]!({ url: "/projects/p1" }, { setHeader: (name, value) => void (sent[name] = value) }, () => {});
  expect(sent).toEqual(securityHeaders({ nonce }));
  expect(sent["content-security-policy"]).toContain(`'nonce-${nonce}'`);
  // A build has no nonce: its policy is the one in public/_headers.
  expect(config({ command: "build", mode: "production" }).html).toBeUndefined();
});
