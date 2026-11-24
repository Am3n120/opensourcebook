/**
 * Open Sourcebook's tools as an MCP server, over HTTP, for one turn: the smallest part
 * of the protocol an agent needs (initialize, the tool list, tool calls,
 * ping), each request answered with one JSON response. The tools are the
 * ones the engine sent with the turn; calling one asks the engine.
 */
import { MCP_SERVER, PRODUCT } from "./names.ts";

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** A picture a tool answers with, shown to the agent after the tool's words. */
export interface ToolImage {
  mimeType: string;
  dataBase64: string;
}

export interface ToolAnswer {
  text: string;
  isError: boolean;
  images?: ToolImage[];
}

export interface McpTurn {
  tools: ToolListing[];
  /** What the agent is told about these tools when it connects; the chat's line when the caller does not say. */
  instructions?: string;
  call(name: string, args: unknown): Promise<ToolAnswer>;
}

const SERVER_INFO = { name: MCP_SERVER, title: PRODUCT, version: "1.0.0" };
const FALLBACK_PROTOCOL = "2025-06-18";
const CHAT_INSTRUCTIONS = "Open Sourcebook's tools for one chat turn in one project. End the turn with the reply tool.";

/** One JSON-RPC message in; the response body, or undefined for a notification (answered 202). */
export async function handleMcp(message: unknown, turn: McpTurn): Promise<unknown> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id: isRecord(message) ? (message.id ?? null) : null, error: { code: -32600, message: "Invalid request" } };
  }
  const id = message.id;
  if (id === undefined) return undefined;
  const params = isRecord(message.params) ? message.params : {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: turn.instructions ?? CHAT_INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: turn.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!turn.tools.some((tool) => tool.name === name)) return ok({ content: [{ type: "text", text: `There is no tool "${name}".` }], isError: true });
      const result = await turn.call(name, params.arguments ?? {});
      // Pictures go as MCP image blocks after the words, so the agent sees them.
      const images = (result.images ?? []).map((image) => ({ type: "image", data: image.dataBase64, mimeType: image.mimeType }));
      return ok({ content: [{ type: "text", text: result.text }, ...images], isError: result.isError });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
