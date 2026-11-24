/**
 * Antigravity (`agy`): its command line in each mode, the files a turn gets and where, its gate, what it says about
 * itself, the check of its gate the connector runs on each computer, how a turn runs and ends, and reading its JSON events. The events below are in the shape Google's headless
 * page shows (antigravity.google/docs/cli/headless); no real `agy` has run against this adapter yet.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Box } from "../src/box.ts";
import {
  ANTIGRAVITY_FULL,
  antigravityAdapter,
  antigravityArgs,
  antigravityBoxEnv,
  antigravityBoxSpec,
  antigravityInput,
  antigravityMcp,
  BOX_SETTINGS,
  boxedAntigravity,
  boxHome,
  classifyAntigravity,
  GATE_HOOK,
  gateDecision,
  gateScript,
  geminiAllows,
  CANARY,
  checkAntigravity,
  couldNotCheck,
  defaultStateDir,
  NO_GEMINI_KEY,
  ON_LOGIN_BROKE,
  ON_LOGIN_CHECKING,
  passedFor,
  probePrompt,
  readAntigravityLine,
  readAntigravityModels,
  writeLoginTurnFiles,
} from "../src/agents/antigravity.ts";
import { fakeCli, nodeProgram } from "./fake-cli.ts";

const base = { turnId: "t1", systemPrompt: "You are Open Sourcebook's chat.", prompt: "hi", cwd: "/tmp/opensourcebook-agent-x", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer s3cret" } } };
const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
const boxedSpec = (cwd: string, tmp: string) => ({ ...base, cwd, workspace: { access: "full" as const, box, connectorPort: 8650, tmp, model: { baseUrl: "http://127.0.0.1:8650/model/t1", secret: "turn-secret" } } });

const TURN = [
  JSON.stringify({ event: "init", init: { cwd: "/tmp/x", tools: ["call_mcp_tool", "run_command"], permission_mode: "request-review", model: "gemini-3.8-flash-medium" } }),
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 0, state: "DONE", step_type: "user_input" } }),
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me " } }),
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 2, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: "opensourcebook", ToolName: "reply" }, output: "Sent." } } }),
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Done" } }),
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "." } }),
  JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "Done.", duration_seconds: 2, num_turns: 1, usage: { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 10884 } } }),
];
const ENDED = { ok: true, text: "Done.", model: "gemini-3.8-flash-medium", tokensIn: 10302, inputTokens: 2189, tokensOut: 582, cacheReadTokens: 8113 };

/** An `agy` stand-in that keeps a copy of the turn's `.agents` folder as it found it, then prints `out`. */
function capturingCli(out: string): { bin: string; captured: string; remove(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-fake-agy-")));
  writeFileSync(join(dir, "out"), out);
  const bin = nodeProgram(
    dir,
    "agy",
    `const fs = require("fs");
const dir = ${JSON.stringify(dir)};
if (process.argv[2] === "--version") { process.stdout.write("agy 1.6.0\\n"); process.exit(0); }
fs.writeFileSync(dir + "/args", process.argv.slice(2).join(" ") + "\\n");
fs.readFileSync(0);
if (fs.existsSync(".agents")) fs.cpSync(".agents", dir + "/agents", { recursive: true });
process.stdout.write(fs.readFileSync(dir + "/out"));
`,
  );
  return { bin, captured: dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The connector's own state with a pass of the gate's check kept for `version`. */
function passed(version = "1.6.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-state-"));
  writeFileSync(join(dir, "antigravity-check.json"), JSON.stringify({ version, passedAt: "2026-11-23T00:00:00.000Z" }));
  return dir;
}

/**
 * An `agy` stand-in for the check: a check turn (its prompt names the canary) goes as `mode` says. `obeys` asks the
 * gate in the folder's `.agents/hooks.json` before making the file, as the real one is meant to; `ignores` makes it
 * without asking; `lazy` tries nothing; `signedOut` says it is not signed in; `slow` obeys after a while. Any other
 * turn answers "Done.". Its version is in `version`, which a test may change.
 */
function fakeAgy(mode: "obeys" | "ignores" | "lazy" | "signedOut" | "slow"): { bin: string; dir: string; probes(): string[]; setVersion(v: string): void; remove(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-fake-agy-")));
  writeFileSync(join(dir, "version"), "agy 1.6.0\n");
  const bin = nodeProgram(
    dir,
    "agy",
    `const fs = require("fs"), cp = require("child_process");
const dir = ${JSON.stringify(dir)}, mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2).join(" ");
if (args.startsWith("--version")) { process.stdout.write(fs.readFileSync(dir + "/version", "utf8")); process.exit(0); }
if (!args.startsWith("--input-format")) process.exit(1);
const input = fs.readFileSync(0, "utf8");
const ok = (response) => { process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response } }) + "\\n"); process.exit(0); };
if (!input.includes(${JSON.stringify(CANARY)})) ok("Done.");
fs.appendFileSync(dir + "/probes", input);
if (mode === "signedOut") { process.stderr.write("Error: authentication required\\n"); process.exit(1); }
if (mode === "lazy") ok("I would rather not.");
if (mode === "ignores") { fs.writeFileSync(${JSON.stringify(CANARY)}, "hello"); ok("Made it."); }
const obey = () => {
  const hooks = JSON.parse(fs.readFileSync(".agents/hooks.json", "utf8"));
  const command = Object.values(hooks)[0].PreToolUse[0].hooks[0].command;
  const answer = JSON.parse(cp.execSync(command, { input: JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: ${JSON.stringify(CANARY)} } } }), encoding: "utf8" }));
  if (answer.decision !== "deny") fs.writeFileSync(${JSON.stringify(CANARY)}, "hello");
  ok("It was refused.");
};
if (mode === "slow") setTimeout(obey, 600); else obey();
`,
  );
  const read = () => (existsSync(join(dir, "probes")) ? readFileSync(join(dir, "probes"), "utf8") : "");
  return { bin, dir, probes: () => read().split("\n").filter((l) => l.includes(CANARY)), setVersion: (v) => writeFileSync(join(dir, "version"), `agy ${v}\n`), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test("its command line: stdin and events as JSON lines, no slash commands; every tool approved only in the box", () => {
  const login = antigravityArgs({ ...base, model: "gemini-3.8-flash-medium", effort: "high" });
  assert.deepEqual(login, ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--model", "gemini-3.8-flash-medium", "--effort", "high"]);
  assert.ok(!login.includes("--dangerously-skip-permissions"));
  assert.ok(!antigravityArgs(base).includes("--model") && !antigravityArgs(base).includes("--effort"), "its own default model and effort");
  assert.ok(!antigravityArgs(base).includes(base.prompt) && !antigravityArgs(base).includes("-p"), "the prompt goes on stdin");
  const files = antigravityArgs({ ...base, workspace: { access: "files", connectorPort: 8650 } });
  assert.ok(!files.includes("--dangerously-skip-permissions"));
  const boxed = antigravityArgs(boxedSpec("/w", "/t"));
  assert.ok(boxed.includes("--dangerously-skip-permissions"));
  assert.ok(!boxed.includes("--sandbox"), "its own sandbox can't run inside the box");
});

test("what it gets on stdin: one user event, Open Sourcebook's instructions before the prompt", () => {
  const line = antigravityInput(base);
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { event: "user", message: { content: "<instructions>\nYou are Open Sourcebook's chat.\n</instructions>\n\nhi" } });
});

test("the gate: Open Sourcebook's tools approved, every other tool refused, whatever it is called", () => {
  assert.deepEqual(gateDecision({ name: "call_mcp_tool", args: { ServerName: "opensourcebook", ToolName: "reply", Arguments: {} } }, "opensourcebook"), { decision: "auto_approve" });
  assert.deepEqual(gateDecision({ name: "mcp_opensourcebook_reply", args: {} }, "opensourcebook"), { decision: "auto_approve" });
  for (const call of [
    { name: "run_command", args: { CommandLine: "ls" } },
    { name: "call_mcp_tool", args: { ServerName: "github", ToolName: "x" } },
    { name: "mcp_github_x" },
    { name: "read_url_content" },
    { name: "search_web" },
    { name: "view_file" },
    { name: "write_to_file" },
    { name: "invoke_subagent" },
    { name: "some_tool_added_later" },
    {},
    null,
  ]) assert.equal(gateDecision(call, "opensourcebook").decision, "deny", JSON.stringify(call));
});

test("the gate's script answers the hook as gateDecision does", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-gate-test-"));
  try {
    const script = join(dir, "gate.mjs");
    writeFileSync(script, gateScript("opensourcebook"));
    const ask = (input: string) => JSON.parse(execFileSync(process.execPath, [script], { input, encoding: "utf8" }));
    assert.deepEqual(ask(JSON.stringify({ conversationId: "c", toolCall: { name: "call_mcp_tool", args: { ServerName: "opensourcebook", ToolName: "reply" } }, stepIdx: 2 })), { decision: "auto_approve" });
    assert.equal(ask(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "curl x" } } })).decision, "deny");
    assert.equal(ask("not json").decision, "deny");
    // For the check turn it also writes down each answer.
    const log = join(dir, "decisions.log");
    writeFileSync(script, gateScript("opensourcebook", log));
    assert.equal(ask(JSON.stringify({ toolCall: { name: "write_to_file", args: {} } })).decision, "deny");
    assert.equal(readFileSync(log, "utf8"), "deny\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn on the person's sign-in writes Open Sourcebook's MCP server and the gate in the turn's own folder, nothing else", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opensourcebook-agent-"));
  const gate = mkdtempSync(join(tmpdir(), "opensourcebook-agy-gate-"));
  try {
    writeLoginTurnFiles({ ...base, cwd }, gate);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".agents", "mcp_config.json"), "utf8")), antigravityMcp(base));
    assert.deepEqual(antigravityMcp(base), { mcpServers: { opensourcebook: { serverUrl: base.mcp.url, headers: base.mcp.headers, timeoutSeconds: 900 } } });
    const hooks = JSON.parse(readFileSync(join(cwd, ".agents", "hooks.json"), "utf8"));
    const pre = hooks[GATE_HOOK].PreToolUse[0];
    assert.equal(pre.matcher, "*", "every tool goes past the gate");
    assert.ok(pre.hooks[0].command.includes(join(gate, "gate.mjs")), "its script is outside the folder it works in");
    assert.ok(existsSync(join(gate, "gate.mjs")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(gate, { recursive: true, force: true });
  }
});

/** A sign-in turn's end, in a folder of its own. */
async function loginTurn(options: Parameters<typeof antigravityAdapter>[0]) {
  const cwd = mkdtempSync(join(tmpdir(), "opensourcebook-agent-"));
  try {
    return await antigravityAdapter(options).run({ ...base, cwd }).done;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("the gate's check passes when the file was refused and the gate said so: kept with its version, turns run, and a new version is checked again", async () => {
  const agy = fakeAgy("obeys");
  const stateDir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-state-"));
  try {
    const adapter = antigravityAdapter({ bin: agy.bin, stateDir });
    assert.equal((await adapter.info()).unavailable, ON_LOGIN_CHECKING, "never ready before a pass");
    const cwd = mkdtempSync(join(tmpdir(), "opensourcebook-agent-"));
    try {
      assert.deepEqual(await adapter.run({ ...base, cwd }).done, { ok: true, text: "Done." });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    assert.equal(agy.probes().length, 1, "one check turn, joined by the info and the turn");
    assert.equal(passedFor(stateDir), "1.6.0");
    assert.ok(JSON.parse(readFileSync(join(stateDir, "antigravity-check.json"), "utf8")).passedAt);
    assert.deepEqual(await antigravityAdapter({ bin: agy.bin, stateDir }).info(), { installed: true, version: "1.6.0" });
    assert.equal(agy.probes().length, 1, "a kept pass is not checked again");
    agy.setVersion("1.7.0");
    assert.equal((await loginTurn({ bin: agy.bin, stateDir })).ok, true);
    assert.equal(agy.probes().length, 2, "a new version is checked again");
    assert.equal(passedFor(stateDir), "1.7.0");
  } finally {
    agy.remove();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the gate's check fails closed: the file made, the agent not trying (asked twice), or not signed in", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-state-"));
  const ignores = fakeAgy("ignores");
  const lazy = fakeAgy("lazy");
  const signedOut = fakeAgy("signedOut");
  try {
    const broke = antigravityAdapter({ bin: ignores.bin, stateDir });
    assert.deepEqual(await loginTurn({ bin: ignores.bin, stateDir }), { ok: false, problem: "error", detail: ON_LOGIN_BROKE });
    await broke.info();
    assert.equal((await broke.run({ ...base, cwd: tmpdir() }).done).detail, ON_LOGIN_BROKE);
    assert.equal((await broke.info()).unavailable, ON_LOGIN_BROKE);
    assert.equal(passedFor(stateDir), undefined, "nothing kept");
    const idle = await loginTurn({ bin: lazy.bin, stateDir });
    assert.equal(idle.ok, false);
    assert.match(idle.detail!, /^Open Sourcebook could not check Antigravity yet: Antigravity did not try/);
    assert.equal(lazy.probes().length, 2, "asked once more");
    assert.ok(lazy.probes()[1]!.includes("you must actually attempt") && probePrompt(true).includes("you must actually attempt"));
    assert.equal((await loginTurn({ bin: signedOut.bin, stateDir })).detail, couldNotCheck("you are not signed in to Antigravity (run agy once to sign in)"));
    assert.equal(signedOut.probes().length, 1);
    assert.equal(passedFor(stateDir), undefined);
    assert.deepEqual(await checkAntigravity("/nonexistent/agy"), { ok: false, reason: couldNotCheck("/nonexistent/agy was not found"), retry: true });
  } finally {
    for (const agy of [ignores, lazy, signedOut]) agy.remove();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("while the check runs it says so, and only says ready once it passed", async () => {
  const agy = fakeAgy("slow");
  const stateDir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-state-"));
  try {
    const adapter = antigravityAdapter({ bin: agy.bin, stateDir });
    assert.equal((await adapter.info()).unavailable, ON_LOGIN_CHECKING);
    assert.equal((await adapter.info()).unavailable, ON_LOGIN_CHECKING);
    const cwd = mkdtempSync(join(tmpdir(), "opensourcebook-agent-"));
    try {
      assert.equal((await adapter.run({ ...base, cwd }).done).ok, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    assert.equal((await adapter.info()).unavailable, undefined);
    assert.equal(agy.probes().length, 1);
  } finally {
    agy.remove();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("what the check found is kept in the connector's own state, never under the person's ~/.gemini", async () => {
  const agy = fakeAgy("obeys");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal((await loginTurn({ bin: agy.bin })).ok, true);
    assert.equal(passedFor(defaultStateDir(home)), "1.6.0");
    assert.ok(existsSync(join(home, ".opensourcebook-agent-connector", "antigravity-check.json")));
    assert.equal(existsSync(join(home, ".gemini")), false);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    agy.remove();
    rmSync(home, { recursive: true, force: true });
  }
  // It has no files-only workspace, and none without a key in the box.
  assert.equal(antigravityAdapter().filesOnly, undefined);
  assert.equal((await antigravityAdapter().run({ ...base, cwd: tmpdir(), workspace: { access: "files", connectorPort: 8650 } }).done).ok, false);
  assert.equal((await antigravityAdapter().run(boxedSpec(tmpdir(), tmpdir())).done).detail, NO_GEMINI_KEY);
});

test("the turn that would run on the person's sign-in: its files in the turn's folder while it runs, removed after, never skip-permissions, never Open Sourcebook's settings", async () => {
  const cli = capturingCli(`${TURN.join("\n")}\n`);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-agent-")));
  const saved = process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
  process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = "connector-token";
  try {
    const end = await antigravityAdapter({ bin: cli.bin, stateDir: passed(), apiKey: "the-persons-key" }).run({ ...base, cwd }).done;
    assert.deepEqual(end, ENDED);
    const args = readFileSync(join(cli.captured, "args"), "utf8");
    assert.ok(args.includes("--sandbox") && !args.includes("--dangerously-skip-permissions"));
    assert.deepEqual(JSON.parse(readFileSync(join(cli.captured, "agents", "mcp_config.json"), "utf8")), antigravityMcp(base));
    assert.ok(existsSync(join(cli.captured, "agents", "hooks.json")));
    assert.equal(existsSync(join(cwd, ".agents")), false, "removed when the turn ends");
  } finally {
    if (saved === undefined) delete process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
    else process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = saved;
    cli.remove();
    rmSync(cwd, { recursive: true, force: true });
  }
  // A folder that already holds a .agents folder is not one of the turn's own.
  const held = mkdtempSync(join(tmpdir(), "opensourcebook-agent-"));
  mkdirSync(join(held, ".agents"));
  try {
    assert.equal((await antigravityAdapter({ bin: "/nonexistent/agy", stateDir: passed() }).run({ ...base, cwd: held }).done).ok, false);
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
});

test("in the box: its own home for the turn, the turn's secret as its key and the connector as its endpoint, never the person's key or ~/.gemini", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-box-tmp-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  try {
    const spec = boxedSpec("/Users/ann/opensourcebook/.data/v1/work", tmp);
    const env = antigravityBoxEnv(spec, { PATH: "/usr/bin", HOME: "/Users/ann", OPENSOURCEBOOK_CONNECTOR_TOKEN: "x", OPENSOURCEBOOK_GEMINI_API_KEY: "the-persons-key", GEMINI_API_KEY: "the-persons-key" });
    assert.equal(env.HOME, boxHome(tmp));
    assert.equal(env.GEMINI_API_KEY, "turn-secret");
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:8650/model/t1");
    assert.equal(env.TMPDIR, `${tmp}/`);
    assert.ok(!Object.values(env).includes("the-persons-key"));
    assert.ok(!Object.keys(env).some((k) => k.startsWith("OPENSOURCEBOOK_")));
    const command = boxedAntigravity("agy", spec, { PATH: "/usr/bin" }, home);
    assert.ok(command.args.includes("--dangerously-skip-permissions"));
    assert.deepEqual(JSON.parse(readFileSync(join(boxHome(tmp), ".gemini", "antigravity-cli", "settings.json"), "utf8")), BOX_SETTINGS);
    assert.equal(BOX_SETTINGS.modelProvider, "gemini");
    assert.deepEqual(JSON.parse(readFileSync(join(boxHome(tmp), ".gemini", "config", "mcp_config.json"), "utf8")), antigravityMcp(spec));
    assert.equal(existsSync(join(home, ".gemini")), false, "nothing written in the person's home folder");
    const boxSpec = antigravityBoxSpec("agy", spec, { PATH: "/usr/bin" }, home);
    assert.ok(boxSpec.deny!.includes(join(home, ".gemini")));
    assert.deepEqual(boxSpec.own, undefined, "nothing of its own login opened");
    assert.equal(boxSpec.tmp, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a boxed turn runs wrapped in the box and ends with its words and tokens", async () => {
  const cli = fakeCli([{ args: "--input-format", out: `${TURN.join("\n")}\n` }]);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-box-tmp-")));
  let wrapped: string[] = [];
  const recording: Box = { kind: "seatbelt", wrap: (bin, args) => ((wrapped = args), { bin, args }) };
  try {
    const spec = { ...boxedSpec(tmpdir(), tmp), workspace: { ...boxedSpec(tmpdir(), tmp).workspace, box: recording } };
    const end = await antigravityAdapter({ bin: cli.bin, apiKey: "the-persons-key" }).run(spec).done;
    assert.deepEqual(end, ENDED);
    assert.ok(wrapped.includes("--dangerously-skip-permissions"));
    assert.ok(!cli.env().some((line) => line.includes("the-persons-key")));
    assert.ok(cli.env().includes("GEMINI_API_KEY=turn-secret"));
    assert.deepEqual(cli.stdins().map((s) => JSON.parse(s).event), ["user"]);
  } finally {
    cli.remove();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("its key: only in the box, forwarded only for the Gemini API's model calls", () => {
  const adapter = antigravityAdapter({ apiKey: "the-persons-key" });
  assert.equal(adapter.boxing!.unready(), undefined);
  assert.equal(adapter.boxing!.note, ANTIGRAVITY_FULL);
  const upstream = adapter.boxing!.upstream!()!;
  assert.equal(upstream.origin, "https://generativelanguage.googleapis.com");
  assert.deepEqual(upstream.headers, { "x-goog-api-key": "the-persons-key" });
  assert.equal(antigravityAdapter().boxing!.unready(), NO_GEMINI_KEY);
  assert.equal(antigravityAdapter().boxing!.upstream!(), undefined);
  assert.ok(geminiAllows("POST", "/v1beta/models/gemini-3.8-flash:streamGenerateContent"));
  assert.ok(geminiAllows("POST", "/v1beta/models/gemini-3.8-flash:generateContent"));
  assert.ok(geminiAllows("POST", "/v1beta/models/gemini-3.8-flash:countTokens"));
  assert.ok(geminiAllows("GET", "/v1beta/models"));
  assert.ok(!geminiAllows("POST", "/v1beta/files"));
  assert.ok(!geminiAllows("POST", "/v1beta/cachedContents"));
  assert.ok(!geminiAllows("DELETE", "/v1beta/models/x"));
});

test("a turn's end: not installed, not signed in, out of quota, or another error in its own words", async () => {
  const tried = { stateDir: passed() };
  assert.deepEqual(await antigravityAdapter({ bin: "/nonexistent/agy" }).info(), { installed: false });
  assert.equal((await antigravityAdapter({ bin: "/nonexistent/agy", ...tried }).run({ ...base, cwd: mkdtempSync(join(tmpdir(), "opensourcebook-agent-")) }).done).problem, "agentMissing");
  const signedOut = fakeCli([{ args: "--version", out: "agy 1.6.0\n" }, { args: "--input-format", out: "", code: 1 }]);
  const failed = fakeCli([{ args: "--version", out: "agy 1.6.0\n" }, { args: "--input-format", out: `${JSON.stringify({ event: "result", result: { status: "ERROR", error: "Model gemini-9 is not available.", usage: { input_tokens: 0, output_tokens: 0 } } })}\n`, code: 1 }]);
  try {
    // Its words on stderr: `authentication required` (docs/cli/headless). The stand-in prints none, so the words are checked below.
    const end = await antigravityAdapter({ bin: failed.bin, ...tried }).run({ ...base, cwd: mkdtempSync(join(tmpdir(), "opensourcebook-agent-")) }).done;
    assert.equal(end.ok, false);
    assert.equal(end.problem, "error");
    assert.equal(end.said, "Model gemini-9 is not available.");
    assert.equal((await antigravityAdapter({ bin: signedOut.bin, ...tried }).run({ ...base, cwd: mkdtempSync(join(tmpdir(), "opensourcebook-agent-")) }).done).ok, false);
  } finally {
    signedOut.remove();
    failed.remove();
  }
  assert.equal(classifyAntigravity("Error: authentication required"), "agentSignedOut");
  assert.equal(classifyAntigravity("API key not valid. Please pass a valid API key."), "agentSignedOut");
  assert.equal(classifyAntigravity("RESOURCE_EXHAUSTED: quota exceeded"), "agentLimit");
  assert.equal(classifyAntigravity("boom"), "error");
});

test("its JSON events: the words since its last tool step or its result's response, the model, the tokens", () => {
  const seen: Parameters<typeof readAntigravityLine>[1] = {};
  for (const line of ["Loading…", ...TURN]) readAntigravityLine(line, seen);
  assert.deepEqual(seen, { model: "gemini-3.8-flash-medium", text: "Done.", status: "SUCCESS", tokensIn: 10302, inputTokens: 2189, tokensOut: 582, cacheReadTokens: 8113 });
  // Without a response its words since the last tool step are its last.
  const deltas: Parameters<typeof readAntigravityLine>[1] = {};
  for (const line of TURN.slice(0, -1)) readAntigravityLine(line, deltas);
  assert.equal(deltas.text, "Done.");
});

test("its models: what `agy models` lists, with tiers from their names; the documented ones otherwise", () => {
  assert.deepEqual(
    readAntigravityModels(["gemini-3.8-flash-medium        Gemini 3.8 Flash (Medium)", "gemini-pro-orchestrator-neon   Orchestrator (Neon)", "gemini-4-hydrogen-high  Gemini 4 Hydrogen (High)", "Models:", ""]),
    [
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", tier: "fast" },
      { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)", tier: "strong" },
      { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", tier: "balanced" },
    ],
  );
  const adapter = antigravityAdapter();
  assert.deepEqual(adapter.models!.map((m) => [m.id, m.tier]), [["gemini-3.8-flash-medium", "fast"], ["gemini-4-neon-xhigh", "strong"]]);
  assert.deepEqual(adapter.defaultModels, { chat: "gemini-3.8-flash-medium" });
  assert.equal(adapter.defaultEfforts, undefined, "a slug already names its level");
  assert.deepEqual(adapter.efforts!.map((e) => e.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(adapter.install, { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", url: "https://antigravity.google/docs/getting-started?tab=cli" });
  assert.equal(adapter.signIn, "agy");
});
