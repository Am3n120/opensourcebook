/** The small files that make this a command and a shortcut: the shims in the home's `bin/`, and the copy of this package they run. */
import { chmodSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "./paths.mjs";

/** A string as one word for sh, whatever is in it. */
export const shWord = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The `opensourcebook` command for Mac and Linux: the home's own Node when there is one, else the one on the PATH. */
export function shimText(home) {
  return `#!/bin/sh
# Open Sourcebook: runs the launcher kept in this folder, with this folder's own Node when it has one.
OPENSOURCEBOOK_HOME=${shWord(home)}
export OPENSOURCEBOOK_HOME
if [ -x "$OPENSOURCEBOOK_HOME/node/bin/node" ]; then
  exec "$OPENSOURCEBOOK_HOME/node/bin/node" "$OPENSOURCEBOOK_HOME/launcher/bin/opensourcebook.mjs" "$@"
fi
exec node "$OPENSOURCEBOOK_HOME/launcher/bin/opensourcebook.mjs" "$@"
`;
}

/** The same for Windows. */
export function cmdShimText(home) {
  return ["@echo off", "setlocal", `set "OPENSOURCEBOOK_HOME=${home}"`, 'if exist "%OPENSOURCEBOOK_HOME%\\node\\node.exe" (', '  "%OPENSOURCEBOOK_HOME%\\node\\node.exe" "%OPENSOURCEBOOK_HOME%\\launcher\\bin\\opensourcebook.mjs" %*', ") else (", '  node "%OPENSOURCEBOOK_HOME%\\launcher\\bin\\opensourcebook.mjs" %*', ")", "exit /b %ERRORLEVEL%", ""].join("\r\n");
}

export function writeShims(home, platform = process.platform) {
  const bin = layout(home).bin;
  mkdirSync(bin, { recursive: true });
  const written = [];
  if (platform === "win32") {
    writeFileSync(join(bin, "opensourcebook.cmd"), cmdShimText(home));
    written.push(join(bin, "opensourcebook.cmd"));
  }
  const shim = join(bin, "opensourcebook");
  writeFileSync(shim, shimText(home));
  chmodSync(shim, 0o755);
  written.push(shim);
  return written;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Copies this package into the home's `launcher/`, so the command works without npx. Nothing to do when it already runs from there. */
export function copyLauncher(home, packageDir) {
  const to = layout(home).launcher;
  if (real(packageDir) === real(to)) return false;
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of ["package.json", "source.json", "README.md", "bin", "lib"]) {
    if (existsSync(join(packageDir, name))) cpSync(join(packageDir, name), join(to, name), { recursive: true });
  }
  chmodSync(join(to, "bin", "opensourcebook.mjs"), 0o755);
  return true;
}
