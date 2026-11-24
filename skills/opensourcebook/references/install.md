# Installing Open Sourcebook's skills for a coding agent

`opensourcebook skill install` copies every skill in Open Sourcebook's `skills/` folder that is for the person's own agent (this one) into the folder each coding agent reads skills from, for the agents it finds on the PATH, after saying exactly which folders it will write to and asking to go on (`--yes` skips the question; without a terminal it needs `--yes` and otherwise writes nothing). Run it again after updating Open Sourcebook to refresh the copies. Each copy gets a `here.md` saying where Open Sourcebook and its command are on this computer; that is the only thing added to the copy.

| Agent | Personal skills | A project's own skills | One line |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/` (in `CLAUDE_CONFIG_DIR` when that is set) | `.claude/skills/` | `opensourcebook skill install --agent claude` |
| Codex | `~/.agents/skills/` | `.agents/skills/` | `opensourcebook skill install --agent codex` |
| OpenCode | `~/.config/opencode/skills/`; it also reads the Claude Code and Codex folders | `.opencode/skills/` (and `.claude/skills/`, `.agents/skills/`) | `opensourcebook skill install --agent opencode` |

- `opensourcebook skill list` shows each installed copy, which copy of Open Sourcebook it points at, and whether that copy still exists. `opensourcebook skill uninstall` removes exactly the copies install wrote (the folders holding its `here.md`), after asking; give it the same `--agent`, `--project`, `--dir` or `--home` as the install.
- `opensourcebook skill install --dir <folder>` puts the copy in that one skills folder (`<folder>/opensourcebook`) and nowhere else, for a tool or a place this table does not list.
- `opensourcebook skill install --project <folder>` puts the copies in that project's own folders instead, so only sessions in that project see them.
- `opensourcebook skill install --home <folder>` treats another folder as the home folder, to try an install without touching the real one.
- An agent picks up a new skill in its next session.
- A skill of the same name that Open Sourcebook did not install is left alone unless `--force` is given.
- A copy installed before the name changed, in a folder called `re`, is found by install, list and uninstall as well. Install removes the old copy it wrote and writes the new one.

## Putting `opensourcebook` on the PATH

The one-line install makes `opensourcebook` a command by itself. In a copy cloned by hand, `npm link` once in Open Sourcebook's folder does the same. Without either, `node <Open Sourcebook's folder>/cli/opensourcebook.mjs` does the same anywhere, and the `here.md` beside an installed skill gives that path. Nothing is published anywhere; the command always runs the copy of Open Sourcebook on this computer.
