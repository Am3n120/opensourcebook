/** Running another program. Everything that starts one takes a runner like this, so tests pass their own. */
import { spawn } from "node:child_process";

/**
 * Runs a program and resolves with { code, stdout, stderr }; never rejects. With `capture` its words are collected,
 * otherwise it talks to the person's terminal directly.
 */
export function runProcess(command, args, options = {}) {
  return new Promise((done) => {
    const capture = !!options.capture;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true, shell: !!options.shell });
    } catch (error) {
      done({ code: 127, stdout, stderr: error.message });
      return;
    }
    // While the other program has the terminal, Ctrl-C is its to answer: this one waits for it to finish.
    const wait = () => {};
    const pass = () => child.kill("SIGTERM");
    if (!capture) {
      process.on("SIGINT", wait);
      process.on("SIGTERM", pass);
    }
    const finish = (result) => {
      if (!capture) {
        process.off("SIGINT", wait);
        process.off("SIGTERM", pass);
      }
      done(result);
    };
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
      child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    }
    child.once("error", (error) => finish({ code: 127, stdout, stderr: stderr + error.message }));
    child.once("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}
