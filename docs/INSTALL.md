# Installing Open Sourcebook

The short version is in the [README](../README.md). This page has the rest.

## The one line

On a Mac or Linux:

```bash
curl -fsSL https://opensourcebook.app/install | sh
```

On Windows:

```powershell
irm https://opensourcebook.app/install.ps1 | iex
```

Paste the line into Terminal on a Mac (press Command and Space, type Terminal, press Return), into PowerShell on Windows (press the Windows key, type PowerShell, press Enter) or into a terminal on Linux, and press Return. That is the only time you need a terminal.

The line uses the Node 24 you have, or keeps a private copy of its own. It downloads Open Sourcebook into one folder, `.opensourcebook` in your home folder, and gets ffmpeg for videos if you do not have it. It never asks for your password or administrator rights, and deleting that folder removes Open Sourcebook. The first time takes a few minutes, and then your browser opens on Open Sourcebook.

Opening it again: the Open Sourcebook shortcut the install made, or the command `opensourcebook`. Getting the newest version: `opensourcebook update`.

## What you need of your own

One agent, installed and signed in the normal way: Claude Code with a Claude plan, Codex with a ChatGPT plan, Antigravity with a Google (Gemini) plan, Cursor, GitHub Copilot or OpenCode. Open Sourcebook checks at start and says in plain words what is missing and what to do about it. A voice for videos and audio is separate: it needs a key for a voice service, or the free voice that runs on your computer ([A voice](VOICE.md)).

## Where it has been tried

Open Sourcebook is made and used on a Mac. The Linux and Windows lines are written and are not proven yet ([What works where](LIMITS.md#what-works-where)). What the one-line install has and has not been tried on, in full: [`install/README.md`](../install/README.md).

## Other ways

With Node 24 already on your computer, `npx opensourcebook` does the same as the line above. To change Open Sourcebook itself, clone it ([Working from a clone](DEVELOPING.md)).

## An API key instead of a plan

No API key is needed when your agent is signed in on a plan. A key works too, in three ways:

- **A model API key in the engine.** Put a Gemini, DeepSeek or OpenRouter key in `engine/.dev.vars` in the app's folder (copy `engine/.dev.vars.example`; the launcher passes it on). Open Sourcebook then makes flashcards and quizzes and answers the chat with that key. Videos are made by an agent.
- **A provider connected in OpenCode.** OpenCode runs on the providers you connect in it (`opencode auth login`) with a key of your own, and Open Sourcebook lists the models it offers. As an agent it answers the chat and makes everything, videos included. This path has been run less than Claude Code and Codex ([`LIMITS.md`](LIMITS.md#supported-agents)).
- **An Anthropic or OpenAI key for Claude Code or Codex.** Put `OPENSOURCEBOOK_ANTHROPIC_API_KEY` or `OPENSOURCEBOOK_OPENAI_API_KEY` in `services/agent-connector/.env` in the app's folder. When the agent is not signed in, its turns run on the key, billed to you as API use.

## Where the app's folder is

The app's folder is `~/.opensourcebook/app` after the one-line install, and the folder you cloned into for a clone.
