# Audio payload

**This file is the contract.** It is the shape of `payload` for an output of
format `audio`, schema version 1, and of the scenes service's audio calls
that voice it. The engine writes it, its checks run over it, and the web
(and later the phone) play it. A change here is a change for every client;
it gets a new schema version, never a silent edit.

## In one paragraph

Audio is the fourth thing Open Sourcebook makes, beside video, flashcards and quiz: a
spoken walk-through with no picture, for when the person's eyes and hands are
busy (walking, commuting, cooking). It is an ordered list of **parts**. Each
part is what one voice says, word for word, with the passages it draws on
(each cite quoted word for word, checked like every other made thing), or it
is **background**: the maker's own explanation beyond the sources, never
cited, and said aloud as such, since a listener cannot see a mark. The
person's own agent writes the parts in one turn; the scenes service on their
computer voices them with the same voice videos use, which gives a time for
every word, masters the sound, and the engine keeps the file. How many parts,
how long each is and how long the whole runs come from the sources, the brief
and the item's `minutes` setting, never from a count in code.

## Where it appears

| Where | What |
|---|---|
| `GET /v1/outputs/:id` | `output.type` is `"audio"`, `output.schemaVersion` is `1`, `output.payload` is an Audio. |
| `GET /v1/formats` | `audio` is `ready: true` when it can be made on this computer now. When it cannot (no voice, no scenes service), it is `ready: false` with `problem`: why, in a sentence with what to do (`api.md`, "Formats"). |
| `GET /v1/assets/:id` | The file named by `payload.file.assetId`. Answers byte ranges, so players can seek. |
| An item's kept progress | `{ "time": <seconds> }`, where the person stopped (`api.md`, "Item"). The same shape is a thread's spot. |

## Audio

```json
{
  "schemaVersion": 1,
  "title": "How the river changed its course",
  "about": "Walks through why the river moved east in 1820 and what the town did about it.",
  "parts": [ Part, … ],
  "lengthNote": "It runs about 4 minutes, not 6: the notes hold less on the flood than the brief expected.",
  "file": File
}
```

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | number | `1`. |
| `title` | string | Non-empty, at most 200 characters. |
| `about` | string | What it walks through, in a sentence or two. Shown in lists. |
| `parts` | Part[] | 1 to 60, in speaking order. |
| `lengthNote` | string? | When it runs clearly longer or shorter than the item asked: one plain sentence to the person on why, in the maker's words. |
| `file` | File | The voiced, mastered file. Every output the engine stores has one. |

## Part

```json
{
  "id": "p1",
  "title": "The flood of 1820",
  "text": "Your notes open in the spring of 1820, …",
  "background": false,
  "cites": [ { "sourceId": "src_1", "chunkId": "ch_4", "locator": { "charStart": 120, "charEnd": 480 }, "quote": "the river broke its banks" } ],
  "startMs": 250,
  "endMs": 41230,
  "words": [ { "text": "Your", "startMs": 250, "endMs": 410 }, … ]
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string | `p1`, `p2`, … in order. |
| `title` | string | A few words naming the part, shown as a heading in the transcript and in a thread. Never spoken unless the text says it. |
| `text` | string | Exactly what the voice says, plain words: no markup, no lists, no labels of passages. At most 2,500 characters. |
| `background` | boolean | True when the part is the maker's own explanation, not the sources: it has no cites, and its words say aloud that it is an aside. |
| `cites` | Cite[] | The passages it draws on, each with a few words copied from that passage exactly (checked word for word). At least one unless `background`; none when `background`. At most 6. |
| `startMs`, `endMs` | number | Where the part starts and ends in the file. |
| `words` | Word[] | Every word of `text` in order (split on spaces, punctuation kept on its word), each with its time in the file. Joined with spaces they are `text`. |

A **Cite** is `{ sourceId, chunkId?, locator?, quote }`, the same as a quiz
question's, so it opens the source at the exact words.

A sentence, for the player, is a run of words ending with one whose last
character (before closing quotes or brackets) is `.`, `!` or `?`.

## File

```json
{
  "assetId": "9f2c…",
  "url": "/v1/assets/9f2c…",
  "contentType": "audio/mp4",
  "bytes": 2380512,
  "durationMs": 248300,
  "voice": { "id": "elevenlabs", "label": "ElevenLabs" },
  "loudness": { "lufs": -14.0, "truePeak": -1.4 },
  "madeAt": "2026-11-18T10:12:00.000Z",
  "by": { "maker": "agent", "agent": "claude", "model": "sonnet" }
}
```

AAC in an MP4 container (`.m4a`), mastered with the video's mastering
(-14 LUFS, -1.2 dBTP, two-pass loudness), voice only, with a short quiet
tail.

## The scenes service's audio calls

The scenes service voices audio; the engine calls it with the service's
token, like the video calls (`engine/src/engines/video/scenes/client.ts`).

```
GET  /status                  … "audio": { "ready": true } or { "ready": false, "problem": "…" }
POST /audio                   { id, title, parts: [{ id, text }] }        → 202 { id }   same id again: the same audio
GET  /audio/:id               { id, state, progress, step, failure?, result? }
GET  /audio/:id/file          audio/mp4
POST /audio/:id/stop
```

- `state` is `voicing`, `mastering`, `done`, `failed` or `stopped`; `progress` is 0 to 1; `step` is plain words ("Voicing part 3 of 8").
- `failure` is `{ code, message }`, `code` one of `noVoice`, `voiceRefused`, `stopped`, `error`.
- `result`, once `done`: `{ durationMs, bytes, contentType, voice: { id, label, real }, loudness: { lufs, truePeak }, parts: [{ id, startMs, endMs, words: [{ text, startMs, endMs }] }] }`.
- `audio.ready` in `/status` is the service's own word on whether it can voice audio now: it can when its voice makes sound. When it cannot, `problem` says why and what to do, and the engine shows exactly that.

## Players

- **Web** (`web/src/player/AudioPlayer.tsx`): large play and pause, back 15 seconds, speed; the transcript with the word being said marked, scrolling with it; a tap on a sentence plays from there; each part's cites one tap away, opening the source at the exact words; the time is kept as the item's progress and playing carries on from there; the media session carries the title and the controls while the screen is locked, as far as a web page can. A comfortable column on a desktop, the whole screen on a phone. In the feed it is one screen like the others and starts on a tap. Playing to the end ticks the item done.
- **Phone** (Swift, not built yet): the catalog learns the format from `GET /v1/formats` as it does every format; it needs an audio player that plays `file.url` in the background (`AVAudioSession` playback category, Now Playing info and remote commands), draws `parts[].words` as the transcript, and keeps `{ time }` as the item's progress.
