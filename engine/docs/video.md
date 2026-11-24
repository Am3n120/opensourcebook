# Video payload

**This file is the contract.** It is the shape of `payload` for an output of
format `video`, schema version 1. The engine writes it, its validator checks
it, and the web and the phone play it. A change here is a change for every
client; it gets a new schema version, never a silent edit. The decision
behind it is `docs/DECISIONS.md` #48; who makes it is #54 and #69.

## In one paragraph

A video is an ordered list of **scenes**. Each scene says what is seen
(described concretely enough that a picture, a clip of the source, a chart
or an animation could be made from it), what is said (the narration, word
for word), any text on screen, how long it lasts, and where its claims come
from. That list is checked by the engine and stored and versioned like a
byte's bits, beside `render`, the file its **maker** made from it. Which
maker made it is in the payload. On the phone a video has nothing sideways
(DECISIONS #36); scrolling down goes to the next thing.

How many scenes, how long each one is, what kind of scene or picture it is
and how long the whole video runs come from the sources, the item's brief and
the item's settings, never from a fixed list or count in code.

## Where it appears

| Where | What |
|---|---|
| `GET /v1/outputs/:id` | `output.type` is `"video"`, `output.schemaVersion` is `1`, `output.payload` is a Video. |
| `GET /v1/formats` | `video` is `ready: true` when a video maker is set up on the engine, `ready: false` otherwise (`api.md`, "Formats"). |
| `GET /v1/assets/:id` | The file named by `payload.render.assetId`. Answers byte ranges, so players can seek. |

## Video

```json
{
  "schemaVersion": 1,
  "title": "Why the sky is blue",
  "idea": "Short wavelengths scatter more, so the blue in sunlight comes at us from every direction.",
  "aspect": { "width": 9, "height": 16 },
  "scenes": [ Scene, … ],
  "render": Render
}
```

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | number | `1`. |
| `title` | string | Non-empty. |
| `idea` | string | The one thing the video carries, in a sentence or two. Non-empty. |
| `aspect` | object | `{ width, height }`, whole numbers, the frame's shape (9 by 16 is portrait). From the item's `aspect` setting. |
| `scenes` | Scene[] | 1 to 60, in playing order. |
| `render` | Render | The file made from the scenes. Every output the engine stores has one. |
| `notes` | string[], optional | What Open Sourcebook's own checks found in the video that did not stop it being kept, in words for the person; the plan shows them on the item's row (`madeNote`). Absent when they found nothing. |

## Scene

```json
{
  "id": "s1",
  "kind": "question",
  "durationMs": 7000,
  "visual": {
    "kind": "picture from the source",
    "description": "The photo of a clear midday sky from the article, cropped to the deep blue straight overhead; a thin white arrow points up from the bottom edge."
  },
  "narration": "Look straight up on a clear day. Why is that colour blue, and not white like the sun?",
  "onScreenText": ["Why blue?"],
  "cites": [
    { "sourceId": "src_3", "spot": "passage", "chunkId": "chk_8", "locator": { "charStart": 0, "charEnd": 812 },
      "quote": "the sky appears blue because shorter wavelengths are scattered more strongly" }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string | `s1`, `s2`, … in order. |
| `kind` | string | What the scene does, in a word or two, named by the writer (a question, an example, a turn, a recap…). Open: a client shows it as text and never branches on it. At most 40 characters. |
| `durationMs` | number | How long the scene lasts, 1,500 to 60,000. The narration must fit: at most 3.5 spoken words per second of the scene. |
| `visual.kind` | string | What sort of picture it is, named by the writer (a picture from the source, a generated picture, a chart, an animation, a diagram, a clip of the source, a title card…). Open, at most 40 characters. |
| `visual.description` | string | What is on screen, concretely: subjects, layout, what moves and when. Enough for an image model, an editor or an animator to make it without asking. 20 to 700 characters. |
| `narration` | string | Every word the voice says in this scene. May be empty for a scene that is only seen; at least one scene in a video has narration. At most 1,200 characters. |
| `onScreenText` | string[] | Words drawn in the picture (a label, a number, a short title). Empty when there are none. At most 4 entries of at most 120 characters. Not captions: the narration is the captions. |
| `cites` | Cite[] | Where the scene's claims come from. Same shape as a byte's Cite (`byte.md`, "Cite") without `block`. At most 4. |

**Cites.** A scene that states something from the sources cites the passage
it comes from, with a `quote` copied word for word; the validator checks the
quote is in that passage, as it does for bytes and quizzes. A scene with no
cite is allowed (an opening question, a turn to what comes next) and gets a
warning, not an error. A `visual.kind` that uses the source itself (a
picture, a clip) cites that spot (`image` with `assetId`, `moment` with
`startMs`/`endMs`) when extraction recorded one.

## Render

What made the file, and the file itself.

```json
{
  "by": "scenes",
  "maker": { "id": "scenes", "label": "Drawn scenes", "style": { "id": "chalkboard", "label": "Chalkboard" } },
  "storyboard": false,
  "assetId": "a1b2…",
  "url": "/v1/assets/a1b2…",
  "contentType": "video/mp4",
  "width": 1080, "height": 1920, "fps": 30,
  "durationMs": 64000,
  "audio": true,
  "captions": true,
  "scenes": [ { "id": "s1", "startMs": 0, "endMs": 7000 }, … ],
  "renderMs": 1840,
  "madeAt": "2026-11-13T12:00:00.000Z"
}
```

| Field | Type | Rule |
|---|---|---|
| `by` | string | The maker that made the file (`scenes` for a drawn scenes video, Nov 15, 2026; `storyboard` on an old storyboard). Open: a later one has its own id. |
| `maker` | object, optional | Who made it, in words (DECISIONS #54): `{ id, label, style?: { id, label }, agent?: { id, label?, model?, effort? }, voice?: { id, label, real, note? } }`. Players that do not read it lose nothing. |
| `storyboard` | boolean | `true` only on an old storyboard (see "Who makes it"): the file lays out each scene in words instead of showing its finished picture and sound, and says so inside its own frames, small; players draw nothing over it (see "Players"). `false` on every video made now. |
| `assetId`, `url` | string | The MP4 in the asset store; `url` is the engine-relative path. |
| `contentType` | string | `video/mp4`. |
| `width`, `height`, `fps` | number | Of the file. Chosen by the maker, in the payload's `aspect`. |
| `durationMs` | number | Length of the file. |
| `audio` | boolean | Whether the file has a sound track. |
| `captions` | boolean | Whether the narration is in the file as a subtitle track. |
| `scenes` | array | Where each scene sits in the file, by `id`, in order. A player uses these, not the scenes' planned `durationMs`, to follow along: a voiced render may make a scene longer or shorter than planned. |
| `renderMs` | number | Time the render took. |
| `madeAt` | string | ISO 8601 UTC. |

## Who makes it

A video is made by a **maker** (`docs/api.md`, "Video makers"; DECISIONS
#54). The maker today is **drawn scenes**: the person's own agent writes the
video in a scene language inside the scenes service on their computer,
builds each scene, looks at its frames and fixes it, and the service voices
and renders it. Whatever maker made it, the engine checks the scenes it
comes back with in code against the rules in this file (quotes word for word
in their passages, lengths, narration that fits its scene, no passage labels
on screen or in the voice; `engine/src/engines/video/checks.ts`), and keeps
the file. A label word counts only as a pointer at the passages ("as passage
2 says", "the excerpt above"), never as the subject's own word ("final
passage of a bill"), by the one check in `common/labels.ts` that the scenes
service answers `write_beat` with too. A video that comes back rendered and
taken is held back only by a cite untrue to its sources (a passage the item
does not have, no quote, a quote not word for word), which goes back to the
maker once; anything else the checks still find is said in `notes` and the
file is kept. A new maker satisfies this same payload; `render.by` names it.

**Old storyboards.** Until Nov 18, 2026 there was also the **storyboard**
maker: Open Sourcebook's own model wrote the scenes and every scene became a white frame
with its plan written on it (the picture's place as a pale panel holding the
visual's description, on-screen words, the narration as a caption, and, in
the corners, the scene's number, span and the word "Storyboard"), drawn by
the render service (since removed, DECISIONS #71), with no sound. It was taken out (DECISIONS #69): nothing
makes one now. A stored one still plays, with `render.by: "storyboard"` and
`render.storyboard: true`, and says so inside its own frames.

## Settings

| Key | Kind | Default | Meaning |
|---|---|---|---|
| `minutes` | number, 0 to 30 | `0` | Target length. `0` lets the brief and the sources decide. The total may land within a third of it either way. |
| `aspect` | choice | `portrait` | `portrait` (9:16), `landscape` (16:9) or `square` (1:1). An Open Sourcebook video is a tall 9:16 reel (DECISIONS #49); another shape only when the person asks for it. |
| `maker` | choice | `auto` | Which maker makes it (Nov 15, 2026; DECISIONS #54): `auto` (the open pick) or a maker set up here. Offered only when more than one is. The options and their words come from the makers (`docs/api.md`, "Video makers"). A stored `storyboard`, a maker taken out, reads as `auto`. |
| `style` | choice | `auto` | One of the picked maker's styles, each with a picture, or `auto` (the maker picks). Offered only when some maker has styles, and shown only while the maker picked has them (`showWhen`). The drawn scenes maker's come from its service. |
| `agent` | agent | unset (`auto`) | Which agent and model write and check the video (`agent`, `agent:<provider>`, or `agent:<provider>:<model>`). Offered only when a registered maker runs an agent (`usesAgent`). When unset, `settle()` seeds the person's remembered pick (`agent_picks`), or falls back to the maker's work default. |
| `effort` | (paired with `agent`) | unset (`auto`) | Thinking effort (`effortKey` on `agent`). Must belong to the picked provider; switching providers clears incompatible efforts. When unset, falls back to the adapter's work default (`defaultEfforts.work`). |

A drawn scenes video is made in the tall frame only (1080 × 1920); an item
that asks it for another shape is told so before Start. Its scenes satisfy
this contract like any other: `visual.description` is what is on screen in
plain words, narration and on-screen text are what the agent wrote, every
cite quotes its passage word for word (checked by Open Sourcebook), `kind` is the
script's word for the scene or `scene`, `visual.kind` is `drawn scene`, and
`render.scenes` are the real spans in the file.

## Remaking one scene

A made drawn scenes video can have one of its scenes made again, the rest
kept (`api.md`, "Remaking one scene"): the person asks from the talk thread
on it, with a note in their own words. The engine starts a job on the
video's own item that writes a new video output beside the old one; the old
one plays until the new one is ready.

On the scenes service the remake is a new video, `POST
/videos/:id/remake-scene`, copied from the finished one's folder and draft:
every beat, its picture, the sound and the voice's files. The old video is
never changed. The agent's turn is told, in the person's words, which beat
to make again and that the rest stays as it is; it is a new video, so a
fresh viewer watches it once as any other (DECISIONS #106).

| What | Reused or made again |
|---|---|
| The beats not asked for | Kept as they were: words, pictures, cites. The agent may change one only if the person's ask needs it. |
| Speech | Kept for every beat whose words did not change, with its word times: nothing is spoken or paid for again. A beat whose words changed is spoken again. |
| Building each scene on the real word times | Done again for every beat; it is quick. |
| Frames | Every frame is rendered again. The render is one pass over the whole timeline, with the voice, the music and the captions mixed through it and cuts between beats, so reusing the unchanged beats' frames would mean cutting and joining the file, which the renderer does not do cheaply. |

Only a video whose draft is still on the scenes service can have a scene
made again; when it is gone, the engine refuses before anything starts. Its
scenes are named by `payload.scenes[].id`, and the scenes service's beat is
found by its place.

## Players

A video is the video and nothing else: one 9:16 screen (or the file's own
shape), centred, with the player's own controls. No scene list, no panel of
narration or picture, no cards, chips or marks drawn around or over it, for
any video, storyboard or not. The scenes, their narration and cites stay in
the payload and the API; a client reaches them through what every shape has
(the "Brief and sources" drawer), not on the screen. A video's plan item is
ticked done when it plays to the end. On the phone a video has nothing
sideways; down goes to the next thing.

## Versions

| Version | Shape |
|---|---|
| 1 | This file. |
