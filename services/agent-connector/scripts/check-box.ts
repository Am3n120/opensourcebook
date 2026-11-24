/**
 * Checks the box on this Mac, for Claude Code: `npm run check-box` (reads this folder's .env like `npm start`).
 *
 * 1. Runs a set of commands inside the very box a boxed Claude Code turn gets and says which ones the walls let
 *    through: the workspace, the web and the connector should be open; the person's login, keychains, home folder,
 *    other local ports and system writes should be shut.
 * 2. Runs one real boxed turn of the real Claude Code through a connector started here, with a stand-in engine whose
 *    only tool is `reply`: the agent runs a few commands in its workspace with its own shell and replies with their exit
 *    codes. Its model calls go through the connector, which adds the API key. With OPENSOURCEBOOK_ANTHROPIC_API_KEY set that is
 *    Anthropic itself; without it, a stand-in model here that asks for the same commands and the reply, so everything
 *    but the model itself is the real thing, with no key and no login.
 *
 * It prints what passed and what didn't, never a key or a file's contents. It never uses a subscription login, and
 * it never opens a login file even if a wall were down: those are only asked whether they could be read (`test -r`).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boxConfigDir, claudeAdapter, claudeBoxEnv, claudeBoxSpec } from "../src/agents/claude.ts";
import { AgentRegistry } from "../src/agents/registry.ts";
import type { TurnSpec } from "../src/agents/types.ts";
import { boxForPlatform, boxTemp } from "../src/box.ts";
import { carryOldSettings, MCP_SERVER } from "../src/names.ts";
import { createConnector } from "../src/server.ts";

carryOldSettings();

const box = boxForPlatform();
if (!box) {
  console.log("No box on this computer (macOS with /usr/bin/sandbox-exec only).");
  process.exit(1);
}
const home = homedir();
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

// A connector port the box opens, and another local port it must not reach.
const open = createServer((_q, r) => r.end("ok"));
const shut = createServer((_q, r) => r.end("ok"));
const openPort = await listen(open);
const shutPort = await listen(shut);
const work = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-box-check-")));
// The agent's own temporary folder, as the connector makes one for each boxed turn.
const ownTmp = await boxTemp();
const spec: TurnSpec = { turnId: "check", systemPrompt: "", prompt: "", cwd: work, mcp: { name: MCP_SERVER, url: "", headers: {} }, workspace: { access: "full" as const, box, connectorPort: openPort, tmp: ownTmp, model: { baseUrl: `http://127.0.0.1:${openPort}/model/check`, secret: "turn-secret-for-the-check" } } };
// Another program's socket and files in the shared temporary folders, made here for the check.
const id = `opensourcebook-box-check-${process.pid}`;
const sharedSocket = `/private/tmp/${id}.sock`;
const sharedFile = `/private/tmp/${id}.txt`;
const userTemp = realpathSync(tmpdir());
const userFile = join(userTemp, `${id}.txt`);
writeFileSync(sharedFile, "another program's file");
writeFileSync(userFile, "another program's file");
const socketServer = createSocketServer((socket) => {
  socket.on("error", () => undefined);
  socket.end("hi\n");
});
await new Promise<void>((resolve) => socketServer.listen(sharedSocket, resolve));
const claudeBin = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim() || "claude";
mkdirSync(boxConfigDir(), { recursive: true, mode: 0o700 });
const boxSpec = claudeBoxSpec(claudeBin, spec);
const env = claudeBoxEnv(spec);

/**
 * Runs `command` in the box; the exit code and the first line of what it said on stderr, never its output. Not
 * spawnSync: the stand-in connector in this same process has to keep answering while the command runs.
 */
function inBox(command: string): Promise<{ code: number | null; said: string; out: string }> {
  const wrapped = box!.wrap("/bin/sh", ["-c", command], boxSpec);
  return new Promise((resolve) => {
    const child = spawn(wrapped.bin, wrapped.args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, said: err.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "", out: out.trim() });
    });
  });
}

const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
const probes: Array<{ what: string; command: string; expect: "open" | "shut"; ok?: (r: Awaited<ReturnType<typeof inBox>>) => boolean }> = [
  { what: "write in the workspace", command: "echo ok > note.txt && cat note.txt >/dev/null", expect: "open" },
  { what: "the web (https://example.com)", command: "curl -sS -o /dev/null -w '%{http_code}' https://example.com", expect: "open", ok: (r) => r.code === 0 && r.out === "200" },
  { what: "this connector's port", command: `curl -sS -o /dev/null http://127.0.0.1:${openPort}/`, expect: "open" },
  { what: "claude --version", command: `${q(claudeBin)} --version >/dev/null`, expect: "open" },
  { what: "python3 and ffmpeg", command: "python3 -c 'print(1)' >/dev/null && ffmpeg -version >/dev/null", expect: "open" },
  { what: "its own TMPDIR", command: 'echo ok > "$TMPDIR/a" && cat "$TMPDIR/a" >/dev/null && mktemp "$TMPDIR/x.XXXXXX" >/dev/null', expect: "open" },
  { what: "a Unix socket in /private/tmp", command: `/usr/bin/nc -U ${q(sharedSocket)} </dev/null | grep -q hi`, expect: "shut" },
  { what: "read a file in /private/tmp", command: `cat ${q(sharedFile)} >/dev/null`, expect: "shut" },
  { what: "list /private/tmp", command: "ls /private/tmp >/dev/null", expect: "shut" },
  { what: "write in /private/tmp", command: `touch ${q(`/private/tmp/${id}-w`)}`, expect: "shut" },
  { what: "read a file in your /private/var/folders temp", command: `cat ${q(userFile)} >/dev/null`, expect: "shut" },
  { what: "write in your /private/var/folders temp", command: `touch ${q(join(userTemp, `${id}-w`))}`, expect: "shut" },
  { what: "your Claude login file (asked, never opened)", command: `test -r ${q(join(home, ".claude", ".credentials.json"))}`, expect: "shut" },
  { what: "~/.claude.json (asked, never opened)", command: `test -r ${q(join(home, ".claude.json"))}`, expect: "shut" },
  { what: "~/.claude folder", command: `ls ${q(join(home, ".claude"))} >/dev/null`, expect: "shut" },
  { what: "your keychain files", command: `ls ${q(join(home, "Library", "Keychains"))} >/dev/null`, expect: "shut" },
  { what: "your Claude Code keychain item", command: "security find-generic-password -s 'Claude Code-credentials' >/dev/null", expect: "shut" },
  { what: "Desktop", command: `ls ${q(join(home, "Desktop"))} >/dev/null`, expect: "shut" },
  { what: "Documents", command: `ls ${q(join(home, "Documents"))} >/dev/null`, expect: "shut" },
  { what: "~/.ssh", command: `ls ${q(join(home, ".ssh"))} >/dev/null`, expect: "shut" },
  { what: "~/.codex", command: `ls ${q(join(home, ".codex"))} >/dev/null`, expect: "shut" },
  { what: "write in the home folder", command: `touch ${q(join(home, "opensourcebook-box-check-probe"))}`, expect: "shut" },
  { what: "write outside temp folders", command: "touch /usr/local/opensourcebook-box-check-probe", expect: "shut" },
  { what: "another local port", command: `curl -sS -m 5 -o /dev/null http://127.0.0.1:${shutPort}/`, expect: "shut" },
];

console.log(`Part 1: the walls (Claude at ${claudeBin})`);
let failed = 0;
for (const probe of probes) {
  const r = await inBox(probe.command);
  const opened = probe.ok ? probe.ok(r) : r.code === 0;
  if (probe.expect === "open" && !opened && r.code === null) r.said ||= "timed out";
  const right = (probe.expect === "open") === opened;
  if (!right) failed++;
  console.log(`  ${right ? "PASS" : "FAIL"}  ${probe.what}: ${opened ? "open" : "shut"} (expected ${probe.expect})${!opened && r.said ? ` [${r.said}]` : ""}`);
}
const names = Object.keys(env).sort();
console.log(`  The box's environment has only: ${names.join(", ")}`);
const key = process.env.OPENSOURCEBOOK_ANTHROPIC_API_KEY?.trim();
const envIn = await inBox("env");
const leaked = key ? envIn.out.includes(key) : false;
console.log(`  ${leaked ? "FAIL" : "PASS"}  the API key is ${leaked ? "VISIBLE" : "not visible"} to commands in the box`);
if (leaked) failed++;
open.close();
shut.close();
socketServer.close();
for (const path of [sharedFile, userFile, `/private/tmp/${id}-w`, join(userTemp, `${id}-w`), ownTmp]) rmSync(path, { recursive: true, force: true });

{
  const standIn = key ? undefined : await standInModel();
  console.log(`\nPart 2: one real boxed turn, its model calls through the connector to ${standIn ? "a stand-in model here (OPENSOURCEBOOK_ANTHROPIC_API_KEY is not set)" : "Anthropic, with your API key"}`);
  const turnWork = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-box-turn-")));
  let finished: (body: Record<string, unknown>) => void = () => undefined;
  const finish = new Promise<Record<string, unknown>>((resolve) => (finished = resolve));
  let replied: unknown;
  const engine = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (request.url?.endsWith("/finish")) finished(body);
    if (request.url?.endsWith("/tools")) replied = body.arguments;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(request.url?.endsWith("/tools") ? { text: "Sent.", isError: false } : { ok: true }));
  });
  const enginePort = await listen(engine);
  const { server } = createConnector({ token: "check-box-connector-token", agents: new AgentRegistry().register(claudeAdapter(standIn ? { apiKey: "stand-in-key", apiOrigin: standIn.origin } : { apiKey: key! })), defaults: { agent: "claude", model: "haiku" }, box, log: (line) => console.log(`  [connector] ${line}`) });
  const connectorPort = await listen(server);
  const prompt = [
    "This is a check of your workspace. Use your Bash tool to run each of these commands on its own and note its exit code:",
    "1. echo hello > note.txt",
    "2. curl -sS -o /dev/null https://example.com",
    `3. ls ${q(join(home, "Desktop"))} > /dev/null`,
    `4. test -r ${q(join(home, ".claude.json"))}`,
    "Then call the reply tool once with text listing only the four exit codes, like: 1=0 2=0 3=1 4=1. Do not include any command output.",
  ].join("\n");
  const started = await fetch(`http://127.0.0.1:${connectorPort}/turns`, {
    method: "POST",
    headers: { authorization: "Bearer check-box-connector-token", "content-type": "application/json" },
    body: JSON.stringify({
      turnId: "check-1",
      systemPrompt: "You check a workspace for Open Sourcebook. Do exactly what the message asks.",
      prompt,
      tools: [{ name: "reply", description: "Send your answer and end the turn.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
      callback: { url: `http://127.0.0.1:${enginePort}/v1/agent-turns/check-1`, token: "engine-token" },
      timeoutMs: 180_000,
      workspace: { path: turnWork },
    }),
  });
  console.log(`  start: ${started.status} ${JSON.stringify(await started.json())}`);
  const end = await finish;
  console.log(`  end: ${JSON.stringify({ outcome: end.outcome, problem: end.problem, model: end.model, tokensIn: end.tokensIn, tokensOut: end.tokensOut })}`);
  console.log(`  the agent replied: ${JSON.stringify(replied)}`);
  if (standIn) console.log(`  the stand-in model was called ${standIn.calls.length} time(s), each with the key the connector added: ${standIn.calls.every((c) => c.key === "stand-in-key" && !c.authorization) ? "yes" : "NO"}`);
  server.close();
  engine.close();
  standIn?.server.close();
  rmSync(turnWork, { recursive: true, force: true });
}

/**
 * A stand-in for Anthropic's Messages API: the first call asks for one Bash command (the probes), the second calls
 * Open Sourcebook's reply tool with what the command printed, the rest answer "Done.". Streams as Anthropic does when asked to.
 */
async function standInModel(): Promise<{ origin: string; server: Server; calls: Array<{ key?: string; authorization?: string }> }> {
  const calls: Array<{ key?: string; authorization?: string }> = [];
  const commands = [
    "echo hello > note.txt; echo 1=$?",
    "curl -sS -m 20 -o /dev/null https://example.com; echo 2=$?",
    `ls ${q(join(home, "Desktop"))} > /dev/null 2>&1; echo 3=$?`,
    `test -r ${q(join(home, ".claude.json"))}; echo 4=$?`,
  ].join("; ");
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!request.url?.startsWith("/v1/messages")) return void response.writeHead(404).end();
    if (request.url.startsWith("/v1/messages/count_tokens")) return void response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
    calls.push({ key: request.headers["x-api-key"] as string | undefined, authorization: request.headers.authorization });
    const body = JSON.parse(raw || "{}") as { stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> };
    const results = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: { type?: string }) => b.type === "tool_result") as Array<{ content?: unknown }>;
    const hasTools = (body.tools ?? []).some((t) => t.name === "Bash");
    const said = (r: { content?: unknown }) => (typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((c: { text?: string }) => c.text ?? "").join("") : "");
    const block =
      hasTools && results.length === 0
        ? { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: commands, description: "Run the workspace checks" } }
        : hasTools && results.length === 1
          ? { type: "tool_use", id: "toolu_2", name: `mcp__${MCP_SERVER}__reply`, input: { text: said(results[0]!).replace(/\s+/g, " ").trim() } }
          : { type: "text", text: "Done." };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    const message = { id: `msg_${calls.length}`, type: "message", role: "assistant", model: "stand-in", content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
    if (!body.stream) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (block.type === "tool_use") {
      send("content_block_start", { index: 0, content_block: { ...block, input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify((block as { input: unknown }).input) } });
    } else {
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: (block as { text: string }).text } });
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", {});
    response.end();
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, server, calls };
}
rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} wall check(s) failed.` : "\nAll wall checks passed.");
process.exit(failed ? 1 : 0);
