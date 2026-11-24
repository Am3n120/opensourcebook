# Plan

Where Open Sourcebook is now, what comes next and how you can help. No dates are promised: Open Sourcebook is made by one person, and things land when they are good. [`VISION.md`](VISION.md) says what it is for, [`DECISIONS.md`](DECISIONS.md) records what has been settled, and [`STRUCTURE.md`](STRUCTURE.md) says where each kind of thing lives.

## Where Open Sourcebook is now

- In a clone, one command, `npm start`, runs four programs on your own computer (the engine, the web app, the agent connector and the scenes service) and opens the web app. An install by one pasted line, with no clone and no terminal after it, is built and tried on a Mac; [`install/README.md`](../install/README.md) says what of it has been tried and what has not.
- It makes five things from a person's own sources, by their own agent: a video to watch, flashcards to swipe, a quiz to check, audio to listen to and a guide to keep. Asking for one opens its make sheet, filled in, and nothing is made until its button is pressed. A plan is for a path through the material and is shown first. One list holds everything made or being made.
- A question in the chat is answered from the sources, with a cite at every claim, checked word for word. The chat can also draw the main ideas as a mind map and check an idea the person explains back.
- Everything made can be talked back to in place (a thread on a video's moment, a card, a quiz answer), and a plain follow-up ("make it shorter") makes it again. One scene of a video can be made again from a note.
- Six agents can be run as yours: Claude Code, Codex, OpenCode, Antigravity, Cursor and GitHub Copilot. All six are supported. Claude Code and Codex are used most: Codex has given a chat answer with checked cites and made a full video. The others have been run less ([`LIMITS.md`](LIMITS.md)). A model API key is the second way to make flashcards and quizzes and to answer the chat.
- Settings has one table of who makes and who reviews each shape, with which model and effort, and the voice. A video can be reviewed before it is finished.
- The `opensourcebook` command does all of it from a terminal or from an agent's own session, with a skill to install.
- A phone on the same Wi-Fi opens the web app by QR code, with a feed of what was made. It is covered by tests and not yet tried on a real phone.
- A job carries on after a restart, a sleep or the agent's plan reaching its limit.
- Videos are good, not great, and take minutes. Without a voice a video has no sound and audio is not available. A voice is an ElevenLabs or Speechify key, or Kokoro, which runs on the computer.
- A Mac is the supported system. Linux is partly tried, and Windows is not tested by hand yet (help wanted).
- An iPhone app is in the repo, built with Xcode, and has not caught up with flashcards, audio and guides ([`IPHONE.md`](IPHONE.md)).

[`LIMITS.md`](LIMITS.md) says what works with which agent and system.

## What comes next

Work is tracked as issues, and the labels say what kind. This page does not repeat the list, because it would go stale; [`CONTRIBUTING.md`](../CONTRIBUTING.md) lists the labels and says where a new contributor can start.

The directions, in a line each: a better video, more pieces and styles for videos, more kinds of card and quiz question, the agents beyond Claude Code proven for making things, Windows and Linux, a real phone, and more packs and finished examples (study is the first pack). How to add each one is in [`EXTENDING.md`](EXTENDING.md).

## What this is not planning

Open Sourcebook does not plan a hosted service that holds your files or your login. Anything that would need that is a different product.

## Where things live

- Vision: [`VISION.md`](VISION.md). Decisions: [`DECISIONS.md`](DECISIONS.md). Words: [`GLOSSARY.md`](GLOSSARY.md). Structure: [`STRUCTURE.md`](STRUCTURE.md).
- The history of the project: [`STORY.md`](STORY.md).
- Versions and their notes: [`RELEASES.md`](RELEASES.md). What changed, a line at a time: [`CHANGES.md`](../CHANGES.md).
