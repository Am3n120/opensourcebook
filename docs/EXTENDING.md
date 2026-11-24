# Extending Open Sourcebook

Each of these is one file or one folder in its own home. Nothing else in the code names it: the rest of Open Sourcebook reads the list. The exact homes are in [`STRUCTURE.md`](STRUCTURE.md), and how to send the change is in [`CONTRIBUTING.md`](../CONTRIBUTING.md). The steps below are for a style, a piece, an agent, a kind of card, a kind of quiz question, a voice, a worked scene, a skill and a pack.

## Add a style

A style is the look of a video: colours, fonts, motion, and what it suits.

1. Copy `services/scenes/styles/flat.json` to `services/scenes/styles/<name>.json` and change it. Set `name`, a short `label` and a plain `description` (it says what the style suits; the agent and the app show it), then `palette`, `fonts`, `render` and the rest.
2. Fonts: each family a style names must have a folder in `services/scenes/fonts/` with the font files, their licence and a `font.json`. Only the SIL Open Font License or Apache 2.0. Steps are in `services/scenes/fonts/README.md`.
3. Run `cd services/scenes && npm test`. It checks that every style's fonts resolve.

The style is listed, described to the agent and offered in the app by being there.

## Add a piece

A piece is a ready-made thing the agent can put on screen, such as a number line or a timeline.

1. Make `services/scenes/pieces/<name>/` with `piece.js` (the program, in the scene language), `piece.json` (a line on when to use it, tags a search can meet, and each setting with its default and meaning) and `example.md` (a narration and a scene that uses it). Copy a small existing folder, such as `pieces/pie/`.
2. Try it: `cd services/scenes && npm run piece -- <name> --styles flat,ink,neon`. It builds the scene in those styles, prints what a viewer would notice and writes stills to look at. `--picture` writes the piece's `still.jpg`.
3. Run `npm test`. A piece that computes its steps (sorting, graphs, matrices) is a kit instead: one file in `services/scenes/engine/kits/` and one entry in `kits/index.ts`.

Keep a piece general. It must not be tied to one topic.

## Add an agent

An agent is a coding agent Open Sourcebook can run as the person's own.

1. Write `services/agent-connector/src/agents/<name>.ts` exporting an adapter that implements `AgentAdapter` (`src/agents/types.ts`): how to find the program, whether it is installed and signed in, how to start one turn boxed in, and how to read what it says. Read `claude.ts` first, then `codex.ts` and `opencode.ts` for what differs. An adapter never reads, stores or passes on the program's login.
2. Register it with one line in `services/agent-connector/src/agents/registry.ts` (`createDefaultAgents`).
3. Add tests beside the existing ones in `services/agent-connector/test/`, then `npm run typecheck && npm test` there. Say in the pull request which parts you ran for real (a chat turn, a work folder, a video) and which you did not.

## Add a kind of card

A kind of card is the one job a card does: fill the gap, compare, steps, a formula and so on.

1. Add one entry to `engine/src/cards/kinds.ts` with its id, its label, what it is for and what its sides hold. The player draws a card from its sides, so there is nothing to add per kind in `web/`.
2. Run `cd engine && npm run typecheck && npm test`.

## Add a kind of quiz question

1. Add one entry to `engine/src/engines/quiz/kinds.ts`, and one piece in `web/src/player/` that draws it.
2. Run `npm run typecheck && npm test` in `engine/` and `web/`.

## Add a voice

A voice speaks a video or an audio. It must give a time for every word.

1. Add a file beside `services/scenes/src/voice.ts` that implements its `Voice` interface and exports its own `VoiceService` (its label, whether it is hosted or on this computer, the key it needs or how to install it, and how to build it), and add one line to the list in `src/voices.ts`. The choice, the app's Voice settings and the launcher's check read that list.
2. Run `cd services/scenes && npm run typecheck && npm test`, and say in the pull request whether you tried it for real (a key may be needed).

## Add a worked scene to the video skill's cookbook

1. Add `services/scenes/skills/make-a-video/references/examples/<name>.md`, the same shape as `halving.md`: a title line, a sentence on what it shows, a narration, and a `scene` block timed to that narration's own words (`@N` is the N-th word). Pick a topic unrelated to any real video; the example shows a mechanism, never a script to copy.
2. Run `cd services/scenes && npm test`. The cookbook test builds every example as written.

## Add a skill

A skill is knowledge the agent reads when it needs it. It is never a rule.

- For making videos: a folder in `services/scenes/skills/<name>/` with a `SKILL.md` and its `references/`. The first lines of `SKILL.md` give its name and one line on when it helps; the agent finds it by that line. A test lists the skill names, so update it in the same commit.
- For planning, flashcards, quizzes and audio: a folder in `skills/<name>/` the same way, and one line per file in `engine/src/chat/agent/work-skills.ts` (the engine bundles the files as text).
- For your own agent driving Open Sourcebook with the command: `skills/opensourcebook/`.

## Add a pack

A pack is a bundle for one kind of work.

1. Make `packs/<name>/` with a `SKILL.md` (a `name` and a one-line `description` in its front matter) and a `pack.json` with `example`: the name of a finished example in `examples/`, or `null`.
2. Add one line per file to `engine/src/chat/agent/pack-files.ts` (the engine bundles them; the launcher's tests fail when a file is missing from it). Read `packs/README.md`, and copy `packs/study/`.
3. `opensourcebook pack list` should show it, and `opensourcebook pack on <name>` turn it on for a project.

Write what a person who knows the craft would tell a colleague. Do not write "you must".
