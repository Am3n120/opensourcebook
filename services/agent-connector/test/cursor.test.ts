/**
 * Cursor's CLI agent: its command line, the settings and plugin it gets for a turn, what it says about itself, how a
 * turn runs and ends, and reading its JSON events. The events below are in the shape its docs give for
 * `--output-format stream-json` and its own code (2026.11.19) writes them, read from the published package; no real
 * Cursor agent has run against this adapter yet.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyCursor, CURSOR_FILE_TOOLS, CURSOR_FILES, CURSOR_MCP_TOOLS, CURSOR_NOTE, cursorAdapter, cursorArgs, cursorConfig, cursorEnv, cursorFolderProblem, cursorPlugin, cursorPrompt, parseCursorModels, readCursorLine } from "../src/agents/cursor.ts";
import { fakeCli } from "./fake-cli.ts";

const base = { turnId: "t1", systemPrompt: "You are Open Sourcebook's chat.", prompt: "hi", cwd: "/tmp/opensourcebook-agent-x", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer s3cret" } } };

const sid = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
const TURN = [
  JSON.stringify({ type: "system", subtype: "init", apiKeySource: "login", cwd: "/tmp/opensourcebook-agent-x", session_id: sid, model: "Claude 4.6 Sonnet", permissionMode: "default" }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, session_id: sid }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me answer." }] }, session_id: sid }),
  JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { mcpToolCall: { args: { name: "reply", args: { text: "pong" } } } }, session_id: sid }),
  JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { mcpToolCall: { args: { name: "reply" }, result: { success: {} } } }, session_id: sid }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] }, session_id: sid }),
  JSON.stringify({ type: "result", subtype: "success", duration_ms: 900, duration_api_ms: 900, is_error: false, result: "Let me answer.Done.", session_id: sid, usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 10 } }),
];

test("its command line: headless JSON events, this folder trusted for the run, Open Sourcebook's plugin approved, and only Open Sourcebook's tools", () => {
  assert.deepEqual(cursorArgs({ ...base, model: "sonnet-4.6" }, "/tmp/c/plugin"), ["--print", "--output-format", "stream-json", "--trust", "--approve-mcps", "--plugin-dir", "/tmp/c/plugin", "--allowed-tools", "mcp_tool_call,get_mcp_tools_tool_call", "--model", "sonnet-4.6"]);
  assert.ok(!cursorArgs(base, "/p").includes("--model"), "its own default model");
  assert.ok(!cursorArgs(base, "/p").includes(base.prompt), "the prompt goes on stdin");
  assert.ok(!cursorArgs(base, "/p").some((a) => /^(-f|--force|--yolo|--auto-review)$/.test(a)), "nothing approved wholesale");
});

test("its settings for a turn: approvals by the list only, Open Sourcebook's server's tools allowed, its shell, the web and every file refused", () => {
  const config = cursorConfig(base) as any;
  assert.equal(config.version, 1);
  assert.equal(config.approvalMode, "allowlist");
  assert.deepEqual(config.permissions.allow, ["Mcp(opensourcebook:*)"]);
  for (const rule of ["Shell(*)", "WebFetch(*)", "Read(**)", "Read(/**)", "Write(**)", "Write(/**)"]) assert.ok(config.permissions.deny.includes(rule), rule);
  assert.equal(config.sandbox, undefined);
  assert.deepEqual(config.attribution, { attributeCommitsToAgent: false, attributePRsToAgent: false });
});

test("its plugin for a turn: Open Sourcebook's MCP server and nothing else", () => {
  const plugin = cursorPlugin(base);
  assert.equal(plugin.manifest.name, "opensourcebook-turn");
  assert.deepEqual(plugin.mcp, { mcpServers: { opensourcebook: { url: base.mcp.url, headers: base.mcp.headers } } });
});

test("its prompt: Open Sourcebook's instructions first, then the turn's", () => {
  assert.equal(cursorPrompt(base), "<instructions>\nYou are Open Sourcebook's chat.\n</instructions>\n\nhi");
});

test("its environment: the turn's settings folder, never a browser, never Open Sourcebook's own settings", () => {
  const env = cursorEnv("/tmp/c/config", { PATH: "/usr/bin", OPENSOURCEBOOK_CONNECTOR_TOKEN: "x", OPENSOURCEBOOK_OPENAI_API_KEY: "k", CURSOR_CONFIG_DIR: "/Users/ann/.cursor" });
  assert.equal(env.CURSOR_CONFIG_DIR, "/tmp/c/config");
  assert.equal(env.NO_OPEN_BROWSER, "1");
  assert.equal(env.OPENSOURCEBOOK_CONNECTOR_TOKEN, undefined);
  assert.equal(env.OPENSOURCEBOOK_OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("what it says about itself: not installed, or its version, whether it is signed in and its models; it has no box", async () => {
  const adapter = cursorAdapter({ bin: "/nonexistent/cursor-agent" });
  assert.deepEqual(await adapter.info(), { installed: false });
  assert.equal(adapter.boxing, undefined, "work that asks for everything gets files only");
  assert.equal(adapter.filesOnly?.note, CURSOR_FILES);
  const status = JSON.stringify({ status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true, userInfo: { email: "ann@example.com" } }, null, 2);
  const models = "Available models\n\nauto - Auto (current, default)\nsonnet-4.6 - Claude 4.6 Sonnet\ngpt-6.1\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n";
  const cli = fakeCli([{ args: "--version", out: "2026.11.19-f005e9d\n" }, { args: "status --format json", out: `${status}\n` }, { args: "models", out: models }]);
  try {
    const info = await cursorAdapter({ bin: cli.bin }).info();
    assert.deepEqual(info, { installed: true, version: "2026.11.19-f005e9d", signedIn: true, note: CURSOR_NOTE, models: [{ id: "auto", label: "Auto" }, { id: "sonnet-4.6", label: "Claude 4.6 Sonnet" }, { id: "gpt-6.1", label: "gpt-6.1" }] });
    assert.ok(!JSON.stringify(info).includes("ann@example.com"), "only whether it is signed in is read");
  } finally {
    cli.remove();
  }
  const out = fakeCli([{ args: "--version", out: "2026.11.19\n" }, { args: "status", out: '{"status":"unauthenticated","isAuthenticated":false}\n' }, { args: "models", out: "", code: 1 }]);
  try {
    const info = await cursorAdapter({ bin: out.bin }).info();
    assert.equal(info.signedIn, false);
    assert.equal(info.models, undefined, "no list when it can't say");
  } finally {
    out.remove();
  }
});

test("its models, from `models`, colours or not", () => {
  assert.deepEqual(parseCursorModels(["\u001b[2mAvailable models\u001b[22m", "", "\u001b[32mauto\u001b[39m \u001b[2m- Auto\u001b[22m\u001b[2m (current)\u001b[22m", "No models available for this account."]), [{ id: "auto", label: "Auto" }]);
});

test("a turn: Open Sourcebook's instructions and the prompt on stdin, its settings and plugin written and removed, its last words and tokens", async () => {
  const cli = fakeCli([{ args: "--print", out: `${TURN.join("\n")}\n` }]);
  try {
    const end = await cursorAdapter({ bin: cli.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.deepEqual(end, { ok: true, text: "Done.", model: "Claude 4.6 Sonnet", tokensIn: 250, inputTokens: 200, tokensOut: 10, cacheReadTokens: 40, cacheWriteTokens: 10 });
    assert.deepEqual(cli.stdins(), [cursorPrompt(base)]);
    const env = Object.fromEntries(cli.env().map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.match(env.CURSOR_CONFIG_DIR!, /opensourcebook-cursor-.*config$/);
    assert.throws(() => readFileSync(join(env.CURSOR_CONFIG_DIR!, "cli-config.json")), "removed when the turn ends");
    const args = cli.calls()[0]!.split(" ");
    assert.match(args[args.indexOf("--plugin-dir") + 1]!, /opensourcebook-cursor-.*plugin$/);
  } finally {
    cli.remove();
  }
});

test("a turn's end: out of usage, signed out, missing, or another error in its own words", async () => {
  const limited = fakeCli([{ args: "--print", out: "", code: 1 }]);
  try {
    // Its words go to stderr; the stand-in writes nothing there, so this checks the words directly.
    assert.equal(classifyCursor("You've hit your usage limit for this month."), "agentLimit");
    assert.equal(classifyCursor("Error: Not authenticated. Please run cursor-agent login"), "agentSignedOut");
    assert.equal(classifyCursor("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY"), "agentSignedOut");
    assert.equal(classifyCursor("boom"), "error");
    const failed = await cursorAdapter({ bin: limited.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.equal(failed.ok, false);
    assert.equal(failed.problem, "error");
    assert.equal((await cursorAdapter({ bin: "/nonexistent/cursor-agent" }).run({ ...base, cwd: tmpdir() }).done).problem, "agentMissing");
  } finally {
    limited.remove();
  }
});

test("its JSON events: the words since the last tool call, the model, the tokens, and a failed result's words", () => {
  const seen: Parameters<typeof readCursorLine>[1] = {};
  for (const line of ["Loading…", ...TURN]) readCursorLine(line, seen);
  assert.equal(seen.text, "Done.");
  assert.equal(seen.model, "Claude 4.6 Sonnet");
  assert.equal(seen.status, "success");
  assert.equal(seen.tokensIn, 250);
  assert.equal(seen.inputTokens, 200);
  assert.equal(seen.tokensOut, 10);
  assert.equal(seen.cacheReadTokens, 40);
  assert.equal(seen.cacheWriteTokens, 10);
  const failed: Parameters<typeof readCursorLine>[1] = {};
  readCursorLine(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Model not available on your plan." }), failed);
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "Model not available on your plan.");
});

test("a files-only folder: its file tools offered and its reads kept there, its shell, the web and the rest still off", () => {
  const spec = { ...base, cwd: "/Users/ann/opensourcebook/.data/v1/work", workspace: { access: "files" as const, connectorPort: 8650 } };
  const args = cursorArgs(spec, "/p");
  assert.deepEqual(args[args.indexOf("--allowed-tools") + 1]!.split(","), [...CURSOR_MCP_TOOLS, ...CURSOR_FILE_TOOLS]);
  assert.ok(!/shell|web|task|fetch/.test(args[args.indexOf("--allowed-tools") + 1]!));
  const config = cursorConfig(spec) as any;
  assert.deepEqual(config.permissions.allow, ["Mcp(opensourcebook:*)", "Read(**)", "Write(**)"]);
  assert.deepEqual(config.permissions.deny, ["Shell(*)", "WebFetch(*)"]);
  assert.deepEqual(config.sandbox, { readBoundary: "workspace" });
});

test("a files-only folder holding a link out of it, or a .cursor folder, is refused at the start", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-cursor-folder-")));
  const work = join(root, "work");
  try {
    mkdirSync(join(work, "skills"), { recursive: true });
    writeFileSync(join(work, "skills", "a.md"), "x");
    assert.equal(cursorFolderProblem(work), undefined);
    mkdirSync(join(work, ".cursor"));
    assert.match(cursorFolderProblem(work)!, /\.cursor/);
    rmSync(join(work, ".cursor"), { recursive: true });
    writeFileSync(join(root, "outside.txt"), "x");
    symlinkSync(join(root, "outside.txt"), join(work, "out"));
    const end = await cursorAdapter({ bin: "/nonexistent/cursor-agent" }).run({ ...base, cwd: work, workspace: { access: "files", connectorPort: 8650 } }).done;
    assert.equal(end.ok, false);
    assert.match(end.detail!, /links that lead out/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
