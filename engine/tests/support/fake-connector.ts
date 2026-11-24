/**
 * A connector on "this computer" for tests: it takes a turn as the real one
 * does (POST /turns), runs a scripted agent that calls Open Sourcebook's tools back
 * through the engine's own routes with the turn's token, and reports the
 * end. It can stop a turn, forget one (a dropped turn), or stop answering
 * (a connector that went away).
 */
import { handleRequest } from "../../src/index";
import type { FetchLike } from "../../src/types";

export const FAKE_CONNECTOR_URL = "http://127.0.0.1:8661";
export const FAKE_ENGINE_URL = "http://127.0.0.1:8801";
export const FAKE_CONNECTOR_TOKEN = "fake-connector-token-0123456789";

export interface FakeTurnBody {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  instructions?: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  callback: { url: string; token: string };
  target?: { type: string; id: string };
  model?: string;
  timeoutMs?: number;
}

/** What a scripted agent can do in its turn. */
export interface FakeAgent {
  body: FakeTurnBody;
  /** Calls one of Open Sourcebook's tools, as the agent's MCP call would reach the engine. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Resolves once the turn is stopped from the engine. */
  stopped: Promise<void>;
}

/** `said`: with a failed turn, the agent's own words on why, as the real connector passes them on from its error. */
export type AgentScript = (agent: FakeAgent) => Promise<{ ok: boolean; problem?: string; text?: string; said?: string } | "hang">;

export class FakeConnector {
  readonly bodies: FakeTurnBody[] = [];
  readonly stops: string[] = [];
  readonly calls: Array<{ name: string; args: unknown; answer: { text: string; isError: boolean } }> = [];
  /** False: nothing answers, as when the connector is not running. */
  reachable = true;
  /** How long the end takes to reach the engine after the connector forgot the turn (the real one cleans up first, then posts). */
  finishDelayMs = 0;
  private readonly running = new Set<string>();
  private readonly stoppers = new Map<string, () => void>();

  constructor(private script: AgentScript) {}

  setScript(script: AgentScript): void {
    this.script = script;
  }

  /** The connector forgets a turn without saying how it ended (it was restarted). */
  forget(turnId: string): void {
    this.running.delete(turnId);
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (!this.reachable) throw new TypeError("fetch failed: connection refused");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/status") {
      return Response.json({ agent: "claude", model: "haiku", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true }], running: this.running.size });
    }
    const one = /^\/turns\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && one) return Response.json({ running: this.running.has(decodeURIComponent(one[1]!)) });
    const stop = /^\/turns\/([^/]+)\/stop$/.exec(url.pathname);
    if (method === "POST" && stop) {
      const id = decodeURIComponent(stop[1]!);
      this.stops.push(id);
      this.stoppers.get(id)?.();
      return Response.json({ ok: this.running.has(id) });
    }
    if (method === "POST" && url.pathname === "/turns") {
      const body = JSON.parse(String(init?.body)) as FakeTurnBody;
      this.bodies.push(body);
      this.running.add(body.turnId);
      let stopped: () => void = () => undefined;
      const whenStopped = new Promise<void>((resolve) => (stopped = resolve));
      this.stoppers.set(body.turnId, stopped);
      void this.play(body, whenStopped);
      return Response.json({ ok: true, agent: "claude", workspace: false }, { status: 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  private async play(body: FakeTurnBody, stopped: Promise<void>): Promise<void> {
    await Promise.resolve();
    const agent: FakeAgent = {
      body,
      stopped,
      call: async (name, args = {}) => {
        const response = await handleRequest(
          new Request(`${body.callback.url}/tools`, { method: "POST", headers: { authorization: `Bearer ${body.callback.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) }),
          undefined,
        );
        const answer = (await response.json()) as { text: string; isError: boolean };
        this.calls.push({ name, args, answer });
        return answer;
      },
    };
    const ending: { ok: boolean; problem?: string; text?: string; said?: string } | "hang" = await Promise.race([this.script(agent), stopped.then(() => ({ ok: false, problem: "stopped" }))]);
    if (ending === "hang" || !this.running.has(body.turnId)) return;
    this.running.delete(body.turnId);
    if (this.finishDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.finishDelayMs));
    await handleRequest(
      new Request(`${body.callback.url}/finish`, {
        method: "POST",
        headers: { authorization: `Bearer ${body.callback.token}`, "content-type": "application/json" },
        body: JSON.stringify({ outcome: ending.ok ? "done" : "failed", ...(ending.problem ? { problem: ending.problem } : {}), ...(ending.text ? { text: ending.text } : {}), ...(ending.said ? { said: ending.said } : {}), model: "claude-haiku-test", tokensIn: 100, tokensOut: 50 }),
      }),
      undefined,
    );
  }
}
