/**
 * How to start an agent's CLI on Windows. There, npm installs a program as a `.cmd` file (a shim) beside a Node script,
 * and Node cannot start a `.cmd` file without a shell, nor find `claude` on the PATH when the file is `claude.cmd`.
 * So the command is looked up on the PATH with the system's own extensions (PATHEXT), and an npm shim is read for the
 * script it runs, which is then started with Node directly: no shell, so a prompt's quotes, `&` or `%` stay text. A
 * `.cmd` file that is not an npm shim runs through `cmd.exe` with every argument escaped for it. On macOS and Linux
 * the command is started as it is given.
 */
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

export interface Command {
  bin: string;
  args: string[];
  /** Arguments already quoted for `cmd.exe`, passed on as they are. */
  verbatim?: boolean;
}

/** A variable of `env` by name, ignoring case as Windows does (`Path`, `PATH`), since a copied environment keeps one spelling. */
function envOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Where Windows would find `bin`: the file itself, or with one of PATHEXT's extensions, in each PATH folder when it has no folder. */
export function findOnWindows(bin: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = isFile): string | undefined {
  const exts = (envOf(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  const named = exts.includes(win32.extname(bin).toLowerCase());
  const tries = (base: string) => [...(named ? [base] : []), ...exts.map((e) => base + e)];
  const hasFolder = /[\\/]/.test(bin) || win32.isAbsolute(bin);
  const dirs = hasFolder ? [""] : (envOf(env, "PATH") ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of tries(dir ? win32.join(dir, bin) : bin)) if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The program an npm shim (`.cmd`) runs: the last `"%dp0%\…"` path in it, a Node script or a program of its own.
 * Undefined when the file is not such a shim.
 */
export function shimTarget(shim: string, text: string): string | undefined {
  const found = [...text.matchAll(/"%(?:~)?dp0%\\?([^"%]+)"/gi)].map((m) => m[1]!).filter((p) => !/^node(\.exe)?$/i.test(p));
  const last = found.at(-1);
  return last ? win32.join(win32.dirname(shim), last) : undefined;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument quoted for `cmd.exe /s /c` (the rules the C runtime reads it back with, then cmd's own `^` escapes). */
export function cmdArgument(arg: string, doubleEscape: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(META, "^$1");
  return doubleEscape ? quoted.replace(META, "^$1") : quoted;
}

/**
 * How to start `bin` with `args`. `platform` and `exists`/`read` are for tests; `node` is the Node a shim's script
 * runs with when the shim's folder has none of its own.
 */
export function commandFor(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fs: { exists: (path: string) => boolean; read: (path: string) => string } = { exists: isFile, read: (p) => readFileSync(p, "utf8") },
  node: string = process.execPath,
): Command {
  if (platform !== "win32") return { bin, args };
  const file = findOnWindows(bin, env, fs.exists);
  if (!file) return { bin, args };
  const ext = win32.extname(file).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { bin: file, args };
  let text = "";
  try {
    text = fs.read(file);
  } catch {
    // Read below as not a shim.
  }
  const target = shimTarget(file, text);
  if (target && fs.exists(target)) {
    if (/^\.(exe|com)$/i.test(win32.extname(target))) return { bin: target, args };
    const own = win32.join(win32.dirname(file), "node.exe");
    return { bin: fs.exists(own) ? own : node, args: [target, ...args] };
  }
  // Some other batch file: through cmd.exe, each argument escaped for it (twice for one in node_modules\.bin, which
  // runs another batch file in turn).
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [file.replace(META, "^$1"), ...args.map((a) => cmdArgument(a, twice))].join(" ");
  return { bin: envOf(env, "COMSPEC") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
