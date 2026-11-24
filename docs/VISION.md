# Open Sourcebook: the vision

This is what Open Sourcebook is for and the shape it is built toward. [`PLAN.md`](PLAN.md) says what is being worked on, [`DECISIONS.md`](DECISIONS.md) records what was settled and why, [`GLOSSARY.md`](GLOSSARY.md) maps the words on screen to the names in code, and [`STRUCTURE.md`](STRUCTURE.md) says where things live.

## In one line

Understand what you have to read. Explain what you know.

A person adds their PDFs, notes, slides and links. Open Sourcebook turns them into a short explainer video, drawn scene by scene, and into flashcards, a quiz, a guide, audio and answers. Every cite is checked word for word against the source. It is free and open source, it runs on the person's own computer on the AI plan they already have (Claude, ChatGPT, Gemini, Cursor, GitHub Copilot and more), and their files stay on their computer.

## Who it is for

People who have material to understand or to explain: a student with a course, a researcher with a stack of papers, someone at work with a long report and a team to brief. They use the Claude or ChatGPT desktop apps. They do not open a terminal, and nothing in the product should ask them to after the one line that installs it.

Study is the first thing it does, not the only thing it is for.

## The one thing that matters

The quality of what it makes. A summary of a source is not worth coming back for. What is made has to be better than the source for the person in front of it: clearer than the lecture, easier to hold than the paper, short enough to show a colleague.

The video is where this is hardest and matters most, so it leads. The bar is the explainer a very good teacher would make, voice and all. Nothing moves for the sake of moving. No look is repeated across unrelated sources. Real pictures from the sources, not mock-ups. The story decides the length.

How a thing is held and moved through is part of its quality, not a layer on top of it.

## The shape of the product

**Sources in, things made from them, each one showing where it came from.**

### Projects and sources

Everything lives in a project: a course, a paper, a report, a topic. A project has sources of many kinds (PDFs, slides, documents, pictures, links, pasted notes, recordings) and the sources ticked in a project are the ceiling for what an answer or a made thing may draw on.

### Three parts of a project

- **Sources**, what the project holds and which of them are in use.
- **Chat**, where the person asks. A question gets an answer in which each claim carries a cite, and a cite opens the exact passage. The chat is also where a thing is asked for in plain words.
- **Make**, where each shape has a tile, and one list holds everything made and being made.

### What it makes

Five shapes, told apart by what the person does with them:

- **video**, to watch;
- **flashcards**, to swipe and come back to until they stick;
- **quiz**, to check, from three questions to a practice exam;
- **audio**, to listen to while doing something else;
- **guide**, a page or a few to keep, print and change by hand.

Beside them, in the chat: answers with cites, explaining an idea back and having it checked against the sources, and a map of how the ideas fit together.

A purpose is never a shape. "A mock exam", "fix what I missed" and "brief my team" are what a thing is asked to be, written in its brief, not a new kind of thing. Variety comes from makers, kinds of card, kinds of question, styles and pieces, each one file or one folder in its home, and a new shape is rare.

### Asking for one

Every way of asking (a tile, a word in the chat, plain words) opens the same sheet, already filled in: what it will read, its settings, who makes it. Nothing is made until the person presses its button. Everything the app does is also a command, so a person's own agent can drive it from its own session.

### A plan, when a path is wanted

A plan is one coherent body of things, not items made one at a time: stages in order, items side by side within a stage, and branches that depend on how an earlier item went. The planner decides how many and which from the sources and the conversation. Each item has a shape, a brief the person can edit, its own sources and its settings. A later item may assume the earlier ones.

A plan has no days unless the person gives some. When they do, it shows what is due and what was missed, and a missed day moves on from today. A day never changes what is made or in what order. Progress is a done tick, with no streaks.

### Talking back

Anything made can be answered: a moment of a video, a card, a quiz answer. The reply is about that spot, with cites, and it says so when the made thing is wrong. Asking for a change makes the thing again and keeps the first.

### The phone

The phone is for going through what was made and for capturing. It shows the same projects as a feed, one thing per screen: down for the next thing, sideways inside a thing. Planning and editing stay on the computer.

## How it is built

- **The person's own agent does the making.** Open Sourcebook starts the agent already installed and signed in on the computer and gives it a task. It never reads, stores or passes on a login.
- **Four programs on the person's computer.** The engine, the web app, the agent connector and the scenes service, started together by one launcher. There is no Open Sourcebook server and no account.
- **Knowledge, tools and things to see, for the agents it runs.** Skills to read, tools to call, pictures and reports of their own work. No rules or gates forced on them.

## Principles

1. **Grounded over fluent.** If the source does not say it, the output does not either. Every cite is checked word for word, and a cite points at the exact spot.
2. **Content decides form.** No fixed "one source, one summary". The sources and the person's goal decide the shape, the count and the length.
3. **Nothing hardcoded.** No fixed palettes, lengths, layouts, recipes or lists of makers. What is made from one source should not look like what is made from another.
4. **Everything in its home.** A shape, a maker, a kind, a style, a piece, a skill, a pack, an agent and a voice are each declared in one place, and the rest of the code reads the list.
5. **Plain about what leaves the computer.** The files stay on the computer. The person's agent sends what it reads to its own provider, as it always does, and the product says so.
6. **Honest about what works.** What has been run for real is said to be proven, and what has only been built is said to be built.
7. **No prices on screen.** The engine counts what each run took; the app shows time, not money.
8. **Small tested pieces.** Do not cut corners.

## Not part of it

A hosted service, accounts, payments, and sharing what was made in public. Talking out loud with it.

## Examples

These illustrate the idea. They do not define it: no shape, stage, label or setting below is built in, and a plan for something else should look nothing like them.

**Exam prep.** A course with an exam coming. The planner might open with a short quiz to find what the person does not know, then a stage per topic (a video, then flashcards and a quiz), with a branch under each quiz for what was missed, and a long quiz as a practice exam early enough to repair what it shows.

**One research paper.** One PDF, no exam. A video on the one idea that is hard to picture, a guide to keep, a short quiz. No branches.

**A report at work.** A long report and a meeting on Thursday. One two-minute video to show the team, and a guide of the numbers with a cite at each.

**The smallest case.** One link, one thing made from it, in whichever shape fits.
