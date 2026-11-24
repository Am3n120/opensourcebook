// @vitest-environment node
import { contentSecurityPolicy, securityHeaders } from "./csp";
import worker from "./index";

const env = { OPENSOURCEBOOK_CLIENT_TOKEN: "t", ENGINE_URL: "http://engine.test", OPENSOURCEBOOK_BROWSER_GATE: "off" };

afterEach(() => vi.unstubAllGlobals());

test("every /api response of the Worker carries the app's security headers, a refusal too", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const json = await worker.fetch(new Request("https://web.test/api/v1/projects"), env);
  for (const [name, value] of Object.entries(securityHeaders())) expect(json.headers.get(name), name).toBe(value);
  expect(await json.text()).toBe("{}");

  const refused = await worker.fetch(new Request("https://web.test/elsewhere"), env);
  expect(refused.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
  expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
});
