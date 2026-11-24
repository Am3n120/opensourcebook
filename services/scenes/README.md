# Open Sourcebook scenes service

The engine that makes Open Sourcebook's drawn explainer videos. The person's own coding agent writes a script and every scene in a small scene language, looks at frames of what it drew, renders the real video with its voice and watches it; then a fresh viewer, a second turn that cannot read the script or the scenes and only watches the finished video, gives notes for one round of polish. The result is a 1080 by 1920 mp4 with captions, and with narration, music and effects when a voice is set. Open Sourcebook pays for no model: the agent runs on the person's own plan, and everything else is code on their computer, except a hosted voice and the picture and web-search tools, which call their services on the person's own key when one is set.

It listens on `127.0.0.1` only and runs the agent through the agent connector on this computer (`services/agent-connector`).

## What the agent gets

- **Skills** (`skills/`): knowledge to read, never rules. `make-a-video` (what a video needs, how the tools fit together, the scene language's guide, a cookbook of worked scenes), `teaching` (how to explain so a person follows) and `media` (the voice and its pauses, pictures, the sound kit).
- **Tools**: `read_passages`, `read_skill`, `about_video`, `write_beat`, `look`, `render`, `watch`, `viewer_report`, `sound`, `find_piece`, `save_piece` and `finish`, plus a toolbox for pictures and the web (`web_search`, `open_page`, `find_images`, `generate_image`, `cut_out`, `read_pdf`, `video_frames` and others) where this computer can run it.
- **Pieces** (`pieces/`): a shelf of 50 ready-made things to put on screen and drive with a few settings and the spoken words, such as a number line, a timeline, a map, a sort or a graph. One folder each.
- **Styles** (`styles/`): the look of a video, one file each: its palette, fonts, line, fills, page, motion and captions. Twelve of the fourteen are offered; **Sketchnote** and **Terminal** are kept in the repo and not offered yet, until every piece draws cleanly in them.

## How a video is made

1. **The engine asks.** `POST /videos` with the title, the brief, the length, the style and the passages from the person's sources.
2. **The agent writes.** One turn of the person's agent, with the skills and tools above. It writes each beat (its narration, its cites and its scene), and every quote is checked word for word against the passages.
3. **It looks.** Each beat is built at once on the times of its spoken words, and the agent looks at stills of it as often as it wants. There is no clock, no count of looks and no enforced order.
4. **It renders and watches.** `render` makes the real video; `watch` and `viewer_report` show the agent what a person on a phone would see and notice.
5. **A fresh viewer reviews.** A second, blind turn watches the finished video and names what worked and what did not. The maker gets one polish turn and weighs the notes for itself. Nothing is scored or blocked.
6. **The video is handed over.** `GET /videos/:id` says how it stands, and `GET /videos/:id/file` is the mp4.

A job and its draft are kept on disk, so a video that was stopped by a restart or by the agent's plan reaching its limit is carried on from what exists. Each step in full: [`REFERENCE.md`](REFERENCE.md).

## Run it

To run all of Open Sourcebook at once, run `npm start` at the repo root ([`docs/DEVELOPING.md`](../../docs/DEVELOPING.md)): it starts this service with the others, with the shared secrets and ports filled in, and downloads the headless Chrome below on its first start. What follows is for working on it alone.

Node 24 or newer, ffmpeg and ffprobe on the path, and the styles' fonts ship in `fonts/`. For a voice, put `ELEVENLABS_API_KEY=…` in `services/scenes/.env` (git-ignored) or the shell; without it videos have no sound, on every system. yt-dlp is optional (`brew install yt-dlp`), for frames from video pages.

```sh
cd services/scenes
npm install
npm run browser      # downloads Remotion's headless Chrome (about 170 MB)
```

Start the agent connector first (`services/agent-connector/README.md`), then:

```sh
SCENES_TOKEN=<a long random string> \
SCENES_CONNECTOR_TOKEN=<the connector's OPENSOURCEBOOK_CONNECTOR_TOKEN> \
npm start
```

To try it without the engine, with a running service: `SCENES_TOKEN=… node --experimental-strip-types scripts/try-video.ts examples/heart.json out.mp4`. Every setting is in [`REFERENCE.md`](REFERENCE.md#settings), and `.env.example` lists the names.

## Check

```sh
npm run typecheck
npm test            # the scene engine's tests, then this service's
```

The service tests build, look and render for real (they need Chrome and ffmpeg) with a fake connector that plays an agent and the silent voice, and the ElevenLabs code with a stand-in for its call (a tone with even character times); they never start a real agent or call ElevenLabs.

To make or change a piece, `npm run piece -- NAME --styles flat,ink,neon` builds its scene in those styles, prints what a viewer would notice and writes stills to look at. Adding a style, a piece, a voice or a skill: [`docs/EXTENDING.md`](../../docs/EXTENDING.md).

## What is in this folder

| Here | What it is |
|---|---|
| `engine/` | The scene language, its compiler, the kits that compute their steps (sort, graph, matrices, Dijkstra, code trace, math), layout measured in real fonts, motion, styles as themes, the design instruments and the Remotion renderer. |
| `pipeline/` | The scene stage's helpers (what code sees about a built part, the instruments over it, stills), caption pages from word times, the Remotion render of a timeline, word times without a voice, and how many frames are drawn at once. |
| `video/` | The video composition and the end card. |
| `pieces/`, `styles/`, `fonts/` | The shelf of pieces, the styles, and the fonts the styles name (each with its licence). |
| `skills/`, `prompts/` | What the agent reads: the three skills, and the scene language's guide and repair note. |
| `src/` | The service: the agent's tools (`tools.ts`), the toolbox (`toolbox/`), the script checks (`script.ts`), building one scene (`scene.ts`), the voices (`voice.ts`, `voices.ts`, `eleven.ts`, `speechify.ts`, `kokoro.ts`), the sound mix (`sound.ts`), voicing, final build and render (`produce.ts`), the agent's own renders (`cut.ts`), the viewer report (`report.ts`), the fresh viewer (`review.ts`), jobs on disk (`jobs.ts`), the HTTP service (`server.ts`) and the connector client (`connector.ts`). |
| `audio/` | The sound kit: four music beds and ten effects, made once with ElevenLabs, kept in `audio/kit/src` and described in `audio/kit.json`. |
| `voices/kokoro/` | Where the voice that runs on this computer is installed (`npm run voice:kokoro`). |
| `scripts/`, `examples/`, `test/` | Scripts to try the service by hand, sample requests for them, and the service's tests. |

## Reference

[`REFERENCE.md`](REFERENCE.md) has the rest: every tool with what it takes and answers, the voice and what happens when it goes away, the fresh viewer, the shelf, the styles, the toolbox and its limits, the workspace, the HTTP contract for videos and audio, the settings and the notes on Chrome, fonts and Remotion's licence.
