---
name: media
description: Everything an Open Sourcebook video uses besides the drawn scene - the voice and its pauses, real pictures from open archives and the web, made pictures, cut-outs, PDFs and video frames, the music and effects kit, and your own shell and files when they are on. Read it when a beat needs a picture that is not drawn, or when you work on the voice or the sound.
---

# Voice, pictures and sound

## The voice

Each beat's words are spoken as soon as you send them. With ElevenLabs on this computer, each beat is read with the beats around it as context, so the voice carries across cuts; the voice is the style's own unless the person set another. Without it, a plainer voice or estimated timing stands in, and `render` says which voice the video has.

- A beat is spoken again only when its words or pauses change.
- `[pause N]` in the narration is a silence of N seconds after that word. It is how the voice waits for the picture: the scene sees each pause as a hold (`@h1`, `@h1.end`).
- Words are timed from what was really spoken, so a picture keyed to a word arrives on that word.
- About 2.5 spoken words make a second.

## Pictures

Besides drawing, a scene can show pictures. A drawing that moves often explains best; a real picture shows what a thing, place, person, artwork or document really looks like; a made picture sets a scene or shows what can't be photographed. Mix them freely: a photo with drawn marks on it, a cut-out beside a drawn diagram.

The picture tools in your tool list are the ones this computer can run now:

- `find_images` searches open archives (Wikimedia Commons, NASA, The Met, Smithsonian, the Internet Archive, Openverse): real photos, paintings, maps, diagrams and scans that may be shown with a credit.
- `web_search` finds pages anywhere on the web; `open_page` reads one, lists the pictures on it, and can take a screenshot as a phone or a desktop shows it.
- `video_frames` takes frames from a video file or a video page at the moments you choose.
- `read_pdf` reads a PDF's pages and can show a page or its figures as pictures.
- `generate_image` makes a picture from your words (an illustration, a scene, a character, a background, a diagram), in the video's look or any other, and can follow reference pictures so a subject stays the same across scenes.
- `cut_out` lifts one thing out of a kept picture along its edge, so it can stand on the scene's own surface, move, or sit beside drawn parts.
- `view_images` shows candidates larger; `save_image` keeps one under a name; `assets` lists what is kept.

Every search, page, frame and figure shows you pictures with ids (`c12`). A picture is worth keeping when it shows what the words say, is sharp and large enough for a phone, and carries no writing too small to read. When none is right, other words, another route, or a made picture usually are.

A kept picture is shown in any scene with `image ID asset=NAME w=… h=…` (`frame=fill` covers the frame behind everything, `frame=fit` shows all of it), and its parts can be tagged, ringed and framed like anything drawn. Pictures from elsewhere are credited under the picture while it is on screen and on the end card, for you.

## Sound

`sound` places the kit under the voice: music beds (each plays until the next cue, lowered under the voice by itself) and a few short effects on the word where something lands. The tool's own description lists every sound and the level ranges. Most moments are better silent; a bed that suits the subject can carry the whole video; an effect marks a reveal or a result landing rather than every entrance; nothing should swell over a key line. The final mix is mastered to a steady loudness, which `render` reports.

## Your own tools, when they are on

What your own tools can do in this video's own folder (your current folder, which the picture tools call `work/`) is said in your instructions, under "Your folder". With your file tools only, you can read the skills there as files and keep notes and drafts beside them. Where Open Sourcebook also walls in your shell and the web, you can read and write freely there and reach the web, but nothing else on this computer. Those are for what the tools above don't do: download a file, crop, combine or retouch pictures (ffmpeg, sips, ImageMagick, Python when installed), draw a chart or a map from real numbers with a script, trace a picture into outlines, take a dataset apart, try code before it goes into a scene program. `save_image from=work/FILE` keeps a picture you made or fetched there (say where it came from in `source`, so it is credited). Everything in the video still goes in through Open Sourcebook's tools: write_beat, sound, render, finish.

The skills themselves are in `skills/` in that folder, as files.
