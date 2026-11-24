/**
 * Codex: its command line with and without the box, what it says about itself (installed, signed in, on a key, its
 * models), how a turn runs and ends, and reading its JSON events. The events below are in the format Codex 0.166 wrote
 * on this Mac, against a stand-in model and with no login (ids shortened).
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxedCodex, classifyCodex, codexAdapter, codexArgs, codexBoxHome, CODEX_ON_KEY, NO_CODEX_KEY, OWN_TOOL_FEATURES, readCodexLine, readCodexModels } from "../src/agents/codex.ts";
import { boxForPlatform, SANDBOX_EXEC } from "../src/box.ts";
import { fakeCli } from "./fake-cli.ts";

const base = { turnId: "t1", systemPrompt: 'Make "the video".\nThen stop.', prompt: "p", cwd: "/Users/ann/opensourcebook/.data/v1/work", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer s3cret" } } };

/** A turn that called Open Sourcebook's reply tool and ended, as `codex exec --json` writes it. */
const TURN = [
  '{"type":"thread.started","thread_id":"01a1eb38"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `fake-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_3","type":"mcp_tool_call","server":"opensourcebook","tool":"reply","arguments":{"text":"pong"},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"opensourcebook","tool":"reply","arguments":{"text":"pong"},"result":{"content":[{"type":"text","text":"Sent."}],"structured_content":null},"error":null,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0}}',
];

/** A turn with no login: it retries, then fails. */
const SIGNED_OUT = [
  '{"type":"thread.started","thread_id":"01a1eb3b"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized"}}',
  '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}',
];

const CATALOG = JSON.stringify([
  { slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list" },
]);

test("its command line with Open Sourcebook's tools only: JSON events, every tool of its own off, no prompts, only Open Sourcebook's MCP server, Open Sourcebook's instructions", () => {
  const args = codexArgs({ ...base, model: "gpt-6-luna", effort: "high" });
  assert.deepEqual(args.slice(0, 6), ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"]);
  const values = (flag: string) => args.filter((_, i) => args[i - 1] === flag);
  const value = (flag: string, prefix = "") => values(flag).find((a) => a.startsWith(prefix));
  assert.equal(value("-s"), "read-only");
  for (const feature of ["shell_tool", "unified_exec", "view_image", "multi_agent", "apps", "plugins", "hooks", "browser_use", "computer_use"]) assert.ok(values("-c").includes(`features.${feature}=false`), feature);
  assert.ok(values("-c").includes('web_search="disabled"'));
  assert.ok(!args.includes("--disable"), "never --disable, which refuses a feature this Codex doesn't know");
  assert.equal(value("-C"), base.cwd);
  assert.equal(value("-m"), "gpt-6-luna");
  assert.equal(value("-c", "approval_policy"), 'approval_policy="never"');
  assert.equal(value("-c", "mcp_servers.opensourcebook.url"), 'mcp_servers.opensourcebook.url="http://127.0.0.1:8650/mcp/t1"');
  assert.equal(value("-c", "mcp_servers.opensourcebook.http_headers"), 'mcp_servers.opensourcebook.http_headers={"Authorization"="Bearer s3cret"}');
  assert.equal(value("-c", "mcp_servers.opensourcebook.default_tools_approval_mode"), 'mcp_servers.opensourcebook.default_tools_approval_mode="approve"');
  assert.equal(value("-c", "model_reasoning_effort"), 'model_reasoning_effort="high"');
  // TOML strings: quotes and new lines escaped, as JSON escapes them.
  assert.ok(value("-c", "developer_instructions")!.startsWith('developer_instructions="Make \\"the video\\".\\nThen stop.'));
  assert.ok(!values("-c").some((v) => v.startsWith("model_provider")), "its own provider and login");
  assert.equal(args.at(-1), "-", "the prompt comes on stdin");
});

test("the box needs an API key the person gave the connector; without one a workspace turn is refused", async () => {
  assert.equal(codexAdapter().boxing?.unready(), NO_CODEX_KEY);
  assert.equal(codexAdapter({ apiKey: "sk-fake" }).boxing?.unready(), undefined);
  assert.equal(codexAdapter().filesOnly, undefined, "no files-only folder: it reads files only through its shell");
  const box = boxForPlatform("darwin", () => true)!;
  const end = await codexAdapter({ bin: "/nonexistent/codex" }).run({ ...base, workspace: { access: "full" as const, box, connectorPort: 1 } }).done;
  assert.deepEqual(end, { ok: false, problem: "error", detail: NO_CODEX_KEY });
  const upstream = codexAdapter({ apiKey: "sk-fake" }).boxing!.upstream!()!;
  assert.deepEqual(upstream.headers, { authorization: "Bearer sk-fake" });
  assert.ok(upstream.allows("POST", "/v1/responses") && upstream.allows("GET", "/v1/models") && !upstream.allows("POST", "/v1/files"));
});

test("inside the box its own tools are on, it keeps its state in a folder of its own, its model calls go through the connector, and the person's login stays shut", { skip: process.platform === "win32" && "the box is macOS's sandbox; its profile names POSIX paths" }, () => {
  // By its real path, as the box names every path (a Mac's temp folder sits behind a link).
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-tmp-")));
  try {
    const box = boxForPlatform("darwin", () => true)!;
    const spec = { ...base, workspace: { access: "full" as const, box, connectorPort: 8650, model: { baseUrl: "http://127.0.0.1:8650/model/t1", secret: "turn-secret" } } };
    const args = codexArgs(spec);
    assert.equal(args[args.indexOf("-s") + 1], "danger-full-access");
    assert.ok(!args.some((a) => a.startsWith("features.")), "its own tools on");
    assert.ok(args.includes('model_provider="opensourcebookbox"'));
    assert.ok(args.includes('model_providers.opensourcebookbox={name="OpenAI through Open Sourcebook",base_url="http://127.0.0.1:8650/model/t1/v1",wire_api="responses",env_key="CODEX_API_KEY",supports_websockets=false}'));
    const command = boxedCodex("codex", args, spec, { PATH: "/usr/bin", HOME: "/Users/ann", OPENAI_API_KEY: "theirs", OPENSOURCEBOOK_CONNECTOR_TOKEN: "x" }, "/Users/ann", tmp);
    assert.equal(command.bin, SANDBOX_EXEC);
    const profile = command.args[1]!;
    assert.ok(profile.includes(`(subpath "${codexBoxHome(tmp)}")`));
    assert.ok(profile.includes('(subpath "/Users/ann/.codex/auth.json"))'));
    assert.doesNotMatch(profile, /allow[^\n]*\/Users\/ann\/\.codex/);
    assert.deepEqual(command.env, { PATH: "/usr/bin", HOME: "/Users/ann", CODEX_HOME: codexBoxHome(tmp), CODEX_API_KEY: "turn-secret" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("what it says about itself: not installed, installed and not signed in, ready, ready on a key, and the models it lists", async () => {
  assert.deepEqual(await codexAdapter({ bin: "/nonexistent/codex" }).info(), { installed: false });
  const signedOut = fakeCli([{ args: "--version", out: "codex-cli 0.166.0\n" }, { args: "login status", out: "Not logged in\n", code: 1 }, { args: "debug models", out: CATALOG }]);
  const signedIn = fakeCli([{ args: "--version", out: "codex-cli 0.166.0\n" }, { args: "login status", out: "Logged in using ChatGPT\n" }, { args: "debug models", out: "not json" }]);
  try {
    const models = [{ id: "gpt-6.1-terra", label: "GPT-6.1 Terra" }, { id: "gpt-6-luna", label: "GPT-6-Luna" }];
    assert.deepEqual(await codexAdapter({ bin: signedOut.bin }).info(), { installed: true, version: "0.166.0", signedIn: false, models });
    assert.deepEqual(await codexAdapter({ bin: signedOut.bin, apiKey: "sk-fake" }).info(), { installed: true, version: "0.166.0", signedIn: false, apiKey: true, note: CODEX_ON_KEY, models });
    assert.deepEqual(await codexAdapter({ bin: signedIn.bin, apiKey: "sk-fake" }).info(), { installed: true, version: "0.166.0", signedIn: true });
    assert.ok(!signedIn.calls().some((c) => c.includes("auth.json")), "only its own status command");
  } finally {
    signedOut.remove();
    signedIn.remove();
  }
  assert.deepEqual(readCodexModels('{"models":[{"slug":"a","visibility":"list"}]}'), [{ id: "a", label: "a" }]);
});

test("each Codex model says whether it is quick, good or best from its own description in Codex's list, and says nothing where the description doesn't", () => {
  const list = JSON.stringify({
    models: [
      { slug: "m-small", display_name: "Small", visibility: "list", description: "Fast and affordable model for easier tasks." },
      { slug: "m-old-small", display_name: "Old small", visibility: "list", description: "Legacy fast model for simpler tasks." },
      { slug: "m-mid", display_name: "Mid", visibility: "list", description: "Previous generation model for coding and everyday work." },
      { slug: "m-old-mid", display_name: "Old mid", visibility: "list", description: "Legacy balanced model for agentic coding." },
      { slug: "m-big", display_name: "Big", visibility: "list", description: "Previous generation model for complex coding and professional work." },
      { slug: "m-new", display_name: "New", visibility: "list", description: "Efficient model that excels at visual understanding and computer use." },
      { slug: "m-mixed", display_name: "Mixed", visibility: "list", description: "Fast enough for everyday work." },
      { slug: "m-none", display_name: "None", visibility: "list" },
    ],
  });
  assert.deepEqual(readCodexModels(list), [
    { id: "m-small", label: "Small", tier: "fast" },
    { id: "m-old-small", label: "Old small", tier: "fast" },
    { id: "m-mid", label: "Mid", tier: "balanced" },
    { id: "m-old-mid", label: "Old mid", tier: "balanced" },
    { id: "m-big", label: "Big", tier: "strong" },
    { id: "m-new", label: "New" },
    { id: "m-mixed", label: "Mixed" },
    { id: "m-none", label: "None" },
  ]);
});

test("a turn: signed in, it runs on its own login with the prompt on stdin and Open Sourcebook's settings kept out of its environment; the reply and tokens are read", async () => {
  const cli = fakeCli([{ args: "login status", out: "Logged in using ChatGPT\n" }, { args: "exec --json", out: `${TURN.join("\n")}\n` }]);
  const saved = { key: process.env.OPENSOURCEBOOK_OPENAI_API_KEY, token: process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN };
  process.env.OPENSOURCEBOOK_OPENAI_API_KEY = "sk-in-connector-env";
  process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = "connector-token";
  try {
    const end = await codexAdapter({ bin: cli.bin, apiKey: "sk-fake" }).run({ ...base, cwd: tmpdir(), model: "gpt-6-luna" }).done;
    assert.deepEqual(end, { ok: true, text: "Done.", model: "gpt-6-luna", tokensIn: 200, inputTokens: 200, tokensOut: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.deepEqual(cli.stdins(), ["p"]);
    const env = cli.env();
    assert.ok(!env.some((line) => line.startsWith("OPENSOURCEBOOK_") || line.startsWith("CODEX_API_KEY=")), "signed in: no key, and none of Open Sourcebook's settings");
  } finally {
    process.env.OPENSOURCEBOOK_OPENAI_API_KEY = saved.key;
    process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = saved.token;
    if (saved.key === undefined) delete process.env.OPENSOURCEBOOK_OPENAI_API_KEY;
    if (saved.token === undefined) delete process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
    cli.remove();
  }
});

test("a turn: not signed in, it runs on the person's key when there is one, and says it is signed out at once when there is none", async () => {
  const cli = fakeCli([{ args: "login status", out: "Not logged in\n", code: 1 }, { args: "exec --json", out: `${SIGNED_OUT.join("\n")}\n`, code: 1 }]);
  try {
    const none = await codexAdapter({ bin: cli.bin }).run({ ...base, cwd: tmpdir() }).done;
    assert.equal(none.problem, "agentSignedOut");
    assert.ok(!cli.calls().some((c) => c.startsWith("exec")), "it is not started without a login or a key");
    const keyed = await codexAdapter({ bin: cli.bin, apiKey: "sk-fake" }).run({ ...base, cwd: tmpdir() }).done;
    assert.ok(cli.env().includes("CODEX_API_KEY=sk-fake"), "the key, as Codex takes one for a single run");
    // Here the stand-in still answers 401, as a wrong key would.
    assert.equal(keyed.problem, "agentSignedOut");
    assert.equal(keyed.ok, false);
  } finally {
    cli.remove();
  }
});

test("a turn it refuses before any work (a model its account does not offer) ends as an error with its own words for the person", async () => {
  const refused = [
    '{"type":"thread.started","thread_id":"01a1eb3c"}',
    '{"type":"turn.started"}',
    `{"type":"error","message":"The 'some-model' model is not supported when using Codex with a ChatGPT account."}`,
    `{"type":"turn.failed","error":{"message":"The 'some-model' model is not supported when using Codex with a ChatGPT account."}}`,
  ];
  const cli = fakeCli([{ args: "login status", out: "Logged in using ChatGPT\n" }, { args: "exec --json", out: `${refused.join("\n")}\n`, code: 1 }]);
  try {
    const end = await codexAdapter({ bin: cli.bin }).run({ ...base, cwd: tmpdir(), model: "some-model" }).done;
    assert.equal(end.ok, false);
    assert.equal(end.problem, "error");
    assert.equal(end.said, "The 'some-model' model is not supported when using Codex with a ChatGPT account.");
  } finally {
    cli.remove();
  }
});

test("its JSON events: the last message, token counts, a failed turn; its warnings and log lines are ignored", () => {
  const seen: Parameters<typeof readCodexLine>[1] = {};
  for (const line of ["2026-11-16T17:52:01Z ERROR codex_models_manager: failed", ...TURN]) readCodexLine(line, seen);
  assert.deepEqual(seen, { text: "Done.", completed: true, tokensIn: 200, inputTokens: 200, tokensOut: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  // Cached input is included inside Codex's input_tokens and separated into cacheReadTokens.
  const cached: Parameters<typeof readCodexLine>[1] = {};
  readCodexLine('{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":380,"output_tokens":15}}', cached);
  assert.deepEqual(cached, { completed: true, tokensIn: 500, inputTokens: 120, cacheReadTokens: 380, tokensOut: 15 });
  const failed: Parameters<typeof readCodexLine>[1] = {};
  for (const line of SIGNED_OUT) readCodexLine(line, failed);
  assert.match(failed.failed!, /401 Unauthorized/);
  assert.equal(classifyCodex(failed.failed!), "agentSignedOut");
  assert.equal(classifyCodex("You exceeded your current quota"), "agentLimit");
  assert.equal(classifyCodex("stream disconnected"), "error");
  assert.ok(OWN_TOOL_FEATURES.includes("shell_tool"));
});

test("codexAdapter sets high work effort and weights its efforts", () => {
  const adapter = codexAdapter();
  assert.deepEqual(adapter.defaultEfforts, { work: "high" });
  assert.deepEqual(
    adapter.efforts!.map((e) => [e.id, e.weight]),
    [["low", "light"], ["medium", "medium"], ["high", "high"], ["xhigh", "max"], ["max", "max"]],
  );
});
