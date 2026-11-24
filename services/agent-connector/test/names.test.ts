/** A copy from before the rename keeps working: its settings, its state folder and its file in the home folder. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultStateDir, passedFor } from "../src/agents/antigravity.ts";
import { agentEnv } from "../src/agents/process.ts";
import { carryOldSettings, connectorHome, defaultUsageLog, MCP_SERVER } from "../src/names.ts";

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `opensourcebook-names-${name}-`)));

test("the server every agent is given is named opensourcebook", () => {
  assert.equal(MCP_SERVER, "opensourcebook");
});

test("a setting under its old name is read under its new one", () => {
  const env = carryOldSettings({
    RE_CONNECTOR_TOKEN: "old-token",
    RE_ANTHROPIC_API_KEY: "old-anthropic",
    RE_OPENAI_API_KEY: "old-openai",
    RE_GEMINI_API_KEY: "old-gemini",
    RE_AGENT: "codex",
    RE_AGENT_MODEL: "m",
    RE_AGENT_WORKSPACE: "off",
    RE_USAGE_LOG: "/x/usage.jsonl",
    PATH: "/bin",
  });
  assert.equal(env.OPENSOURCEBOOK_CONNECTOR_TOKEN, "old-token");
  assert.equal(env.OPENSOURCEBOOK_ANTHROPIC_API_KEY, "old-anthropic");
  assert.equal(env.OPENSOURCEBOOK_OPENAI_API_KEY, "old-openai");
  assert.equal(env.OPENSOURCEBOOK_GEMINI_API_KEY, "old-gemini");
  assert.equal(env.OPENSOURCEBOOK_AGENT, "codex");
  assert.equal(env.OPENSOURCEBOOK_AGENT_MODEL, "m");
  assert.equal(env.OPENSOURCEBOOK_AGENT_WORKSPACE, "off");
  assert.equal(env.OPENSOURCEBOOK_USAGE_LOG, "/x/usage.jsonl");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OPENSOURCEBOOK_PATH, undefined);
});

test("a setting under its new name wins over the old one, even when it is empty", () => {
  const env = carryOldSettings({ RE_AGENT: "codex", OPENSOURCEBOOK_AGENT: "claude", RE_USAGE_LOG: "/old", OPENSOURCEBOOK_USAGE_LOG: "" });
  assert.equal(env.OPENSOURCEBOOK_AGENT, "claude");
  assert.equal(env.OPENSOURCEBOOK_USAGE_LOG, "");
});

test("the old state folder setting becomes OPENSOURCEBOOK_STATE, never the installer's OPENSOURCEBOOK_HOME", () => {
  const env = carryOldSettings({ RE_HOME: "/data/state" });
  assert.equal(env.OPENSOURCEBOOK_STATE, "/data/state");
  assert.equal(env.OPENSOURCEBOOK_HOME, undefined);
  const installed = carryOldSettings({ RE_HOME: "/data/state", OPENSOURCEBOOK_HOME: "/installer" });
  assert.equal(installed.OPENSOURCEBOOK_HOME, "/installer");
  assert.equal(installed.OPENSOURCEBOOK_STATE, "/data/state");
});

test("an agent is given none of the settings, under either name", () => {
  const env = agentEnv(carryOldSettings({ RE_ANTHROPIC_API_KEY: "k", RE_CONNECTOR_TOKEN: "t", OPENSOURCEBOOK_OPENAI_API_KEY: "o", HOME: "/h" }), { EXTRA: "1" });
  assert.deepEqual(env, { HOME: "/h", EXTRA: "1" });
});

test("the usage log, when its path is not handed over, is in the state folder that is there", () => {
  const root = folder("root");
  try {
    const fresh = join(root, ".opensourcebook", "logs", "usage.jsonl");
    const old = join(root, ".re", "logs", "usage.jsonl");
    assert.equal(defaultUsageLog(root, {}), fresh, "a new copy uses the new name");
    mkdirSync(join(root, ".re", "logs"), { recursive: true });
    writeFileSync(old, "{}\n");
    assert.equal(defaultUsageLog(root, {}), old, "a copy with only the old folder is read where it is");
    assert.deepEqual(readdirSync(root), [".re"], "and nothing is moved or made");
    mkdirSync(join(root, ".opensourcebook"));
    assert.equal(defaultUsageLog(root, {}), fresh, "the new folder wins once it is there");
    assert.equal(existsSync(old), true);
    assert.equal(defaultUsageLog(root, { OPENSOURCEBOOK_STATE: "/data/state" }), join("/data/state", "logs", "usage.jsonl"));
    assert.equal(defaultUsageLog(root, carryOldSettings({ RE_HOME: "/data/old" })), join("/data/old", "logs", "usage.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the connector's file in the home folder is read where it already is", () => {
  const home = folder("home");
  try {
    const fresh = join(home, ".opensourcebook-agent-connector");
    const old = join(home, ".re-agent-connector");
    assert.equal(connectorHome(home), fresh);
    assert.equal(defaultStateDir(home), fresh);
    mkdirSync(old);
    writeFileSync(join(old, "antigravity-check.json"), JSON.stringify({ version: "1.6.0" }));
    assert.equal(defaultStateDir(home), old);
    assert.equal(passedFor(defaultStateDir(home)), "1.6.0", "what an older copy's check found still counts");
    assert.deepEqual(readdirSync(home), [".re-agent-connector"], "and nothing is moved or made");
    mkdirSync(fresh);
    assert.equal(defaultStateDir(home), fresh);
    assert.equal(existsSync(join(old, "antigravity-check.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the connector starts on a .env from before the rename", async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const found = (s.address() as { port: number }).port;
      s.close(() => resolve(found));
    });
  });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT" && !k.startsWith("OPENSOURCEBOOK_") && !k.startsWith("RE_")));
  const token = "o".repeat(24);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...inherited, RE_CONNECTOR_TOKEN: token, RE_CONNECTOR_PORT: String(port), RE_AGENT_WORKSPACE: "off", RE_USAGE_LOG: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stdout.on("data", (d) => (said += d));
  child.stderr.on("data", (d) => (said += d));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const started = Date.now();
    while (!said.includes(`agent connector on http://127.0.0.1:${port}`)) {
      assert.ok(child.exitCode === null && Date.now() - started < 20_000, `the connector did not start: ${said}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const usage = await fetch(`http://127.0.0.1:${port}/usage`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(usage.status, 200, "the old token is the connector's token");
    assert.equal(((await usage.json()) as { off?: boolean }).off, true, "and the old usage log setting is heard");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
