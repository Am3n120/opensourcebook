/**
 * OpenCode: its command line and the settings it gets for a turn, what it says about itself, how a turn runs and
 * ends, and reading its JSON events. The events below are in the format OpenCode 2.2.6 wrote on this Mac, once
 * against a stand-in model with Open Sourcebook's MCP server and once on a free model past its free use (ids shortened).
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyOpenCode, linksOut, modelName, OPENCODE_FILES, OPENCODE_NOTE, openCodeAdapter, openCodeArgs, openCodeConfig, openCodeEnv, readOpenCodeLine, readOpenCodeModels } from "../src/agents/opencode.ts";
import { fakeCli } from "./fake-cli.ts";

const base = { turnId: "t1", systemPrompt: "You are Open Sourcebook's chat.", prompt: "hi", cwd: "/tmp/opensourcebook-agent-x", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer s3cret" } } };

const TURN = [
  '{"type":"step_start","timestamp":1794947594451,"sessionID":"ses_1","part":{"id":"prt_1","sessionID":"ses_1","messageID":"msg_1","type":"step-start"}}',
  '{"type":"tool_use","timestamp":1794947594492,"sessionID":"ses_1","part":{"partID":"prt_2","sessionID":"ses_1","messageID":"msg_1","type":"tool","id":"call_1","tool":"opensourcebook_reply","state":{"status":"completed","input":{"text":"pong"},"output":"Sent.","title":"opensourcebook_reply"}}}',
  '{"type":"step_finish","timestamp":1794947594497,"sessionID":"ses_1","part":{"id":"prt_3","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}}',
  '{"type":"step_start","timestamp":1794947594518,"sessionID":"ses_1","part":{"id":"prt_4","type":"step-start"}}',
  '{"type":"text","timestamp":1794947594527,"sessionID":"ses_1","part":{"id":"prt_5","type":"text","text":"Done.","time":{"start":1794947594522,"end":1794947594527}}}',
  '{"type":"step_finish","timestamp":1794947594538,"sessionID":"ses_1","part":{"id":"prt_6","type":"step-finish","reason":"stop","cost":0,"tokens":{"input":120,"output":2,"reasoning":0,"cache":{"read":30,"write":0}}}}',
];

const FREE_LIMIT = [
  '{"type":"step_start","timestamp":1794947517066,"sessionID":"ses_2","part":{"id":"prt_1","type":"step-start"}}',
  '{"type":"error","timestamp":1794947517074,"sessionID":"ses_2","error":{"type":"provider.free-limit","message":"Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.","status":429,"retryAfterMs":12483000}}',
];

test("its command line: a private server of its own, JSON events, Open Sourcebook's agent, kept out of its session lists, the model as OpenCode names it", () => {
  assert.deepEqual(openCodeArgs({ ...base, model: "opencode__big-pickle" }), ["run", "--standalone", "--format", "json", "--agent", "opensourcebook", "--archived", "-m", "opencode/big-pickle"]);
  assert.ok(!openCodeArgs(base).includes("-m"), "its own default model");
  assert.ok(!openCodeArgs(base).includes(base.prompt), "the prompt goes on stdin");
  assert.equal(modelName("anthropic__claude-sonnet"), "anthropic/claude-sonnet");
});

test("its settings for a turn: only Open Sourcebook's MCP server, every tool refused but Open Sourcebook's, Open Sourcebook's prompt as the agent's own, no sharing or title call", () => {
  const config = openCodeConfig(base) as any;
  assert.deepEqual(config.mcp.servers.opensourcebook, { type: "remote", url: base.mcp.url, headers: base.mcp.headers, oauth: false, codemode: false, timeout: { execution: 900_000 } });
  assert.deepEqual(Object.keys(config.mcp.servers), ["opensourcebook"]);
  const agent = config.agents.opensourcebook;
  assert.equal(agent.system, base.systemPrompt);
  // The last rule that matches wins: everything refused, then Open Sourcebook's tools allowed.
  assert.deepEqual(agent.permissions, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "opensourcebook_*", resource: "*", effect: "allow" },
  ]);
  assert.equal(config.share, "disabled");
  assert.equal(config.websearch, false);
  assert.deepEqual(config.agents.title, { disabled: true });
  // Keeping OpenCode's own prompt, Open Sourcebook's is added as an instructions file instead.
  const kept = openCodeConfig({ ...base, keepAgentPrompt: true }, "/tmp/x/opensourcebook.md") as any;
  assert.equal(kept.agents.opensourcebook.system, undefined);
  assert.deepEqual(kept.instructions, ["/tmp/x/opensourcebook.md"]);
  const env = openCodeEnv(base, { PATH: "/usr/bin", OPENSOURCEBOOK_CONNECTOR_TOKEN: "x", OPENSOURCEBOOK_ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!), config);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(env.OPENSOURCEBOOK_CONNECTOR_TOKEN, undefined);
  assert.equal(env.OPENSOURCEBOOK_ANTHROPIC_API_KEY, undefined);
});

test("what it says about itself: not installed, or ready with the models it offers and how it answers; it has no box", async () => {
  const adapter = openCodeAdapter({ bin: "/nonexistent/opencode" });
  assert.deepEqual(await adapter.info(), { installed: false });
  assert.equal(adapter.boxing, undefined, "work that asks for a workspace runs with Open Sourcebook's tools only");
  const cli = fakeCli([{ args: "--version", out: "opencode v2.2.6\n" }, { args: "models --standalone", out: "opencode/big-pickle\nopencode/gpt-5.5\nlocal/llama3:8b\nnot a model\n" }]);
  try {
    assert.deepEqual(await openCodeAdapter({ bin: cli.bin }).info(), {
      installed: true,
      version: "2.2.6",
      note: OPENCODE_NOTE,
      models: [
        { id: "opencode__big-pickle", label: "big-pickle" },
        { id: "opencode__gpt-5.5", label: "gpt-5.5" },
      ],
    });
    assert.ok(!cli.calls().some((c) => c.startsWith("auth")), "never its credential list");
  } finally {
    cli.remove();
  }
  assert.deepEqual(readOpenCodeModels(["a/b", "x"]), [{ id: "a__b", label: "b" }]);
});

test("a turn ends with its last words and its tokens; a refusal it exits 0 on is still a failure", async () => {
  const ok = fakeCli([{ args: "run --standalone", out: `${TURN.join("\n")}\n` }]);
  const limited = fakeCli([{ args: "run --standalone", out: `${FREE_LIMIT.join("\n")}\n` }]);
  try {
    const end = await openCodeAdapter({ bin: ok.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.deepEqual(end, { ok: true, text: "Done.", tokensIn: 250, inputTokens: 220, cacheReadTokens: 30, cacheWriteTokens: 0, tokensOut: 12, costUsd: 0 });
    assert.deepEqual(ok.stdins(), ["hi"]);
    assert.ok(ok.env().some((line) => line.startsWith("OPENCODE_CONFIG_CONTENT=")));
    const refused = await openCodeAdapter({ bin: limited.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.equal(refused.ok, false);
    assert.equal(refused.problem, "agentLimit");
    const missing = await openCodeAdapter({ bin: "/nonexistent/opencode" }).run({ ...base, cwd: tmpdir() }).done;
    assert.equal(missing.problem, "agentMissing");
  } finally {
    ok.remove();
    limited.remove();
  }
});

test("its JSON events: tokens over every step, the last words, an error and why", () => {
  const seen: Parameters<typeof readOpenCodeLine>[1] = {};
  for (const line of ["INFO starting", ...TURN]) readOpenCodeLine(line, seen);
  assert.deepEqual(seen, { steps: 2, tokensIn: 250, inputTokens: 220, cacheReadTokens: 30, cacheWriteTokens: 0, tokensOut: 12, costUsd: 0, text: "Done." });
  const priced: Parameters<typeof readOpenCodeLine>[1] = {};
  readOpenCodeLine('{"type":"step_finish","part":{"cost":0.0012,"tokens":{"input":50,"output":10,"reasoning":5,"cache":{"read":100,"write":20}}}}', priced);
  readOpenCodeLine('{"type":"step_finish","part":{"cost":0.0008,"tokens":{"input":10,"output":2,"cache":{"read":150,"write":0}}}}', priced);
  assert.deepEqual(priced, { steps: 2, inputTokens: 60, cacheReadTokens: 250, cacheWriteTokens: 20, tokensIn: 330, tokensOut: 17, costUsd: 0.002 });
  const noCost: Parameters<typeof readOpenCodeLine>[1] = {};
  readOpenCodeLine('{"type":"step_finish","part":{"tokens":{"input":10,"output":5}}}', noCost);
  assert.deepEqual(noCost, { steps: 1, inputTokens: 10, tokensIn: 10, tokensOut: 5 });
  const limited: Parameters<typeof readOpenCodeLine>[1] = {};
  for (const line of FREE_LIMIT) readOpenCodeLine(line, limited);
  assert.equal(limited.errorProblem, "agentLimit");
  const signedOut: Parameters<typeof readOpenCodeLine>[1] = {};
  readOpenCodeLine('{"type":"error","error":{"type":"provider.auth","message":"Invalid API key","status":401}}', signedOut);
  assert.equal(signedOut.errorProblem, "agentSignedOut");
  assert.equal(classifyOpenCode("Free usage limit reached"), "agentLimit");
  assert.equal(classifyOpenCode("boom"), "error");
});

test("a files-only folder: its file tools allowed, every path outside the folder and every other tool of its own refused", () => {
  const work = "/Users/ann/opensourcebook/.data/v1/work";
  const rules = (openCodeConfig({ ...base, cwd: work, workspace: { access: "files", connectorPort: 8650 } }) as any).agents.opensourcebook.permissions;
  // The last rule that matches wins.
  assert.deepEqual(rules, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "opensourcebook_*", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "external_directory", resource: work, effect: "allow" },
    { action: "external_directory", resource: `${work}/*`, effect: "allow" },
  ]);
  assert.ok(!rules.some((r: { action: string; effect: string }) => /shell|webfetch|websearch|subagent/.test(r.action) && r.effect === "allow"));
  assert.equal((openCodeConfig(base) as any).agents.opensourcebook.permissions.length, 2, "no file tools without a folder");
  assert.equal(openCodeAdapter().filesOnly?.note, OPENCODE_FILES);
});

test("a files-only folder that holds a link leading out of it is refused at the start, as OpenCode follows links", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-oc-links-")));
  const work = join(root, "work");
  try {
    mkdirSync(join(work, "skills"), { recursive: true });
    writeFileSync(join(root, "outside.txt"), "x");
    writeFileSync(join(work, "skills", "a.md"), "x");
    symlinkSync(join(work, "skills", "a.md"), join(work, "inside-link"));
    assert.deepEqual(linksOut(work), [], "a link that stays inside is fine");
    symlinkSync(join(root, "outside.txt"), join(work, "skills", "out"));
    symlinkSync(join(root, "missing"), join(work, "dangling"));
    assert.deepEqual(linksOut(work).sort(), [join(work, "dangling"), join(work, "skills", "out")]);
    const end = await openCodeAdapter({ bin: "/nonexistent/opencode" }).run({ ...base, cwd: work, workspace: { access: "files", connectorPort: 8650 } }).done;
    assert.equal(end.ok, false);
    assert.match(end.detail!, /links that lead out/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
