/**
 * A stand-in for an agent's CLI in tests: a program that answers each command line as told, and records each. On macOS
 * and Linux a shell script; on Windows a Node script behind a `.cmd` file of the kind npm installs, so the tests start
 * it the way the connector starts a real agent there.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCli {
  bin: string;
  /** Each run's arguments, one line each, joined by spaces. */
  calls(): string[];
  /** What each run had on stdin. */
  stdins(): string[];
  /** The environment of the last run, as `KEY=value` lines. */
  env(): string[];
  remove(): void;
}

/** Claude Code's stream-json for a turn that answered `text`. */
export function claudeReply(text: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 4, output_tokens: 1 } }),
  ].join("\n").concat("\n");
}

/**
 * Claude Code's stream-json for a turn refused because the plan is out of usage: a refused rate limit, with its reset
 * as epoch seconds when given, and an error result saying `text`.
 */
export function claudeLimited(text: string, resetsAtSeconds?: number): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", ...(resetsAtSeconds !== undefined ? { resetsAt: resetsAtSeconds } : {}) } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, usage: { input_tokens: 0, output_tokens: 0 } }),
  ].join("\n").concat("\n");
}

/**
 * `answers` maps a start of the argument line (e.g. "--version", "login status") to what the CLI prints on stdout and
 * its exit code; the first that matches wins, and anything else exits 1 printing nothing.
 */
export function fakeCli(answers: Array<{ args: string; out?: string; code?: number }>): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-fake-cli-"));
  const bin = join(dir, "agent");
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const cases = answers
    .map((a, i) => {
      writeFileSync(join(dir, `out-${i}`), a.out ?? "");
      return `  ${quote(a.args)}*) cat ${quote(join(dir, `out-${i}`))}; exit ${a.code ?? 0} ;;`;
    })
    .join("\n");
  if (process.platform === "win32") {
    const script = join(dir, "agent.mjs");
    writeFileSync(script, nodeAgent(dir, answers.map((a, i) => ({ args: a.args, out: join(dir, `out-${i}`), code: a.code ?? 0 }))));
    writeFileSync(`${bin}.cmd`, cmdShim("agent.mjs"));
  } else {
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> ${quote(join(dir, "calls"))}\nenv > ${quote(join(dir, "env"))}\nif [ ! -t 0 ]; then cat >> ${quote(join(dir, "stdin"))}; echo "<<end>>" >> ${quote(join(dir, "stdin"))}; fi\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
    );
    chmodSync(bin, 0o755);
  }
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    bin: process.platform === "win32" ? `${bin}.cmd` : bin,
    calls: () => read("calls").split("\n").filter(Boolean),
    stdins: () => read("stdin").split("<<end>>\n").filter((s) => s !== ""),
    env: () => read("env").split("\n").filter(Boolean),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The shape of npm's own .cmd shim: `script`, the file beside it, run with node. */
function cmdShim(script: string): string {
  return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
}

/**
 * A stand-in program written in Node (CommonJS), named `name` in `dir`; the path to start it by. On macOS and Linux a
 * script with a #! line; on Windows, which cannot start such a script, the script beside a `.cmd` file of npm's kind.
 */
export function nodeProgram(dir: string, name: string, source: string): string {
  const bin = join(dir, name);
  if (process.platform === "win32") {
    writeFileSync(`${bin}.cjs`, source);
    writeFileSync(`${bin}.cmd`, cmdShim(`${name}.cjs`));
    return `${bin}.cmd`;
  }
  writeFileSync(bin, `#!${process.execPath}\n${source}`);
  chmodSync(bin, 0o755);
  return bin;
}

/** The Windows stand-in: what the shell script does, in Node. */
function nodeAgent(dir: string, answers: Array<{ args: string; out: string; code: number }>): string {
  return `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const answers = ${JSON.stringify(answers)};
const line = process.argv.slice(2).join(" ");
appendFileSync(dir + "/calls", line + "\\n");
writeFileSync(dir + "/env", Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");
if (!process.stdin.isTTY) appendFileSync(dir + "/stdin", readFileSync(0, "utf8") + "<<end>>\\n");
const answer = answers.find((a) => line.startsWith(a.args));
if (!answer) process.exit(1);
process.stdout.write(readFileSync(answer.out), () => process.exit(answer.code));
`;
}
