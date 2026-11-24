---
name: make-a-video
description: Making an Open Sourcebook video from the person's passages - what Open Sourcebook needs from it, how the tools fit together (beats, the scene language, building, looking, rendering the real video with its voice, watching it), and where the scene language, the depicter's kinds and worked scenes are. Read it first when making a video.
---

# Making an Open Sourcebook video

Open Sourcebook is a study app. The person has added their own sources (notes, papers, pages, books), and a video is one way Open Sourcebook helps them understand a part of those sources. It is short, it is watched on a phone held upright, and it is for someone trying to understand this: a picture that shows the idea and a voice that waits for it. Nobody watches you work; the person sees the finished video.

## The usual order

This is the usual order for making an Open Sourcebook video, and why each step is there — reorder or revisit steps whenever the video needs it.

1. **Read the passages.** Everything said must stand on them, and what they hold decides what the video can be.
2. **Decide what the video is:** its title and the one idea the viewer should leave with (about_video). Pick a style only when it is left to you. Every beat then serves that idea, and a beat that does not can go.
3. **Write each scene, words and picture together** (write_beat). The words decide when the picture changes, and the picture decides what the words need to say; written apart, they drift into two people talking.
4. **Look at scenes as you go**, above all the one that carries the idea. A build's measures say what the engine can count; only stills and strips show whether the thing is on screen when it is named.
5. **Place the sound** (sound), once the scenes build, since it sits on their words and mixes into the render.
6. **Render the whole video** (render). It is the first time the video exists as the viewer meets it: the real voice and its pace, the sound, every cut, the captions over it.
7. **Watch it and read the viewer report** (watch, with phone: true for a phone's size; viewer_report). What only the whole video shows is there and nowhere else.
8. **Change what needs it** (including sound if word numbers moved) **and render again**, to see what moved.
9. **Finish** (finish).

## What Open Sourcebook needs from a video

These come from Open Sourcebook itself, not from taste:

- Everything said stands on the passages. Every beat cites at least one passage with a quote copied word for word (only spaces may differ). The web and pictures can show what things look like; what the video claims comes from the passages.
- Ids like `s2` or `p1` never appear in anything said or shown.
- Each beat is cut to from the one before, so every scene starts with a plain state at `@0`, and that first state is on screen from the beat's first frame.
- The narration is burned in as captions in a band near the bottom of the frame, which the engine keeps clear.

## How the pieces fit

A video is a list of **beats**. A beat is one scene: its words (narration) and its picture (a scene written in Open Sourcebook's scene language) made together. You send a beat with `write_beat`, and send only what changes after that. You can add, reorder, rewrite and remove beats in any order.

- **The voice speaks a beat's words at once**, and write_beat answers with each word's number and time. A scene is timed to its own words: `@0` is its first word, `@7` its eighth. `[pause 1.5]` in the narration makes the voice wait; the scene reaches each pause as a hold (`@h1`, `@h1.end`) where the picture can do something while nothing is said.
- **The scene is built on those times at once.** The answer says what the engine could not build past (with lines), or what it measured: what a viewer would notice (an empty opening, small or cut words, a picture that is only words and boxes), the instruments' readings, and craft notes.
- **`look`** shows a beat as stills at the word numbers you name, or as a strip of frames over a stretch of seconds, with what is said at each frame and where the picture stands still.
- **`render`** makes the real video: the voice for every beat, every scene built on its real word times, the music and effects you placed with `sound`, the captions and the end card, mixed and rendered to the mp4 the person will get. It runs in the background while you keep working. It is the only place the whole thing exists as the viewer will see it: beat stills and a strip are pictures of one scene, built on their own.
- **`watch`** shows the latest render: frames over the whole video, or over the seconds you name, each with what the voice says at that moment and which beat it is. When nothing is rendered yet, or the video changed since, it says so, and shows each beat's opening and end from the builds instead.
- **`viewer_report`** reads the latest render the way a person watching it on a phone would meet it, and says in plain words what they would notice, each with its time, its beat and the numbers measured, the most noticeable first: words gone before they can be read or before the voice names them, writing too small for a phone or cut by the frame, a picture standing still while the voice goes on, a beat that opens empty, gaps in the voice, its pace. It ends with what reads fine and what it cannot measure. It is measured from the mp4 and the scenes. The render's own answer shows frames of the cut at phone size along with how many things the report found and the most noticeable of them. It reads only a render: the builds alone never show the voice's real pace, how long writing really stays up, or where the whole picture stands still. Ask again after a new render to see what moved. `watch` with `phone: true` shows the frames at the size a phone shows them.
- **`sound`** places the music beds and the few effects under the voice, from the kit it lists. None chosen means voice only.
- **`about_video`** records the title, the idea (what the viewer understands by the end), the style when it is yours to pick, and why the video is shorter than asked when the passages say too little.
- **`finish`** ends the work. When the latest render is of the video as it stands, that render is what the person gets. Otherwise Open Sourcebook voices and renders it once more after you stop. Once a video, when Open Sourcebook's own record shows a step was skipped (the video never rendered, a render never watched nor its report read, a viewer report (manual or shown with render) that listed things with no scene changed since), finish answers with those facts instead of ending.

Every tool answers in plain words; a refusal says why. A stop from the person ends the work at any time.

## What a render shows that the builds do not

A beat's build is that beat alone, on word times that may be estimated. The render is the first time the whole video exists at the voice's real pace, cut to cut, with captions over it, the way a person meets it. Some things only show there: the picture holding the same frame for five seconds while a long sentence runs under it, a label that changes before the voice reaches the word it names, a beat that is over before the thing it drew can be taken in, a voice faster than the scenes were written for. The viewer report lists what of this is in the render, with the times, so it can be weighed against what the video is for. Often the first render is not the last: makers tend to render once every beat builds, read the report and watch at phone size, change what they judge worth changing (a change moved onto the word that names it, a long sentence split across states, a label kept until it is said, a pause where the picture needs time), and render again to see what moved. A still diagram can be the point.

## Using a style, and choosing one

A style is a small world, not a palette: its own line (chalk gone over twice, a pen that swells and tapers, a ruled drafting line), its own fills and page, its own way things arrive (drawn on, written on, popping in with a spring, ruled at an even pace), its own captions and its own change between scenes. Usually the style is already given with the video, and one style draws the whole video.

Inside it, let the style do the styling. Name what a thing is (`role=title`, `key`, `answer`, `label`, `muted`) and the style decides its look; keep to its colors, with its one accent for the thing that matters now, so the accent means something each time it appears. Its leanings (in the guide, with why) are the moves that feel native to it. Pieces from the shelf take the style's colors, fonts and line on their own.

Now and then the style is left to you. Then read each one's description for what it suits, and pick by what the subject is and how it is best told: worked steps and maths suit a board that is written on, a process or a system suits clean shapes or a technical drawing, a story about people, ideas or history suits a page.

Some things are true in every style. The frame is tall: a square subject leaves the bottom third empty above the captions, so give a subject its height (a taller `h=` on a piece, a stack with the subject in the middle and the words above and below it) or put what the voice says next there. Labels sit beside lines and rings, not on them; the style draws a rim of the page round letters so a line passing behind words does not touch them, but a label placed on a line still reads as crowded. And a generic stand-in (a blank document for a law, a box with a word in it) held while the voice gives the specifics reads to a viewer as a placeholder: draw what the specifics are (the wage pinned under a line while the pressure pushes up, the number before and after).

## The scene language

`references/scene-language.md` is the whole guide to the language, written for this video's style and frame: states at word numbers, kits that compute (sorts, graphs, matrices, maths), programs that draw and move real outlines, things drawn as themselves, boards, stages and cameras. It was written for a writer who returned one scene as text; here each beat's scene is its own source sent with write_beat.

When a scene draws a thing as itself (`depict ID "words"`), you are the depicter: write_beat says what the depicter is asked, and you send the thing's spec in `depictions` with the beat. `references/depicting.md` has every kind, its parameters, colors, verbs and states.

## The shelf of pieces

Besides the kits, the scene language has **pieces**: ready-made things that draw themselves in the video's style and follow the voice, such as a line over time, a timeline, a cycle, a balance tipping, a sentence taken apart, a calendar, a probability tree, particles moving, tanks that fill and drain. Each is a program you run by name (`run NAME id key=value w= h=`); its settings take the video's own words and numbers, lists split by `|`, and most bring each part in when its words are said, or at the moments you give in `when=`. The guide lists them all with a line each.

`find_piece` searches the shelf by what you want to show, in plain words about the picture rather than the topic ("an amount that changes over time", "two sides weighed", "steps in order", "parts of a whole"), and answers with the pieces that fit, how to write each, its settings and a picture of each. Looking at the pictures is the quickest way to choose. With a name it shows the piece's whole program. With neither, it lists every piece and shows the whole shelf as one picture, each piece as its own small scene ends with its name under it. The first time in a video that a beat's picture is only words and plain shapes, write_beat's answer carries that same picture, so what is on the shelf can be seen beside the beat.

A piece is a starting point, not a frame to fit the idea into. Set it up with its settings, put your own words, marks, tags and camera around it, and when it is close but not right, copy its program into a program of your own and change it.

When nothing on the shelf shows what the words need, draw it yourself with a program, as always; the search keeps a note of what was looked for, so the gaps get filled. If what you made came out well and is general (what changes from one use to the next comes in as settings, and it draws inside whatever box it is given), `save_piece` keeps it on this person's shelf, and the next video's search finds it beside the shipped ones.

## More in this skill

- `references/examples.md`: the cookbook. Whole scenes on topics unrelated to any video, each timed to its own narration, in `references/examples/`. They show the form and the mechanism, never the content.
- `references/a-session.md`: one worked session, the back and forth between the words, the picture and what was seen, over a whole video.
- `references/simulation.md`: programs that run real rules, so what is seen comes out of them, with measures that prove it.
- `references/whiteboard.md`: a board that fills as the voice explains, with the camera following the writing.
- `references/worked-math.md`: symbols that keep their identity, calculations written as they are said, notation.
- `references/what-viewers-notice.md`: what people new to a topic noticed watching finished videos on a phone, again and again: where they got lost, what looked unfinished, what made it click.

The other skills: **teaching** (how to explain so a person follows) and **media** (the voice, pictures from archives, the web or a generator, cut-outs, sound, and your own tools when they are on).
