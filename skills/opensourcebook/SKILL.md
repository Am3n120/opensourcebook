---
name: opensourcebook
description: How to drive Open Sourcebook, the open-source app on this computer that works from the person's own sources, from your own session with the `opensourcebook` command - make a project from the person's files, ask it questions answered with cites, and get videos, flashcards, quizzes, audio and guides made from those sources. Read it when the person wants to understand or explain what they have to read (a course, a paper, a manual, a report) and asks for a notebook, a video, a quiz, flashcards, audio or a guide from their own files or links, or mentions Open Sourcebook.
metadata:
  for: your-agent
---

# Driving Open Sourcebook with the `opensourcebook` command

Open Sourcebook is an open-source app that runs on the person's own computer. They put their sources in (files, links, pasted text), ask questions that are answered only from those sources with a cite at the exact words each claim came from, and have things made from them: short explainer videos, flashcards (cards to swipe and flip, brought back until they stick), quizzes, audio to listen to and guides to keep. The making is done inside Open Sourcebook by the person's own coding agent, with Open Sourcebook's tools and checks, and the web app is a window onto the same projects.

Everything the app does is an `opensourcebook` command, so you can do it all from this session. `opensourcebook help` lists every command; `opensourcebook <thing> help` and `opensourcebook <thing> <action> help` say more about one, including the exact JSON it answers with. The command has one name, `opensourcebook`, and no short form. If it is not on the PATH, `here.md` beside this file says where it is on this computer.

## The shape of a session

1. **Is Open Sourcebook running?** `opensourcebook status`. If not, `opensourcebook start --background` starts it and returns once it answers (the first start installs its programs and takes a few minutes; later ones take under a minute). `opensourcebook check` says what the computer lacks when something will not start.
2. **A project.** `opensourcebook project make <title>` makes one and uses it for every command after it; `opensourcebook project list` and `opensourcebook project use <id>` pick an existing one. Every command also takes `--project <id>`.
3. **Sources.** `opensourcebook source add <files or links...>` reads each one while you wait; `--text "<words>"` adds words you have, and `-` reads them from stdin. Check what came back: a source with status `failed` says why in `errorMessage`, and `opensourcebook source show <id>` lists what could not be read. `opensourcebook source search <words>` and `opensourcebook source read <id>` let you see the sources' own words.
4. **Ask.** `opensourcebook chat ask <question>` answers from the sources only. Follow up in the same chat with `--chat <id>` (the id comes with every answer).
5. **One thing, or a plan.** When the person wants one thing ("a quiz on chapter 3", "a short video that walks a new teammate through this runbook"), use `opensourcebook make <shape> <what it is about, in their words>`: Open Sourcebook's planner settles its brief and settings and it starts at once, with nothing to approve; `--wait` follows it until it is made. The shapes are whatever this copy of Open Sourcebook can make now (`opensourcebook make help`, or a wrong shape lists them). To change it after ("make it shorter", "more questions", "in another look"), say so in the same chat: `opensourcebook chat ask "make it shorter" --chat <chatId>` remakes it with the change and keeps the old one. When they want several things or a way through the material (an exam, a course, "a video then a quiz for each chapter"), plan it: `opensourcebook plan make <what the person wants, in their words>` has Open Sourcebook's planner write a plan: items in stages, each a video, flashcards, a quiz, audio or a guide with a brief and settings. One plan can hold everything they asked for; a request with numbers they gave ("five questions", "about two minutes") is planned to them, and one without leaves it to the planner and the sources. Read it back (`opensourcebook plan show <id>`); change an item with `opensourcebook item change <item> --title/--brief/--set key=value/--off` if the person wants something different. `opensourcebook maker list` says which shapes can be made right now and the settings each takes; `opensourcebook style list` lists the looks a video can have.
6. **Start and wait (a plan).** `opensourcebook plan start <plan> --wait` starts it and follows it to the end, saying each item's live step on stderr; without `--wait` it returns at once and `opensourcebook plan wait <plan>` or `opensourcebook item wait <item>` follows it later. Flashcards and quizzes usually take a minute or two; a video takes several minutes.
7. **Hand it over.** `opensourcebook project open` or `opensourcebook item open <item>` opens the app at it in the person's browser; `opensourcebook item get <item>` saves a video's file or gives a set of flashcards or a quiz as JSON; `opensourcebook quiz show <item>` and `opensourcebook quiz answer <item> 1=B 2=A` let the person take a quiz right here, graded and recorded as in the app; `opensourcebook cards review <item>` and `opensourcebook cards mark <item> 1=got 2=not` go through the flashcards due, kept as in the app. When the person has a question about something made, or thinks it is wrong ("why not B?"), `opensourcebook item ask <item> <their words>` puts it in that thing's thread, at where they stopped in it (or `--at`), and prints Open Sourcebook's cited answer; it is also a message of the chat that made the thing. `opensourcebook item thread <item>` shows what was said about it.

`references/session.md` has more on each step and on what tends to go wrong.

## You ask; Open Sourcebook's own agent makes

When you start a plan, Open Sourcebook hands each item to the person's agent inside Open Sourcebook, which reads the sources and writes the video, flashcards, quiz, audio or guide with Open Sourcebook's tools, checks each piece and cites it word for word. Your part is to ask for what the person wants and to wait. Do not write flashcards, a quiz, audio or a video yourself and present it as Open Sourcebook's, and do not answer a question about the sources from your own reading when the person asked Open Sourcebook: what Open Sourcebook gives back is checked against the sources, and that is the point. When something cannot be made, the item says why in plain words (`errorMessage`, or the plan's `issues` before it starts); tell the person that, and what it suggests doing.

## Who makes what

`opensourcebook makers` shows which of the person's agents answers the chat and which makes (and reviews) each shape. When the person wants another one, `opensourcebook makers set <chat|shape> <agent> [--model m] [--effort e]` picks it for one, `opensourcebook makers set-all <agent>` for the chat and every shape at once, and `opensourcebook makers review <shape> <agent|off>` picks a shape's reviewer or turns its review off. An answer `pick_needed` names the thing that needs a pick and the command that sets it: ask the person which agent they want, then run it.

## Reading answers

Every command takes `--json`: a single JSON object on stdout with `"ok": true` and the answer, or `"ok": false` with `error.code` (stable, for a program) and `error.message` (one plain sentence for a person). Progress lines go to stderr only, so stdout always parses. Without `--json` the answer is short plain text. `references/answers.md` describes the shapes you will meet most: a reply with its cites, a plan, an item.

In a reply each `[n]` marks a cite: entry `n` of `cites` names the source and quotes the words the claim came from, checked word for word against that source. `covered: false` means the sources did not hold the answer; say so rather than filling the gap. A reply may ask the person a question instead of answering (`questions`, each with options): put it to them, then answer with `opensourcebook chat pick <option id> --chat <id>`.

## Showing the person what was made

The person usually wants to see and use what was made, not read JSON. `opensourcebook project open` and `opensourcebook item open` open the app in a browser on the computer Open Sourcebook runs on and print the address; with `--print` they only print it, which suits a person who is not at that screen. Give them the address and say in a sentence what is there. What Open Sourcebook made is checked against the sources as it is made; if the person wants to know what is in it before opening it, `opensourcebook item get` (flashcards or a quiz as data) or `opensourcebook quiz show` tells you. For a quick answer in the conversation, print the cited answer with its cites, keeping the source titles and quotes as Open Sourcebook gave them. A video file saved with `opensourcebook item get` plays anywhere; a quiz is better taken in the app or with `opensourcebook quiz show` and `opensourcebook quiz answer`, where the result is recorded.

## Packs

A pack is knowledge for one kind of work (such as studying for an exam) that Open Sourcebook's own agent reads while it plans and makes. `opensourcebook pack list` shows them; `opensourcebook pack on <name>` turns one on for the project when the person's work is that kind.

## Installing this skill for an agent

`opensourcebook skill install` says which folders it will write to, asks to go on (`--yes` skips the question), and copies Open Sourcebook's skills to where each coding agent on this computer looks for them. `opensourcebook skill list` shows what is installed where, `opensourcebook skill uninstall` removes exactly what install wrote, and `references/install.md` lists each agent's folders.

## When Open Sourcebook cannot be found

If `opensourcebook` is not found, or the folder named in `here.md` no longer has `cli/opensourcebook.mjs`, Open Sourcebook has moved or been deleted. Do not look for it elsewhere or work around it. Tell the person where `here.md` says it was, and that `opensourcebook skill install` run again from Open Sourcebook's new folder fixes the pointer (`opensourcebook skill uninstall` removes the skill).
