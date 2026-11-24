# Packs

A pack is a folder for one kind of work. It holds:

- `SKILL.md`, the pack's skill: knowledge about that kind of work for the agents planning and making inside Open Sourcebook, with a `name` and a one-line `description` in its front matter and `references/` beside it when it needs more. Knowledge, never rules, and nothing tied to one topic.
- `pieces/`, any pieces of its own, when it has them.
- `pack.json`, with `example`: the name of the folder in `examples/` that holds its finished example, or `null` until one is kept.

Packs are read from this folder: `opensourcebook pack list` shows them, and a new folder with a `SKILL.md` is a new pack. `opensourcebook pack on <name>` turns one on for a project (it is kept in the project's `settings.packs`), and then the planner in that project's chats is given the pack's skill with its own guide on every turn, and the agent making the project's bytes and quizzes is told the pack is on and reads its skill with `read_skill`. The engine runs where it cannot list a folder, so it bundles the pack files from one list, `engine/src/chat/agent/pack-files.ts`; the launcher's tests fail when a file here is missing from it.
