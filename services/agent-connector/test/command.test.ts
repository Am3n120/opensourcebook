/** How an agent's CLI is started on Windows, where npm installs it as a .cmd file, checked on any system. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cmdArgument, commandFor, findOnWindows, shimTarget } from "../src/agents/command.ts";

/** npm's .cmd shim for a package's script, as it writes it today. */
const shim = (script: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;

function files(map: Record<string, string>) {
  return { exists: (p: string) => p in map, read: (p: string) => map[p] ?? "" };
}

const env = { Path: "C:\\Windows\\system32;C:\\Users\\ann\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

test("on macOS and Linux the command is started as it is given", () => {
  assert.deepEqual(commandFor("claude", ["-p"], env, "darwin"), { bin: "claude", args: ["-p"] });
  assert.deepEqual(commandFor("claude", ["-p"], env, "linux"), { bin: "claude", args: ["-p"] });
});

test("on Windows a name is found on the PATH with the system's extensions, whatever the variable's case", () => {
  const fs = files({ "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd": "" });
  assert.equal(findOnWindows("codex", env, fs.exists), "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd");
  assert.equal(findOnWindows("codex", { PATH: env.Path }, fs.exists), "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd", "PATHEXT's default");
  assert.equal(findOnWindows("nope", env, fs.exists), undefined);
  assert.equal(findOnWindows("C:\\Users\\ann\\AppData\\Roaming\\npm\\codex", env, fs.exists), "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd", "a path with no extension");
});

test("an npm shim is started as the script it runs, with Node and no shell, so the arguments stay as they are", () => {
  const npm = "C:\\Users\\ann\\AppData\\Roaming\\npm";
  const script = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const fs = files({ [`${npm}\\claude.cmd`]: shim("node_modules\\@anthropic-ai\\claude-code\\cli.js"), [script]: "" });
  const prompt = 'say "hi" & echo %PATH% | more';
  assert.deepEqual(commandFor("claude", ["-p", prompt], env, "win32", fs, "C:\\node\\node.exe"), { bin: "C:\\node\\node.exe", args: [script, "-p", prompt] });
  // A Node of the shim's own beside it wins, as in the shim.
  const own = files({ [`${npm}\\claude.cmd`]: shim("node_modules\\@anthropic-ai\\claude-code\\cli.js"), [script]: "", [`${npm}\\node.exe`]: "" });
  assert.equal(commandFor("claude", [], env, "win32", own, "C:\\node\\node.exe").bin, `${npm}\\node.exe`);
});

test("a shim for a program of its own runs that program; a program found as .exe runs as it is", () => {
  const npm = "C:\\Users\\ann\\AppData\\Roaming\\npm";
  const exe = `${npm}\\node_modules\\opencode-ai\\bin\\opencode.exe`;
  const fs = files({ [`${npm}\\opencode.cmd`]: shim("node_modules\\opencode-ai\\bin\\opencode.exe"), [exe]: "" });
  assert.deepEqual(commandFor("opencode", ["run"], env, "win32", fs), { bin: exe, args: ["run"] });
  const native = files({ "C:\\Users\\ann\\.local\\bin\\claude.exe": "" });
  assert.deepEqual(commandFor("claude", ["-p"], { Path: "C:\\Users\\ann\\.local\\bin" }, "win32", native), { bin: "C:\\Users\\ann\\.local\\bin\\claude.exe", args: ["-p"] });
});

test("a name that is not there is left as it is, so starting it says it is not installed", () => {
  assert.deepEqual(commandFor("claude", ["-p"], env, "win32", files({})), { bin: "claude", args: ["-p"] });
});

test("another batch file runs through cmd.exe, each argument quoted and escaped for it", () => {
  const fs = files({ "C:\\tools\\agent.bat": "@echo off\r\nsomething.exe %*\r\n" });
  const c = commandFor("C:\\tools\\agent.bat", ["a b", 'x"y', "50%&"], { ComSpec: "C:\\Windows\\system32\\cmd.exe" }, "win32", fs);
  assert.equal(c.bin, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(c.verbatim, true);
  assert.deepEqual(c.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(c.args[3], '"C:\\tools\\agent.bat ^"a^ b^" ^"x\\^"y^" ^"50^%^&^""');
  assert.equal(cmdArgument("a\\", false), '^"a\\\\^"', "a trailing backslash is doubled so the quote stays a quote");
});

test("a shim's target is the last %dp0% path in it that is not Node", () => {
  assert.equal(shimTarget("C:\\npm\\x.cmd", shim("node_modules\\x\\bin\\x.js")), "C:\\npm\\node_modules\\x\\bin\\x.js");
  assert.equal(shimTarget("C:\\npm\\x.cmd", "@echo off\r\necho hello\r\n"), undefined);
});
