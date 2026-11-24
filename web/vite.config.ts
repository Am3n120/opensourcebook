import { randomBytes } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { securityHeaders } from "./worker/csp";

/**
 * `vite dev` serves the app with the same policy the built app has
 * (worker/csp.ts), plus a nonce for the dev server's own inline module
 * (React's fast refresh), which vite puts on every script it writes into
 * the page (`html.cspNonce`). The nonce is new each time the dev server
 * starts. /api/* is the Worker's, which adds its own.
 */
function devSecurityHeaders(nonce: string): Plugin {
  const headers = securityHeaders({ nonce });
  return {
    name: "opensourcebook-dev-security-headers",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
  };
}

// `vite dev` runs worker/index.ts (the same-origin /api proxy) in the Workers
// runtime next to the app, reading secrets from .dev.vars. Tests skip it.
export default defineConfig(({ mode, command, isPreview }) => {
  const nonce = command === "serve" && !isPreview && mode !== "test" ? randomBytes(18).toString("base64url") : undefined;
  return {
    // The Workers runtime's debugger port stays shut: any program on this computer could attach to it and read the
    // proxy's secrets. OPENSOURCEBOOK_WEB_INSPECTOR=1 opens it (on 127.0.0.1) for someone developing the Worker (its old name, RE_WEB_INSPECTOR, is still read).
    plugins: [react(), ...(mode === "test" ? [] : [cloudflare({ inspectorPort: (process.env.OPENSOURCEBOOK_WEB_INSPECTOR ?? process.env.RE_WEB_INSPECTOR) === "1" ? 9229 : false })]), ...(nonce ? [devSecurityHeaders(nonce)] : [])],
    ...(nonce ? { html: { cspNonce: nonce } } : {}),
    // Home reads the finished example projects in the repo's examples/ folder (src/screens/examples.ts).
    server: { fs: { allow: [".", "../examples"] } },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
      css: false,
    },
  };
});
