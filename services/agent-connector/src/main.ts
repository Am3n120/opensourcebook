/**
 * Starts the connector on this computer (README). Settings come from the
 * environment; the token is the one the engine's CHAT_AGENT_TOKEN holds.
 */
import { delimiter, isAbsolute, join } from "node:path";
import { agentBins, createDefaultAgents } from "./agents/registry.ts";
import { boxForPlatform } from "./box.ts";
import { carryOldSettings, defaultUsageLog } from "./names.ts";
import { createConnector } from "./server.ts";
import { turnModel, workspaceAccess } from "./turns.ts";

// A person's own `.env` from before the rename names its settings `RE_...`: they are read under their new names.
carryOldSettings();

const token = process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN?.trim() ?? "";
if (token.length < 16) {
  console.error("Set OPENSOURCEBOOK_CONNECTOR_TOKEN to a random string of at least 16 characters (the engine's CHAT_AGENT_TOKEN).");
  process.exit(1);
}
// The scenes service's own, narrower token (optional): it starts turns only in its own folders (OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS,
// absolute paths separated by the system's path delimiter, ":" on a Mac), and reaches nothing else here.
const scenesToken = process.env.OPENSOURCEBOOK_CONNECTOR_SCENES_TOKEN?.trim() ?? "";
const scenesRoots = (process.env.OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS ?? "").split(delimiter).map((root) => root.trim()).filter(Boolean);
if (scenesToken && (scenesToken.length < 16 || scenesToken === token)) {
  console.error("OPENSOURCEBOOK_CONNECTOR_SCENES_TOKEN must be a random string of at least 16 characters, not OPENSOURCEBOOK_CONNECTOR_TOKEN.");
  process.exit(1);
}
if (scenesRoots.some((root) => !isAbsolute(root))) {
  console.error("OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS must be absolute paths.");
  process.exit(1);
}
const port = Number(process.env.OPENSOURCEBOOK_CONNECTOR_PORT ?? 8650);
const timeout = Number(process.env.OPENSOURCEBOOK_AGENT_TIMEOUT_MS);
const agents = createDefaultAgents(agentBins(process.env), {
  // API keys of the person's own, optional (README). Read here, never logged, never given to an agent in the box.
  ...(process.env.OPENSOURCEBOOK_ANTHROPIC_API_KEY?.trim() ? { anthropic: process.env.OPENSOURCEBOOK_ANTHROPIC_API_KEY.trim() } : {}),
  ...(process.env.OPENSOURCEBOOK_OPENAI_API_KEY?.trim() ? { openai: process.env.OPENSOURCEBOOK_OPENAI_API_KEY.trim() } : {}),
  ...(process.env.OPENSOURCEBOOK_GEMINI_API_KEY?.trim() ? { google: process.env.OPENSOURCEBOOK_GEMINI_API_KEY.trim() } : {}),
});
// The connector's own agent only when the person names one: none by default, so no provider is preferred and the
// engine names the agent of each turn (the person's pick, or the only one they connected).
const agent = process.env.OPENSOURCEBOOK_AGENT?.trim() || undefined;
if (agent && !agents.get(agent)) {
  console.error(`OPENSOURCEBOOK_AGENT=${agent} is not an agent this connector knows (${agents.list().map((known) => known.id).join(", ")}).`);
  process.exit(1);
}
// The person's own model for chat; none leaves it to the agent's adapter (its model for chat, else its own default).
const model = process.env.OPENSOURCEBOOK_AGENT_MODEL?.trim() || undefined;
const chatModel = agent ? turnModel(agents.get(agent)!, {}, model) : undefined;
const effort = process.env.OPENSOURCEBOOK_AGENT_EFFORT?.trim() || undefined;

// Turns that ask for a workspace get the agent's own tools there as far as it and this computer allow
// (`workspaceAccess`): its file tools on its own login, or everything inside the box on an API key.
// OPENSOURCEBOOK_AGENT_WORKSPACE=off keeps every agent's own tools off everywhere.
const off = process.env.OPENSOURCEBOOK_AGENT_WORKSPACE?.trim() === "off";
const box = off ? undefined : boxForPlatform();
const offer = agent ? workspaceAccess(agents.get(agent)!, box, off) : undefined;
const rawUsageLog = process.env.OPENSOURCEBOOK_USAGE_LOG?.trim();
const usageLog = rawUsageLog && /^(off|none|0)$/i.test(rawUsageLog)
  ? undefined
  : rawUsageLog || defaultUsageLog(join(import.meta.dirname, "..", "..", ".."));
const { server } = createConnector({
  token,
  ...(scenesToken ? { scenes: { token: scenesToken, roots: scenesRoots } } : {}),
  ...(box ? { box } : {}),
  ...(off ? { noWorkspaces: true } : {}),
  ...(usageLog ? { usageLog } : {}),
  agents,
  defaults: { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
  ...(Number.isFinite(timeout) && timeout >= 10_000 ? { timeoutMs: timeout } : {}),
});
server.listen(port, "127.0.0.1", () => {
  const own = !agent || !offer
    ? `${agents.list().length} agents, none of its own (each turn names one)`
    : `${agent}${chatModel ? ` (${chatModel} in chat)` : " (its own default model)"}${effort ? `, effort ${effort}` : ""}${!offer.access ? ", no workspaces" : offer.access === "full" ? ", workspaces with its own tools, boxed" : `, workspaces with its file tools only${box ? ", boxed" : ""}`}`;
  console.log(`Open Sourcebook agent connector on http://127.0.0.1:${port}: ${own}. This computer only.`);
});
// Why it ends is written to its log (the launcher keeps it), so a connector that went away explains itself. A stray
// error in one request or turn is logged and the connector keeps serving the other turns: one failed call is not a
// reason to lose every job in progress.
const when = () => new Date().toISOString();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.error(`${when()}  agent connector got ${signal} (parent process ${process.ppid}); closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
process.on("unhandledRejection", (reason) => console.error(`${when()}  agent connector: unhandled rejection, kept running: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
process.on("uncaughtException", (error) => {
  // Not being able to listen is not a stray error: with nothing to serve there is nothing to keep running.
  const fatal = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  console.error(`${when()}  agent connector: uncaught exception${fatal ? ", cannot go on" : ", kept running"}: ${error.stack ?? error.message}`);
  if (fatal) process.exit(1);
});
process.on("exit", (code) => console.error(`${when()}  agent connector exits with code ${code}`));
