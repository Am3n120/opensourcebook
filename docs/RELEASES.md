# Releases

Each version of Open Sourcebook, newest first, with the notes its release page carries. `CHANGES.md` is the other list: the one `opensourcebook update` prints, one line at a time, to a person whose copy is behind. This page is for people deciding whether to try Open Sourcebook, and for anyone linking to a version.

A version is the `version` in the root `package.json`. Tag it as `v` and that number (`v0.1.0`) on the commit the notes describe. Until 1.0, a new middle number (0.2.0) is a version with new things to make or do, and a new last number (0.1.1) is fixes only.

## Unreleased

No version is tagged yet. What lands before the first tag goes into the 0.1.0 notes below; after it, what is on main since the last tag goes here, one line each, and moves into the next version's notes when it is tagged.

## 0.1.0 (not tagged yet)

The notes for the first version of Open Sourcebook, kept ready for its tag. It is early and made by one person.

Open Sourcebook turns your notes, slides and PDFs into a video to watch, flashcards to swipe, a quiz to check, audio to listen to and a guide to keep, all made from your own sources by the coding agent you already have. Ask it a question and every claim in the answer shows the exact words it came from. It runs on your own computer, with no server of ours and no new account.

**What it makes**

- **Cited answers.** Each claim in a chat reply carries a cite, checked word for word against your source, and a cite opens the passage it came from.
- **Videos.** Short explainers drawn scene by scene in a style you pick, from a shelf of 50 pieces (timelines, number lines, graphs, flows, loops, maps and more). With no length asked, a video is about a minute.
- **Flashcards.** Cards you flip and mark. A card you miss comes back in the same sitting, and every card comes back on later days until it sticks. A card can also ask you to label a picture from your sources or draw a line on a grid.
- **Quizzes.** Graded questions with feedback, each tied to the passage it tests. A question can be a choice, a problem worked in steps, things to put in order, pairs to match, working to fill in, a line to draw on a graph or a picture to label.
- **Practice exams.** A quiz with a time limit and the format of your real exam, in your own words. It counts down and gives your mark by topic.
- **Audio.** One voice walking you through your sources.
- **Guides.** A page or a few of notes with a cite at every claim, to print or change by hand.
- **Plans.** An ordered path of videos, flashcards, quizzes, audio and guides through your sources, made for your goal and your time. Give its stages days and Home lists what is due; a missed day moves on with one press, and reminders can be turned on.

**Learning from it**

- **Explain it back.** Say an idea in your own words (`/teachback`) and Open Sourcebook checks it against your sources: what you got right, what you left out and what the sources say differently, each with a cite.
- **Mind map.** `/mindmap` draws the main ideas of your sources in the chat and how they link, and each idea opens its cites.
- **Talk back to anything.** Open a thread on a video's moment, a card or a quiz answer, and Open Sourcebook answers about that spot with cites, or makes it again with your change.

**How you use it**

- A word in the chat (`/video`, `/flashcards`, `/quiz`, `/audio`, `/guide`, `/plan`), a tile in the Studio, or the `opensourcebook` command from a terminal or your own agent's session.
- Your agent: Claude Code, Codex, OpenCode, Antigravity, Cursor or GitHub Copilot, signed in the normal way. The model picker shows each agent's and each model maker's logo.
- A voice: an ElevenLabs key, a Speechify key (its free account reads a few hours a month), or Kokoro, a free voice that runs on your own computer.
- A phone on the same Wi-Fi can open Open Sourcebook as a feed of everything you made, or of one project (`npm start -- --phone`).
- `npm start` checks your computer, installs what is needed and starts everything. `npm run update` moves your copy forward and says what is new.
- Settings > What makes what is one table of who makes and who reviews each shape, with which model and effort, and the voice.

**Fixes before the first tag**

- The chat says truthfully what of Open Sourcebook reaches the web.
- A caption never breaks inside a number, between a number and its unit, or inside a range.
- Sound and stills are made without the video service stopping to answer.
- Small grey text is easier to read, and screen readers find each screen's main part and heading, and hear a cite's words without the source's formatting marks.
- The first start lists the agents you don't have in one line, the `opensourcebook` command remembers the project you named, and something made on its own no longer opens as "1 of 1" in a plan.

**What is rough**

- Claude Code is proven end to end. Codex and OpenCode are less proven. Cursor and GitHub Copilot are built and tested against stand-ins, but not yet tried for real. Antigravity is built and has never been run on a real install.
- Tried on a Mac. Linux is only partly tried. Windows has its own automated checks, but they have not run yet, and it is not tested by hand (help wanted).
- Videos are good, not great, and take minutes to make. Fourteen styles are kept in the repo and four are offered; the others wait until a finished video in each has been watched.
- Without a voice, videos have no sound and audio cannot be made. Speechify has been tested against a stand-in, not a real key. Kokoro sounds less natural than ElevenLabs and is tried on Linux only.
- A real phone has not been tried yet.

What works where, in full: https://github.com/Mikiyas-Meles-Assefa/opensourcebook/blob/main/docs/LIMITS.md#what-works-where
