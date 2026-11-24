/**
 * GitHub Copilot's CLI: its command line, the MCP config and agent it gets for a turn, what it says about itself, how a
 * turn runs and ends, and reading its JSON events. The events below are in the shape its published event schema
 * (`schemas/session-events.schema.json` in @github/copilot 1.0.114) and its JSON writer give them, read from the
 * package; no real Copilot CLI has run against this adapter yet.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyCopilot, COPILOT_FILE_TOOLS, COPILOT_FILES, COPILOT_NOTE, COPILOT_OWN_TOOLS, copilotAdapter, copilotAgent, copilotArgs, copilotEnv, copilotMcpConfig, readCopilotLine, readUsage } from "../src/agents/copilot.ts";
import { fakeCli } from "./fake-cli.ts";

const base = { turnId: "t1", systemPrompt: "You are Open Sourcebook's chat.", prompt: "hi", cwd: "/tmp/opensourcebook-agent-x", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer s3cret" } } };
const files = { mcp: "/tmp/c/mcp.json", agentRoot: "/tmp/c/agent", agent: "opensourcebook-turn-abc", usage: "/tmp/c/usage.json" };

const at = "2026-11-20T14:00:00.000Z";
let n = 0;
const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ id: `e${++n}`, timestamp: at, parentId: null, type, data, ...extra });
const TURN = [
  ev("session.start", { sessionId: "s1", version: 1, producer: "copilot-agent", copilotVersion: "1.0.114", startTime: at, selectedModel: "claude-haiku-5.5" }),
  ev("user.message", { content: "hi" }),
  ev("assistant.message", { messageId: "m1", content: "Let me answer.", model: "claude-haiku-5.5", toolRequests: [{ toolCallId: "c1", name: "opensourcebook-reply", arguments: { text: "pong" } }] }),
  ev("tool.execution_start", { toolCallId: "c1", toolName: "opensourcebook-reply", mcpServerName: "opensourcebook", mcpToolName: "reply" }),
  ev("tool.execution_complete", { toolCallId: "c1", success: true }),
  ev("assistant.message", { messageId: "m2", content: "Thinking it over.", model: "claude-haiku-5.5" }, { agentId: "sub-1" }),
  ev("assistant.message", { messageId: "m3", content: "Done.", model: "claude-haiku-5.5", toolRequests: [] }),
  JSON.stringify({ type: "result", timestamp: at, sessionId: "s1", exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 900, sessionDurationMs: 1200, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }),
];

const QUOTA = [
  ev("session.start", { sessionId: "s2", version: 1, producer: "copilot-agent", copilotVersion: "1.0.114", startTime: at }),
  ev("session.error", { errorType: "quota", message: "You have used all of your premium requests for this month. Your plan resets on December 1." , statusCode: 402 }),
  JSON.stringify({ type: "result", timestamp: at, sessionId: "s2", exitCode: 1, usage: {} }),
];

test("its command line: JSON events, its own tools off the list and refused by kind, Open Sourcebook's server added and allowed, nothing of the person's read", () => {
  const args = copilotArgs({ ...base, model: "claude-haiku-5.5", effort: "low" }, files);
  for (const flag of ["--no-auto-update", "--no-custom-instructions", "--no-ask-user", "--disable-builtin-mcps", "--disallow-temp-dir", "--sync-session=off"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(0, 2), ["--output-format", "json"]);
  assert.equal(args[args.indexOf("--additional-mcp-config") + 1], "@/tmp/c/mcp.json", "the server's token in a file, not on the command line");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/c/agent");
  assert.equal(args[args.indexOf("--agent") + 1], "opensourcebook-turn-abc");
  assert.deepEqual(args[args.indexOf("--excluded-tools") + 1]!.split(","), COPILOT_OWN_TOOLS);
  assert.equal(args[args.indexOf("--allow-tool") + 1], "opensourcebook");
  assert.deepEqual(args.flatMap((a, i) => (a === "--deny-tool" ? [args[i + 1]] : [])), ["shell", "url", "memory", "read", "write"]);
  assert.equal(args[args.indexOf("--usage-output-file") + 1], "/tmp/c/usage.json");
  assert.deepEqual(args.slice(-4), ["--model", "claude-haiku-5.5", "--effort", "low"]);
  assert.ok(!copilotArgs(base, files).includes("--model"), "its own default model");
  assert.ok(!args.includes(base.prompt), "the prompt is piped on stdin");
  assert.ok(!args.some((a) => /^(--allow-all|--yolo|--allow-all-tools|--allow-all-paths|--trust-folder|--autopilot|--enable-memory)$/.test(a)), "nothing approved or trusted wholesale");
  assert.ok(!args.join(" ").includes("s3cret"));
});

test("its MCP config for a turn: Open Sourcebook's server over HTTP with its headers, every tool of it, and minutes to answer", () => {
  assert.deepEqual(copilotMcpConfig(base), { mcpServers: { opensourcebook: { type: "http", url: base.mcp.url, headers: base.mcp.headers, tools: ["*"], timeout: 900_000 } } });
});

test("its agent for a turn: Open Sourcebook's system prompt, never picked on its own", () => {
  const agent = copilotAgent(base);
  assert.match(agent, /^---\nname: Open Sourcebook\ndescription: .+\ninfer: false\n---\nYou are Open Sourcebook's chat\.\n$/);
});

test("its environment: no update, no plugins found on their own, never Open Sourcebook's own settings, nothing that widens the run", () => {
  const env = copilotEnv({ PATH: "/usr/bin", OPENSOURCEBOOK_CONNECTOR_TOKEN: "x", OPENSOURCEBOOK_ANTHROPIC_API_KEY: "k", COPILOT_ALLOW_ALL: "true", COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/x", COPILOT_SKILLS_DIRS: "/y", COPILOT_PLAN_THEN_AUTOPILOT: "1", COPILOT_ASSISTED_APPROVAL: "true", GH_TOKEN: "theirs" });
  assert.equal(env.COPILOT_AUTO_UPDATE, "false");
  assert.equal(env.COPILOT_PLUGIN_DIR_ONLY, "true");
  for (const key of ["OPENSOURCEBOOK_CONNECTOR_TOKEN", "OPENSOURCEBOOK_ANTHROPIC_API_KEY", "COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_SKILLS_DIRS", "COPILOT_PLAN_THEN_AUTOPILOT", "COPILOT_ASSISTED_APPROVAL"]) assert.equal(env[key], undefined, key);
  assert.equal(env.GH_TOKEN, "theirs", "how it signs in is its own business, as in any shell of theirs");
  assert.equal(env.PATH, "/usr/bin");
});

test("what it says about itself: not installed, or ready with how it answers; its models, efforts and defaults; it has no box", async () => {
  const adapter = copilotAdapter({ bin: "/nonexistent/copilot" });
  assert.deepEqual(await adapter.info(), { installed: false });
  assert.equal(adapter.boxing, undefined, "work that asks for everything gets files only");
  assert.equal(adapter.filesOnly?.note, COPILOT_FILES);
  assert.equal(adapter.signIn, "/nonexistent/copilot login");
  assert.ok(adapter.models!.some((m) => m.id === "auto"));
  for (const model of Object.values(adapter.defaultModels!)) assert.ok(adapter.models!.some((m) => m.id === model), model);
  assert.deepEqual(adapter.efforts?.map((e) => e.id), ["low", "medium", "high", "xhigh"]);
  const cli = fakeCli([{ args: "--version", out: "GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates.\n" }]);
  try {
    assert.deepEqual(await copilotAdapter({ bin: cli.bin }).info(), { installed: true, version: "1.0.114", note: COPILOT_NOTE });
    assert.deepEqual(cli.calls(), ["--version"], "never asked about, nor reading, its sign-in");
  } finally {
    cli.remove();
  }
});

test("a turn: the prompt piped on stdin, the turn's files written and removed, the main agent's last words", async () => {
  const cli = fakeCli([{ args: "--output-format json", out: `${TURN.join("\n")}\n` }]);
  try {
    const end = await copilotAdapter({ bin: cli.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.deepEqual(end, { ok: true, text: "Done.", model: "claude-haiku-5.5" });
    assert.deepEqual(cli.stdins(), ["hi"]);
    const args = cli.calls()[0]!.split(" ");
    const mcp = args[args.indexOf("--additional-mcp-config") + 1]!.slice(1);
    assert.match(mcp, /opensourcebook-copilot-.*mcp\.json$/);
    assert.throws(() => readFileSync(mcp), "removed when the turn ends");
    assert.match(args[args.indexOf("--agent") + 1]!, /^opensourcebook-turn-[0-9a-f]{12}$/);
    const env = cli.env();
    assert.ok(env.includes("COPILOT_PLUGIN_DIR_ONLY=true"));
  } finally {
    cli.remove();
  }
});

test("its usage file: tokens summed over its models, and the model when there was one", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-copilot-usage-"));
  try {
    const path = join(dir, "usage.json");
    writeFileSync(path, JSON.stringify({ totalNanoAiu: 1, totalPremiumRequestCost: 1, modelMetrics: { "claude-haiku-5.5": { requests: { count: 2, cost: 1 }, usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 10 } } } }));
    assert.deepEqual(readUsage(path), { model: "claude-haiku-5.5", tokensIn: 250, inputTokens: 200, tokensOut: 10, cacheReadTokens: 40, cacheWriteTokens: 10 });
    writeFileSync(path, JSON.stringify({ modelMetrics: { a: { usage: { inputTokens: 1, outputTokens: 1 } }, b: { usage: { inputTokens: 2, outputTokens: 3 } } } }));
    assert.deepEqual(readUsage(path), { tokensIn: 3, inputTokens: 3, tokensOut: 4 });
    assert.deepEqual(readUsage(join(dir, "none.json")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn's end: out of its plan's requests, signed out, missing, or another error in its own words", async () => {
  const limited = fakeCli([{ args: "--output-format", out: `${QUOTA.join("\n")}\n`, code: 1 }]);
  try {
    const refused = await copilotAdapter({ bin: limited.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.equal(refused.ok, false);
    assert.equal(refused.problem, "agentLimit");
    assert.equal(refused.said, "You have used all of your premium requests for this month. Your plan resets on December 1.");
    assert.equal((await copilotAdapter({ bin: "/nonexistent/copilot" }).run({ ...base, cwd: tmpdir() }).done).problem, "agentMissing");
  } finally {
    limited.remove();
  }
  assert.equal(classifyCopilot("authentication", ""), "agentSignedOut");
  assert.equal(classifyCopilot("rate_limit", ""), "agentLimit");
  assert.equal(classifyCopilot(undefined, "Error: No authentication information found."), "agentSignedOut");
  assert.equal(classifyCopilot(undefined, "boom"), "error");
});

test("its JSON events: only the main agent's words since its last tool call, the model, a result's exit code and an error's words", () => {
  const seen: Parameters<typeof readCopilotLine>[1] = {};
  for (const line of ["Loading…", ...TURN]) readCopilotLine(line, seen);
  assert.deepEqual(seen, { model: "claude-haiku-5.5", text: "Done.", exitCode: 0 });
  const failed: Parameters<typeof readCopilotLine>[1] = {};
  for (const line of QUOTA) readCopilotLine(line, failed);
  assert.equal(failed.errorType, "quota");
  assert.equal(failed.exitCode, 1);
});

test("a files-only folder: its file tools back on the list and reads and writes allowed, its shell, the web and the rest still off", () => {
  const spec = { ...base, cwd: "/Users/ann/opensourcebook/.data/v1/work", workspace: { access: "files" as const, connectorPort: 8650 } };
  const args = copilotArgs(spec, files);
  const excluded = args[args.indexOf("--excluded-tools") + 1]!.split(",");
  for (const tool of COPILOT_FILE_TOOLS) assert.ok(!excluded.includes(tool), tool);
  for (const tool of ["bash", "powershell", "web_fetch", "web_search", "task", "skill"]) assert.ok(excluded.includes(tool), tool);
  assert.deepEqual(args.flatMap((a, i) => (a === "--allow-tool" ? [args[i + 1]] : [])), ["opensourcebook", "read,write"]);
  assert.deepEqual(args.flatMap((a, i) => (a === "--deny-tool" ? [args[i + 1]] : [])), ["shell", "url", "memory"]);
  assert.ok(args.includes("--disallow-temp-dir"));
  assert.ok(!args.includes("--allow-all-paths"));
});

test("a files-only folder holding a link out of it is refused at the start", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-copilot-folder-")));
  const work = join(root, "work");
  try {
    mkdirSync(join(work, "skills"), { recursive: true });
    writeFileSync(join(root, "outside.txt"), "x");
    symlinkSync(join(root, "outside.txt"), join(work, "out"));
    const end = await copilotAdapter({ bin: "/nonexistent/copilot" }).run({ ...base, cwd: work, workspace: { access: "files", connectorPort: 8650 } }).done;
    assert.equal(end.ok, false);
    assert.match(end.detail!, /links that lead out/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copilotAdapter tags its model tiers, effort weights, and high work effort", () => {
  const adapter = copilotAdapter();
  assert.deepEqual(adapter.defaultModels, { chat: "claude-haiku-5.5", work: "claude-sonnet-5.5" });
  assert.deepEqual(adapter.defaultEfforts, { work: "high" });
  assert.deepEqual(
    adapter.models!.map((m) => [m.id, m.tier]),
    [
      ["auto", undefined],
      ["claude-haiku-5.5", "fast"],
      ["claude-sonnet-5.5", "balanced"],
      ["claude-opus-5.5", "strong"],
      ["gpt-6.1-sol", "balanced"],
      ["gemini-3.8-flash", "fast"],
    ],
  );
  assert.deepEqual(
    adapter.efforts!.map((e) => [e.id, e.weight]),
    [["low", "light"], ["medium", "medium"], ["high", "high"], ["xhigh", "max"]],
  );
});
