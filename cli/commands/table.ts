/**
 * The `opensourcebook` command table: every command is one entry (a thing, an action, its arguments and flags, one line of help,
 * the shape of its `--json` answer, and its handler). `opensourcebook help`, `opensourcebook <thing> help` and `opensourcebook <thing> <action> help` are
 * made from these entries, so nothing about a command is written twice. Adding a command is adding an entry to a
 * group's file in this folder.
 */

export interface Arg {
  name: string;
  help: string;
  optional?: boolean;
  /** Takes the rest of the words (a question, a request, a title with spaces), joined by spaces. */
  rest?: boolean;
  /** Takes the rest of the words as a list (files, links), in `ctx.lists`. */
  many?: boolean;
}

export interface Flag {
  name: string;
  help: string;
  /** What the value is called in help; a flag without one is a switch. */
  value?: string;
  /** A flag given more than once keeps every value. */
  many?: boolean;
}

export interface Answer {
  /** The `--json` answer, without `ok` (added on the way out). */
  data: Record<string, unknown>;
  /** The answer a person reads. */
  text: string;
  /** Exit code; 0 when left out. */
  exit?: number;
}

export interface Ctx {
  args: Record<string, string | undefined>;
  lists: Record<string, string[]>;
  flags: Record<string, string | string[] | boolean | undefined>;
  json: boolean;
  /** A line of progress, on stderr, so stdout keeps only the answer. */
  progress(line: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The repo root of this clone of Open Sourcebook. */
  root: string;
  /** The state folder (`.opensourcebook/`, cli/state.ts), where a running Open Sourcebook says where it is. */
  home: string;
  /**
   * For a start only: gives a state folder from before the rename its new name and returns where the state is now,
   * telling `say` what it did when there is something to tell. Absent when the folder was handed in as it is (a
   * test), and then `home` is used.
   */
  settle?: (say: (line: string) => void) => string;
  /** For tests: how long waits sleep between looks. */
  pollMs: number;
}

export interface Command {
  /** The noun: `project`, `source`, `plan`, ... Empty for the commands that run Open Sourcebook itself (`opensourcebook start`). */
  thing: string;
  action: string;
  summary: string;
  args?: Arg[];
  flags?: Flag[];
  /** The `--json` answer on success, in one line (TypeScript-like). Every command has one. */
  shape: string;
  /** Extra lines for `opensourcebook <thing> <action> help`. */
  more?: string;
  run(ctx: Ctx): Promise<Answer>;
}

/** A group of commands about one thing, with a line on what the thing is. */
export interface Group {
  thing: string;
  about: string;
  /** Other words a person may type for the thing (plurals). */
  aliases?: string[];
  /** The action `opensourcebook <thing>` alone runs; without one, it shows the group's help. */
  default?: string;
  commands: Command[];
}

/** A problem said in one plain sentence, with a stable code for `--json`. */
export class Problem extends Error {
  code: string;
  exit: number;
  constructor(code: string, message: string, exit = 1) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

/** Flags every command takes. */
export const GLOBAL_FLAGS: Flag[] = [
  { name: "json", help: "answer as JSON on stdout (and nothing else there)" },
  { name: "help", help: "show help for this command" },
];

export const PROJECT_FLAG: Flag = { name: "project", value: "id", help: "the project (default: the one used last)" };
export const PRINT_FLAG: Flag = { name: "print", help: "only print the address; do not open a browser (the browser opens on the computer Open Sourcebook runs on)" };
export const WAIT_FLAG: Flag = { name: "wait", help: "follow it until it is done, with the live step on stderr" };
export const TIMEOUT_FLAG: Flag = { name: "timeout", value: "minutes", help: "how long --wait follows before it gives up (default 30)" };

export interface Parsed {
  args: Record<string, string | undefined>;
  lists: Record<string, string[]>;
  flags: Record<string, string | string[] | boolean | undefined>;
}

/** Reads the words after `opensourcebook <thing> <action>` against the command's arguments and flags. */
export function parse(command: Command, words: string[]): Parsed {
  const flags: Parsed["flags"] = {};
  const known = [...(command.flags ?? []), ...GLOBAL_FLAGS];
  const positional: string[] = [];
  const how = usageHint(command);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const [name, inline] = word.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const flag = known.find((f) => f.name === name);
      if (!flag) throw new Problem("bad_arguments", `"--${name}" is not a flag of ${how}. Run "${how} help" to see what it takes.`);
      if (!flag.value) {
        if (inline !== undefined) throw new Problem("bad_arguments", `"--${name}" is a switch and takes no value.`);
        flags[name] = true;
        continue;
      }
      const value = inline ?? words[++i];
      if (value === undefined) throw new Problem("bad_arguments", `"--${name}" needs a value (${flag.value}).`);
      if (flag.many) flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
      else flags[name] = value;
      continue;
    }
    if (word === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(word);
  }
  const args: Parsed["args"] = {};
  const lists: Parsed["lists"] = {};
  const specs = command.args ?? [];
  if (flags.help) return { args, lists, flags };
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (spec.many) {
      const all = positional.splice(0).filter((w) => w.trim());
      if (all.length) {
        lists[spec.name] = all;
        args[spec.name] = all.join(" ");
      }
    } else if (spec.rest) {
      const rest = positional.splice(0).join(" ").trim();
      if (rest) args[spec.name] = rest;
    } else {
      const value = positional.shift();
      if (value !== undefined) args[spec.name] = value;
    }
    if (args[spec.name] === undefined && !spec.optional) {
      throw new Problem("bad_arguments", `${how} needs <${spec.name}> (${spec.help}). Run "${how} help" for more.`);
    }
  }
  if (positional.length) throw new Problem("bad_arguments", `${how} does not take "${positional.join(" ")}". Run "${how} help" to see what it takes.`);
  return { args, lists, flags };
}

export function usageHint(command: Command): string {
  return ["opensourcebook", command.thing, command.action].filter(Boolean).join(" ");
}

export function usage(command: Command): string {
  const dots = (a: Arg) => (a.rest || a.many ? "..." : "");
  const args = (command.args ?? []).map((a) => (a.optional ? `[${a.name}${dots(a)}]` : `<${a.name}${dots(a)}>`));
  return [usageHint(command), ...args].join(" ");
}

const pad = (s: string, n: number) => (s.length >= n ? `${s}  ` : s + " ".repeat(n - s.length));

/** `opensourcebook help`: every command, a line each, grouped by thing. */
export function helpAll(groups: Group[]): string {
  const width = Math.min(56, Math.max(...groups.flatMap((g) => g.commands.map((c) => usage(c).length))) + 2);
  const out = [
    "opensourcebook: Open Sourcebook on this computer, from any folder. Everything the app does is a command here.",
    "",
  ];
  for (const g of groups) {
    out.push(g.thing ? `${g.thing}: ${g.about}` : g.about);
    for (const c of g.commands) out.push(`  ${pad(usage(c), width)}${c.summary}`);
    out.push("");
  }
  out.push("Every command takes --json (a stable answer on stdout) and help (\"opensourcebook plan start help\").");
  out.push("Most take --project <id>; without it the project used last is used.");
  return out.join("\n");
}

/** `opensourcebook <thing> help`. */
export function helpGroup(group: Group): string {
  const width = Math.max(...group.commands.map((c) => usage(c).length)) + 2;
  return [`${group.thing}: ${group.about}`, "", ...group.commands.map((c) => `  ${pad(usage(c), width)}${c.summary}`), "", `"opensourcebook ${group.thing} <action> help" says more about one.`].join("\n");
}

/**
 * The --json answer of a command, from its shape: `ok: true` goes inside the object, and a note
 * written after the object ("{ ... }  (Item: { ... })") stays after its closing brace.
 */
export function jsonAnswer(shape: string): string {
  const text = shape.trim();
  if (!text.startsWith("{")) return `{ ok: true, ${text} }`;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return `{ ok: true, ${text.slice(1).trim()} }`;
  return `{ ok: true, ${text.slice(1, end).trim()} }${text.slice(end + 1)}`;
}

/** `opensourcebook <thing> <action> help`. */
export function helpCommand(command: Command): string {
  const out = [usage(command), "", command.summary];
  if (command.more) out.push("", command.more);
  const args = command.args ?? [];
  if (args.length) {
    out.push("", "Arguments:");
    const w = Math.max(...args.map((a) => a.name.length)) + 4;
    for (const a of args) out.push(`  ${pad(a.name, w)}${a.help}${a.optional ? " (optional)" : ""}`);
  }
  const flags = [...(command.flags ?? []), ...GLOBAL_FLAGS];
  out.push("", "Flags:");
  const names = flags.map((f) => `--${f.name}${f.value ? ` <${f.value}>` : ""}`);
  const w = Math.max(...names.map((n) => n.length)) + 2;
  flags.forEach((f, i) => out.push(`  ${pad(names[i]!, w)}${f.help}${f.many ? " (may be given more than once)" : ""}`));
  out.push("", `--json answer: ${jsonAnswer(command.shape)}`);
  out.push(`On a problem:  { ok: false, error: { code, message } } and exit code 1.`);
  return out.join("\n");
}

/** The table as data, for `opensourcebook help --json`. */
export function describeAll(groups: Group[]): Record<string, unknown> {
  return {
    commands: groups.flatMap((g) =>
      g.commands.map((c) => ({
        command: usageHint(c),
        usage: usage(c),
        summary: c.summary,
        args: (c.args ?? []).map((a) => ({ name: a.name, help: a.help, optional: !!a.optional, rest: !!a.rest })),
        flags: [...(c.flags ?? []), ...GLOBAL_FLAGS].map((f) => ({ name: f.name, help: f.help, takesValue: !!f.value, many: !!f.many })),
        json: c.shape,
      })),
    ),
  };
}

export const flagString = (ctx: Ctx, name: string): string | undefined => {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v.at(-1) : undefined;
};
export const flagList = (ctx: Ctx, name: string): string[] => {
  const v = ctx.flags[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
};
export const flagOn = (ctx: Ctx, name: string): boolean => ctx.flags[name] === true;
