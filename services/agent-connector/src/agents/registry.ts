/** The agents this connector can run. A new agent is one adapter registered here; nothing else names one. */
import { antigravityAdapter } from "./antigravity.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import { copilotAdapter } from "./copilot.ts";
import { openCodeAdapter } from "./opencode.ts";
import type { AgentAdapter } from "./types.ts";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentAdapter>();

  register(agent: AgentAdapter): this {
    if (this.agents.has(agent.id)) throw new Error(`Agent "${agent.id}" is already registered.`);
    this.agents.set(agent.id, agent);
    return this;
  }

  get(id: string): AgentAdapter | undefined {
    return this.agents.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.agents.values()];
  }
}

/**
 * API keys the person gave the connector, each for the agents of that provider.
 * Never a subscription login: those stay with each agent, which signs in to them itself.
 */
export interface AgentKeys {
  anthropic?: string;
  openai?: string;
  /** A Gemini API key, for Google's agent in the box. */
  google?: string;
}

/** Where each agent's program is, by its id, when not on the PATH under its usual name. */
export type AgentBins = Partial<Record<string, string>>;

/** Each agent this connector can run, made with where its program is and the API keys the person gave. */
const DEFAULT_AGENTS: Array<(bin: { bin?: string }, keys: AgentKeys) => AgentAdapter> = [
  (bin, keys) => claudeAdapter({ ...bin, ...(keys.anthropic ? { apiKey: keys.anthropic } : {}) }),
  (bin, keys) => codexAdapter({ ...bin, ...(keys.openai ? { apiKey: keys.openai } : {}) }),
  (bin) => openCodeAdapter(bin),
  (bin, keys) => antigravityAdapter({ ...bin, ...(keys.google ? { apiKey: keys.google } : {}) }),
  (bin) => cursorAdapter(bin),
  (bin) => copilotAdapter(bin),
];

export function createDefaultAgents(bins: AgentBins = {}, keys: AgentKeys = {}): AgentRegistry {
  const registry = new AgentRegistry();
  for (const make of DEFAULT_AGENTS) {
    const id = make({}, {}).id;
    registry.register(make(bins[id] ? { bin: bins[id] } : {}, keys));
  }
  return registry;
}

/** Where each agent's program is, from `<ID>_BIN` in the environment (`CLAUDE_BIN`, `CODEX_BIN`, …): one per registered agent. */
export function agentBins(env: NodeJS.ProcessEnv): AgentBins {
  const ids = createDefaultAgents().list().map((agent) => agent.id);
  return Object.fromEntries(ids.flatMap((id) => {
    const bin = env[`${id.toUpperCase()}_BIN`]?.trim();
    return bin ? [[id, bin]] : [];
  }));
}
