/** How the launcher talks: plain lines, one per step or program, updated in place on a terminal. */

const tty = Boolean(process.stdout.isTTY) && !process.env.CI;
export const interactive = tty;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

export const say = (line = "") => process.stdout.write(`${line}\n`);
export const quiet = (line: string) => say(dim(line));

/** A line that can be rewritten while a step runs (on a terminal), and is printed once when it ends. */
export function progress(label: string): { update(text: string): void; line(text: string): void; done(text: string): void } {
  let last = "";
  const started = Date.now();
  const write = (text: string) => {
    if (!tty) return;
    process.stdout.write(`\r\x1b[2K  ${label}: ${text}`);
  };
  write("...");
  const timer = tty
    ? setInterval(() => write(`${last || "..."} ${dim(`${Math.round((Date.now() - started) / 1000)}s`)}`), 1000)
    : undefined;
  timer?.unref();
  if (!tty) say(`  ${label}...`);
  return {
    /** A line that stays on screen, printed above the live one. */
    line(text) {
      if (tty) process.stdout.write(`\r\x1b[2K`);
      say(text);
      write(last || "...");
    },
    update(text) {
      last = text;
      write(text);
    },
    done(text) {
      if (timer) clearInterval(timer);
      if (tty) process.stdout.write(`\r\x1b[2K`);
      say(`  ${label}: ${text}`);
    },
  };
}
