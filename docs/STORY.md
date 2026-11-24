# How Open Sourcebook came to be

A short, honest history of the project, for the curious. It had a shorter working name until late November 2026.

## August 2026: a summary app

The first version was an iPhone app and a small engine on Cloudflare. It took anything you saved and turned it into a "byte": a visual summary. It worked, and it ran for a while. It was fine. Nobody, including its maker, opened it every day, because a summary is not something you come back for.

## Late October: learning to make a video properly

Alongside, a separate week of work on explainer videos taught how to make one that holds up: a scene language where each picture is tied to the spoken words that name it, instruments that measure what was drawn, a review of how it looks, a repair loop, and every claim tied to its source. On October 31 this repository began as an experiment in turning a PDF into a motion-graphics video.

## November: rebuilding around one idea

The conclusion was that what is made has to be worth coming back for: videos, cards and quizzes that are better than the source, planned together as a path through it, not one summary at a time. The repository was rebuilt around that, in this order:

- The old iPhone app and engine were brought in, already arranged for the new product (projects, sources, plans, the shapes).
- A web app was built on the same engine: projects, a chat with cites that open the exact passage, plans you can edit item by item, and players for what is made.
- The project could not give people free model use, so the work moved to the coding agent a person already has. A small connector on their computer launches it and hands it the tools. Chat answers, flashcards, quizzes and videos are all made that way.
- The video engine from October came across as the scenes service: the scene language, the pieces and the styles, the voice and the render. The agent writes a video the way it writes anything else, with skills to read and tools to look at its own work.
- The agent's own tools were boxed into a folder of its own, and it was settled that a subscription login is never held or forwarded.
- Everything fake was taken out: the stand-in makers, the offline provider and the storyboard maker. What is on screen is made by a real maker or not at all.
- One command, `npm start`, started four programs together. The first finished example, a shelf of ready-made pieces and a first shape for how anyone adds a style, a piece or an agent came next.
- The byte became flashcards, and audio and the guide were added, which makes five shapes. More agents followed, then a voice that needs no key, a redesigned web app, and a phone that opens the same app by QR code.
- On November 24 the name became Open Sourcebook everywhere, with one command, `opensourcebook`, and the MIT licence.

The reasoning behind each turn is written down, in order, in [`DECISIONS.md`](DECISIONS.md).

## Where it goes

[`PLAN.md`](PLAN.md).
