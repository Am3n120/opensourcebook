import { withSecurityHeaders } from "./csp";
import { proxy, type ProxyEnv } from "./proxy";

/** Static assets are served by the platform (with public/_headers); only /api/* reaches this Worker. */
export default {
  async fetch(request: Request, env: ProxyEnv): Promise<Response> {
    return withSecurityHeaders(await proxy(request, env));
  },
} satisfies ExportedHandler<ProxyEnv>;
