/** Reading and writing the small `KEY=value` files the programs use (.env, .dev.vars). */
import { existsSync, readFileSync } from "node:fs";

/** The settings in an env file, or nothing when it is not there. Comments and blank lines are skipped. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8"));
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]!] = value;
  }
  return out;
}

/** Names an example env file declares, commented out or not (`# NAME=` counts), in order. */
export function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(raw.trim());
    if (match && !names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/** An env file for these settings. Values that need it are single-quoted (no expansion), else double-quoted. */
export function formatEnv(values: Record<string, string>, header = ""): string {
  const lines = header ? header.split("\n").map((l) => `# ${l}`) : [];
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${quoteEnv(value)}`);
  return `${lines.join("\n")}\n`;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_.:/@+,=-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
  return `"${value.replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
}
