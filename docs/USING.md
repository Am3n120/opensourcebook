# Using Open Sourcebook

What Open Sourcebook makes, how you ask for it and how it works underneath. The short version is in the [README](../README.md).

## Things to ask it

Type these in the chat of a project, in your own words:

- "Make a short video on how the Krebs cycle works, from chapter 7." (study)
- "Quiz me on these lecture slides. My exam is on Friday." (study)
- "Explain this paper's method as a video, and give me a guide to keep." (research)
- "Turn this forty-page report into a two-minute video I can show my team." (work)

## What it makes

Each thing is made from the sources you put in, by your own agent, and shows where its claims came from.

- **A video to watch.** A short explainer, drawn scene by scene in a style you pick, with narration and captions. With no length asked it is about a minute. It takes several minutes to make, because the agent writes the scenes, draws them and looks at what it drew. On a video, **Remake this scene** makes the scene playing again from a note of yours.
- **Flashcards to swipe.** Cards you flip and mark got it or not yet. A card you miss comes back in the same sitting, and every card comes back on later days until it sticks. A card can also ask you to name the marked parts of a picture from your sources, or to draw a line on a grid.
- **A quiz to check.** Questions with feedback, graded, each tied to the passage it tests: a choice, a problem worked in steps, things to put in order, pairs to match, working to fill in, a line to draw on a graph or a picture to label. It can be three questions or a practice exam with a time limit and the format of your real one.
- **A guide to keep.** A page or a few of notes with a cite at every claim, to print or change by hand.
- **Audio to listen to.** One voice walking you through your sources, with no picture. It needs a voice ([`VOICE.md`](VOICE.md)).
- **Answers.** A question in the chat gets an answer in which each claim carries a cite. Open Sourcebook checks every cite word for word against your source, and a cite opens the passage it came from.

More you can do with them:

- **Explain it back.** Say an idea in your own words (**Explain it back**, `/teachback`) and Open Sourcebook checks it against your sources: what you got right, what you left out and what the sources say differently, each with a cite.
- **See how it fits together.** **Map the ideas** (`/mindmap`) draws the main ideas of your sources in the chat and how each links to the others. Tap an idea for its sentence and its cites.
- **A plan when you want a path.** `/plan`, or the Plan a whole subject row, makes an ordered path of videos, flashcards, quizzes, audio and guides through your sources, sized for your goal and your time. It comes back as a card you look over and edit, then start. Give its stages days ("quiz me on this by Friday", or a day set by hand) and the plan shows what is due and what you missed; a missed day moves on from today with one press, and reminders can be turned on in Settings.
- **Talk back to anything.** Open a thread on a video's moment, a card or a quiz answer ("Ask about this, or disagree"). Open Sourcebook answers about that spot, with cites, and says so when the thing is wrong. Say "make it shorter" in plain words and it is made again with that change; the first one stays.
- **The same on your phone.** A phone on the same Wi-Fi opens Open Sourcebook with your projects, and its Library tab is a feed of what you made, one thing per screen. Turn on **Open on your phone** in Settings and scan the QR code. [What makes it safe enough, and what does not.](PHONE.md)

**Making one.** Every way of asking opens the same make sheet, already filled in, and nothing is made until you press its button. The sheet shows what it will read, the shape's settings and who makes it (and who reviews it, where the shape has a reviewer), with how long that usually takes on your computer.

- **A tile.** Make, on the right of a project, has a tile for each thing it makes. A tile opens the sheet.
- **A word in the chat.** `/video`, `/flashcards`, `/quiz`, `/audio` or `/guide`, then what it is about; or ask in plain words. The sheet opens filled in, and you press its button to make it.
- **The `opensourcebook` command.** Everything the app does is also a command, from a terminal or from your own agent's session ([`COMMAND.md`](COMMAND.md)). A terminal has no sheet to press, so `opensourcebook make` makes at once.

Everything made, and everything being made, is in one list, Made here, under Make. Each row has a ⋯ menu that removes it (it asks first, since removing a made thing or a plan is for good), failed and stopped things can be cleared together, and one item of a running plan can be stopped while the rest goes on.

**Who makes what.** Settings > What makes what is a table of the chat and every shape: who makes it (an agent, a model and an effort), who reviews it where a shape has a reviewer, and its voice. It is the one place defaults are set; a make sheet or a plan item changes only that one thing. With several agents ready and none picked, Open Sourcebook asks which one rather than choosing for you, and no agent is preferred.

**How long things take.** A quiz or a set of flashcards takes about a minute. A short video takes about 5 to 15 minutes, and the strongest model takes much longer than the default. You can use Open Sourcebook while it works, and a job carries on after a restart, a sleep or your agent's plan reaching its limit.

## How it works

- **The agent you already have does the making.** Open Sourcebook starts the agent that is installed and signed in on your computer (Claude Code on a Claude plan, Codex on a ChatGPT plan, Antigravity on a Google plan, or another from [the table of agents](LIMITS.md#supported-agents)) and gives it a task. It uses the agent as it is, and never reads, stores or passes on your login.
- **It gives the agent tools and knowledge.** The agent gets Open Sourcebook's tools (read a passage, write a card, build a scene, look at a frame) and skills to read (`skills/` and `services/scenes/skills/`). It is not given rules or gates.
- **Four programs on your computer.** The engine (projects, sources, plans, and checking every cite), the web app, the agent connector (runs your agent) and the scenes service (draws, voices and renders videos and audio). One launcher starts all four and keeps them in step.
- **Your projects are kept here.** Projects, sources and what was made live in a database and folders on this computer. There is no Open Sourcebook account and no Open Sourcebook server.
- **In the box.** A shelf of 50 pieces (number lines, timelines, maps, sorting, graphs and so on) that videos are built from, twelve styles to pick from, and a finished example on Home to look at before you add your own.
