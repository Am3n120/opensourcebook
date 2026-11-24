/**
 * Open Sourcebook's skills for the person's own agent, in its own sessions: listed from `skills/`, and copied to where each coding
 * agent on this computer looks for skills. A skill is for that use when its front matter says
 * `metadata: { for: your-agent }`; the others are read by the agents working inside Open Sourcebook.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { COMMAND_FILE, commandIn } from "./run.ts";
import { Problem, flagList, flagOn, flagString, type Ctx, type Flag, type Group } from "./table.ts";

export interface SkillInfo {
  name: string;
  description: string;
  /** For the person's own agent, outside Open Sourcebook. */
  forYourAgent: boolean;
  dir: string;
}

/** A SKILL.md's name, description and whether its metadata says it is for the person's own agent. */
export function readSkillHead(text: string): { name: string; description: string; forYourAgent: boolean } | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
  if (!block) return undefined;
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) return undefined;
  return { name, description, forYourAgent: /^metadata:\s*\r?\n(?:\s+.*\r?\n)*?\s+for:\s*your-agent\s*$/m.test(`${block}\n`) };
}

export function listSkills(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ dir: join(dir, e.name), head: readSkillHead(readFileSync(join(dir, e.name, "SKILL.md"), "utf8")) }))
    .filter((s): s is { dir: string; head: NonNullable<ReturnType<typeof readSkillHead>> } => !!s.head)
    .map((s) => ({ ...s.head, dir: s.dir }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentHome {
  id: string;
  label: string;
  /** The program's name on the PATH. */
  bin: string;
  /** Where it reads personal skills. */
  personal(env: NodeJS.ProcessEnv, home: string): string;
  /** Where it reads a project's skills, from the project folder. */
  project: string;
  /** Other agents' folders it also reads, so a copy there serves it too. */
  alsoReads?: string[];
}

/**
 * Where each coding agent looks for skills, from their own documentation: Claude Code reads `~/.claude/skills` (its
 * config folder, `CLAUDE_CONFIG_DIR` when set) and `.claude/skills` in a project; Codex reads `~/.agents/skills` and
 * `.agents/skills`; OpenCode reads `~/.config/opencode/skills` and `.opencode/skills`, and the other two as well.
 */
export const AGENT_HOMES: AgentHome[] = [
  { id: "claude", label: "Claude Code", bin: "claude", personal: (env, home) => join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), project: join(".claude", "skills") },
  { id: "codex", label: "Codex", bin: "codex", personal: (_env, home) => join(home, ".agents", "skills"), project: join(".agents", "skills") },
  { id: "opencode", label: "OpenCode", bin: "opencode", personal: (env, home) => join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "skills"), project: join(".opencode", "skills"), alsoReads: ["claude", "codex"] },
];

export function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (env.PATH ?? "").split(delimiter).some((dir) => dir && exts.some((ext) => {
    try {
      return statSync(join(dir, bin + ext)).isFile();
    } catch {
      return false;
    }
  }));
}

/** The note written beside an installed skill: where Open Sourcebook and its command are on this computer. Also marks the copy as Open Sourcebook's. */
export const HERE = "here.md";
/** The mark as it is written now, and as it was before the rename: a copy with either one is ours. */
const ROOT_MARK = /<!-- opensourcebook-root: (.+?) -->/;
const OLD_ROOT_MARK = /<!-- re-root: (.+?) -->/;
/** What the skill for a person's own agent was called before the rename, and so its folder in each agent's skills. */
export const OLD_SKILL_NAME = "re";

export function hereNote(root: string): string {
  const cmd = join(root, "cli", COMMAND_FILE);
  return [
    "# Open Sourcebook on this computer",
    "",
    `Open Sourcebook is at \`${root}\`. The command is \`opensourcebook\` when it is on the PATH; when it is not, run \`node "${cmd}"\` wherever this skill says \`opensourcebook\` (or put \`opensourcebook\` on the PATH once with \`npm link\` in that folder).`,
    "",
    `If that folder is gone or has moved (\`${cmd}\` does not exist, or \`opensourcebook\` is not found), do not guess another place: tell the person "Open Sourcebook is no longer at ${root}; run \`opensourcebook skill install\` again from Open Sourcebook's new folder, or \`opensourcebook skill uninstall\` to remove this skill", and stop.`,
    "",
    "This folder was copied by `opensourcebook skill install`; running it again updates it, and `opensourcebook skill uninstall` removes it.",
    "",
    `<!-- opensourcebook-root: ${root} -->`,
    "",
  ].join("\n");
}

/** Whether a folder is an Open Sourcebook (the launcher is where its command lives), from before the rename or after. */
export const copyExistsAt = (root: string) => commandIn(root) !== undefined;

/** The Open Sourcebook an installed copy points at, from its here.md, whichever mark it carries. */
export function recordedRoot(copy: string): string | undefined {
  try {
    const note = readFileSync(join(copy, HERE), "utf8");
    return (ROOT_MARK.exec(note) ?? OLD_ROOT_MARK.exec(note))?.[1];
  } catch {
    return undefined;
  }
}

/** Whether an installed copy was written before the rename: its here.md carries the old mark and not the new one. */
export function fromBeforeRename(copy: string): boolean {
  try {
    const note = readFileSync(join(copy, HERE), "utf8");
    return OLD_ROOT_MARK.test(note) && !ROOT_MARK.test(note);
  } catch {
    return false;
  }
}

/** Asks a yes or no on the terminal. Replaced by tests, which have no terminal. */
export const prompter = {
  isTerminal: (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  async ask(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    rl.close();
    return /^\s*y(es)?\s*$/i.test(answer);
  },
};

interface Target {
  agent: string;
  label: string;
  folder: string;
}

const folderFlags: Flag[] = [
  { name: "agent", value: "id", help: "only this agent: claude, codex or opencode (default: those found on the PATH)", many: true },
  { name: "project", value: "folder", help: "this project folder's own skills folders instead of your personal ones" },
  { name: "dir", value: "folder", help: "one skills folder of your choosing (the skill goes in <folder>/<name>), for any agent or tool" },
  { name: "home", value: "folder", help: "use this folder as the home folder (to try it somewhere else first)" },
  { name: "yes", help: "do not ask first (needed when there is no terminal to ask on)" },
];

/** The skills folders a command is about: --dir, or each wanted agent's folder (personal, or the --project's). */
function targetsOf(ctx: Ctx, agents: AgentHome[]): Target[] {
  const dir = flagString(ctx, "dir");
  if (dir) return [{ agent: "dir", label: "the folder you named", folder: resolve(ctx.cwd, dir) }];
  const home = resolve(ctx.cwd, flagString(ctx, "home") ?? homedir());
  const projectDir = flagString(ctx, "project");
  const project = projectDir ? resolve(ctx.cwd, projectDir) : undefined;
  if (project && !existsSync(project)) throw new Problem("file_not_found", `There is no folder ${project}.`);
  const seen = new Set<string>();
  return agents
    .map((a) => ({ agent: a.id, label: a.label, folder: project ? join(project, a.project) : a.personal(ctx.env, home) }))
    .filter((t) => (seen.has(t.folder) ? false : (seen.add(t.folder), true)));
}

function askedAgents(ctx: Ctx): AgentHome[] {
  const asked = flagList(ctx, "agent");
  for (const id of asked) if (!AGENT_HOMES.some((a) => a.id === id)) throw new Problem("bad_arguments", `"${id}" is not an agent this knows; it knows ${AGENT_HOMES.map((a) => a.id).join(", ")}.`);
  return asked.length ? AGENT_HOMES.filter((a) => asked.includes(a.id)) : [];
}

/** Says what is about to happen, then asks to go on. Without a terminal to ask on it refuses rather than guess. */
async function confirm(ctx: Ctx, say: string[], action: string): Promise<void> {
  for (const line of say) ctx.progress(line);
  if (flagOn(ctx, "yes")) return;
  if (ctx.json || !prompter.isTerminal()) throw new Problem("needs_confirmation", `This would ${action}, as listed above, and there is no terminal to ask on. Run it again with --yes to go ahead.`);
  if (!(await prompter.ask("Go on?"))) throw new Problem("declined", "Nothing was changed.");
}

/** Every copy of an Open Sourcebook skill in these folders: a folder holding a here.md that records an Open Sourcebook. */
function copiesIn(targets: Target[]): Array<Target & { skill: string; path: string }> {
  const found: Array<Target & { skill: string; path: string }> = [];
  for (const t of targets) {
    if (!existsSync(t.folder)) continue;
    for (const e of readdirSync(t.folder, { withFileTypes: true })) {
      const path = join(t.folder, e.name);
      if (e.isDirectory() && recordedRoot(path)) found.push({ ...t, skill: e.name, path });
    }
  }
  return found;
}

export const skills: Group = {
  thing: "skill",
  aliases: ["skills"],
  about: "Open Sourcebook's skills: what your own agent reads to drive Open Sourcebook from its sessions",
  commands: [
    {
      thing: "skill",
      action: "list",
      summary: "Open Sourcebook's skills, and where copies of them are installed (and whether each still leads to an Open Sourcebook)",
      flags: folderFlags.filter((f) => f.name !== "yes"),
      shape: "{ skills: [{ name, description, forYourAgent: boolean }], installed: [{ agent, skill, path, root, rootExists: boolean }] }",
      more: "Looks in the same folders `opensourcebook skill install` writes to (every agent's, or the ones named with --agent, --project or --dir).",
      async run(ctx) {
        const list = listSkills(join(ctx.root, "skills")).map(({ dir: _dir, ...s }) => s);
        const named = askedAgents(ctx);
        const installed = copiesIn(targetsOf(ctx, named.length ? named : AGENT_HOMES)).map((c) => {
          const root = recordedRoot(c.path)!;
          return { agent: c.agent, skill: c.skill, path: c.path, root, rootExists: copyExistsAt(root) };
        });
        const text = [
          ...list.map((s) => `${s.name}${s.forYourAgent ? " (for your agent)" : " (read inside Open Sourcebook)"}: ${s.description}`),
          "",
          installed.length ? "Installed copies:" : "No copy is installed for your agent. `opensourcebook skill install` installs one.",
          ...installed.map((i) => `  ${i.path}\n    points at ${i.root}: ${i.rootExists ? "Open Sourcebook is there" : "no Open Sourcebook there any more; run `opensourcebook skill install` again from Open Sourcebook's folder, or `opensourcebook skill uninstall`"}`),
        ];
        return { data: { skills: list, installed }, text: text.join("\n") };
      },
    },
    {
      thing: "skill",
      action: "install",
      summary: "copy Open Sourcebook's skills for your agent to where each coding agent on this computer looks for skills (asks first)",
      flags: [...folderFlags, { name: "force", help: "replace a skill of the same name that Open Sourcebook did not install" }],
      shape: "{ installed: [{ agent, skill, path }], covered: [{ agent, by }], skipped: [{ agent, why }], replaced: [{ agent, skill, path }] }  (replaced: copies installed under the name from before the rename, removed)",
      more: "Says first which folders it will write to and asks to go on (--yes skips the question; without a terminal it needs --yes). Claude Code: ~/.claude/skills (or .claude/skills in a project). Codex: ~/.agents/skills (.agents/skills). OpenCode reads both of those as well as its own ~/.config/opencode/skills (.opencode/skills). --dir <folder> installs into one folder of your choosing instead. Each copy gets a here.md saying where this Open Sourcebook and its command are. Running it again updates the copies; `opensourcebook skill uninstall` removes them.",
      async run(ctx) {
        const toInstall = listSkills(join(ctx.root, "skills")).filter((s) => s.forYourAgent);
        if (!toInstall.length) throw new Problem("no_skills", "This copy of Open Sourcebook has no skill for your own agent to install.");
        const asked = askedAgents(ctx);
        const useDir = Boolean(flagString(ctx, "dir"));
        const chosen = asked.length ? asked : AGENT_HOMES.filter((a) => onPath(a.bin, ctx.env));
        if (!useDir && !chosen.length) throw new Problem("no_agents", `No coding agent this knows (${AGENT_HOMES.map((a) => a.label).join(", ")}) is on the PATH; name one with --agent, or a folder with --dir.`);
        const ids = new Set(chosen.map((a) => a.id));
        const covered: Array<{ agent: string; by: string }> = [];
        const writing: AgentHome[] = [];
        for (const agent of useDir ? [] : chosen) {
          const by = agent.alsoReads?.find((id) => ids.has(id));
          if (by) covered.push({ agent: agent.id, by });
          else writing.push(agent);
        }
        const targets = targetsOf(ctx, writing);
        const label = (id: string) => AGENT_HOMES.find((a) => a.id === id)?.label ?? "Your folder";
        // Copies installed before the rename sit in a folder of the old name and tell the agent to run the old
        // command. The ones install wrote itself (their here.md says so) are removed; anything else is left alone.
        const names = new Set(toInstall.map((s) => s.name));
        const old = copiesIn(targetsOf(ctx, useDir ? [] : chosen)).filter((c) => c.skill === OLD_SKILL_NAME && !names.has(c.skill) && fromBeforeRename(c.path));
        await confirm(
          ctx,
          [
            `This will copy ${toInstall.map((s) => s.name).join(", ")} (from ${join(ctx.root, "skills")}) into:`,
            ...targets.flatMap((t) => toInstall.map((s) => `  ${join(t.folder, s.name)}${t.agent === "dir" ? "" : `   (${t.label})`}`)),
            ...(old.length ? ["It will remove the copy installed under the old name, which the new one replaces:", ...old.map((c) => `  ${c.path}`)] : []),
            `Each copy also gets a ${HERE} that records this Open Sourcebook's folder (${ctx.root}), so the skill can find the \`opensourcebook\` command. Nothing else is written. \`opensourcebook skill uninstall\` removes exactly these.`,
          ],
          "write those folders",
        );
        const installed: Array<{ agent: string; skill: string; path: string }> = [];
        const skipped: Array<{ agent: string; why: string }> = [];
        for (const t of targets) {
          for (const skill of toInstall) {
            const dest = join(t.folder, skill.name);
            if (existsSync(dest) && !existsSync(join(dest, HERE)) && !flagOn(ctx, "force")) {
              skipped.push({ agent: t.agent, why: `${dest} holds a skill Open Sourcebook did not install; --force replaces it` });
              continue;
            }
            rmSync(dest, { recursive: true, force: true });
            mkdirSync(t.folder, { recursive: true });
            cpSync(skill.dir, dest, { recursive: true });
            writeFileSync(join(dest, HERE), hereNote(ctx.root));
            installed.push({ agent: t.agent, skill: skill.name, path: dest });
          }
        }
        const replaced: Array<{ agent: string; skill: string; path: string }> = [];
        // Only once the new copy is in place somewhere, so a person is never left with neither.
        if (installed.length || covered.length) {
          for (const c of old) {
            rmSync(c.path, { recursive: true, force: true });
            replaced.push({ agent: c.agent, skill: c.skill, path: c.path });
          }
        }
        const text = [
          ...installed.map((i) => `${label(i.agent)}: ${i.skill} copied to ${i.path}`),
          ...replaced.map((r) => `${label(r.agent)}: removed the copy under the old name, ${r.path}`),
          ...covered.map((c) => `${label(c.agent)}: reads ${label(c.by)}'s skills folder too, so it has them already`),
          ...skipped.map((s) => `${label(s.agent)}: skipped, ${s.why}`),
          installed.length ? "A new session of the agent sees the skill. `opensourcebook skill list` shows where it is; `opensourcebook skill uninstall` removes it." : "",
        ].filter(Boolean);
        return { data: { installed, covered, skipped, replaced }, text: text.join("\n"), exit: installed.length || covered.length ? 0 : 1 };
      },
    },
    {
      thing: "skill",
      action: "uninstall",
      summary: "remove the copies `opensourcebook skill install` made (and nothing else; asks first)",
      flags: folderFlags,
      shape: "{ removed: [{ agent, skill, path }] }",
      more: "Looks in the same folders install writes to and removes only folders holding the here.md that install wrote. Name the same --agent, --project, --dir or --home you installed with; without them it looks in every agent's personal folder.",
      async run(ctx) {
        const named = askedAgents(ctx);
        const found = copiesIn(targetsOf(ctx, named.length ? named : AGENT_HOMES));
        if (!found.length) return { data: { removed: [] }, text: "No copy of Open Sourcebook's skills made by `opensourcebook skill install` was found in those folders; nothing to remove.", exit: 0 };
        await confirm(ctx, ["This will remove:", ...found.map((c) => `  ${c.path}`), "Nothing else is touched."], "remove those folders");
        for (const c of found) rmSync(c.path, { recursive: true, force: true });
        const removed = found.map((c) => ({ agent: c.agent, skill: c.skill, path: c.path }));
        return { data: { removed }, text: removed.map((r) => `removed ${r.path}`).join("\n") };
      },
    },
  ],
};
