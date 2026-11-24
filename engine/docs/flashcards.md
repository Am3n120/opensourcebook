# Flashcards payload

**This file is the contract.** It is the shape of `payload` for an output of
format `flashcards`, schema version 3. The engine writes it, its validator
checks it (`engine/src/cards/validate.ts`), and the web and the phone draw it.
A change here is a change for every client; it gets a new schema version,
never a silent edit.

## In one paragraph

A set of flashcards is an ordered list of **cards**. Each card is one screen
and does one job for the learner: a question, term, cue or example on the
front and the answer on the back; a sentence with its key part hidden; a
comparison, steps, a formula, a worked example or a picture to name; a
question that checks itself; or, when the set needs it, one point explained.
The person turns a card over (a tap, a click, space), checks themselves, and
marks it **got it** or **not yet**; a card that asks is marked by the answer.
Missed cards come back in the same sitting and every card comes back on later
days by a spacing rule (`web/src/player/spacing.ts`), until it sticks. What a
card shows is made of the same **blocks** chat replies and older outputs use
(`engine/src/cards/blocks.ts`), and every claim cites the exact words of a
source. The format was the **byte** (bits read one screen at a time) until
Nov 2026; stored bytes are served as cards (see "Old outputs").

## Where it appears

| Where | What |
|---|---|
| `GET /v1/outputs/:id` | `output.type` is `"flashcards"` (also for rows stored as `byte`, `bits` or `read`), `output.schemaVersion` is `3`, `output.payload` is a CardSet. |
| `POST /v1/plans/:id/items/:itemId/progress` | What the person did with each card (see "Progress"). |
| `GET /v1/jobs/:id` (phone wrapper) | `job.cards` is a CardSet. `job.result` stays a version 1 page for the phone build that only knows pages. |

## CardSet

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | number | `3`. |
| `id` | string | A UUID. |
| `title`, `subtitle` | string | Non-empty. |
| `sourceKind` | string | What the source was: `note`, `paper`, `video`, `article`, ... (`BYTE_TYPES` in blocks.ts). |
| `sourceDomain`, `author`, `excerpt`, `durationText` | string | Optional. |
| `tags` | string[] | At most 8. |
| `cards` | Card[] | At least one. |
| `sizeNote` | string | Optional. The maker's own sentence when the set is a different size from the one planned. |
| `upgradedFrom` | number | Only on a set served from an older stored output: that output's schema version. |

## Card

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique in the set and **stable**: the person's progress is kept by it. The engine writes `c1`, `c2`, ... and keeps a card's id when the card is changed or repaired. |
| `kind` | string | One of the registered kinds of card (below). |
| `section` | string | Optional. The group the card belongs to; the player shows it small above the card. |
| `front` | Block[] | 1 to 6 blocks: what the person sees first. |
| `back` | Block[] | Optional, 0 to 6 blocks: what the card turns over to. |
| `cites` | Cite[] | What the card draws on (below); may be empty for a card that only frames. |

**How a card is marked** is read from its sides, so every client agrees and a
kind a client does not know still works (`markOf` in contract.ts):

- a front holding a block that asks (`quiz`, `fillInBlank`, `matching`,
  `orderExercise`, `labelPicture`, `drawLine`) is marked by the answer: right
  is got it, wrong or partly right is not yet;
- a card with a back, or with a `cloze` block on its front, turns over and
  the person marks it got it or not yet;
- any other card is read and not marked, and is not brought back.

### Kinds of card

Kinds are a registry (`engine/src/cards/kinds.ts`): each is one entry with
its words for a person, an example, how it is marked and what it needs of the
card's sides. The makers' tools, the settings form and the planner describe
the kinds from that list; the web player draws a card from its sides and
never names a kind. A new kind is one more entry.

| Kind | What it is | Marked by |
|---|---|---|
| `recall` | Front and back: a question, term, cue or example; the answer. | the person |
| `cloze` | One `cloze` block on the front: a sentence with its key part in `[[...]]`. | the person |
| `compare` | The front asks how things differ; the back is a `table` or `prosCons`. | the person |
| `steps` | The front names a process; the back is `numbered` or `timeline`. | the person |
| `formula` | The front says what it gives; the back holds `math` and its parts. | the person |
| `worked` | A problem on the front; the back works it through. | the person |
| `picture` | A picture from the source and a question on the front; the answer on the back. | the person |
| `ask` | One block that asks, on the front; no back. | the answer |
| `explain` | One point the set needs, read and not marked; no back. | not marked |

### Blocks on a card

Every block type in `engine/src/cards/blocks.ts` has the same fields and
bounds as in chat replies and older outputs, with these differences on a card:

- **Not allowed:** `toc`, `continuation`, `spacer`, `divider`, `hero`,
  `audio`, `audioClip` (page layout, a page header, listening), `flashcards`
  and `reveal` (the card itself turns over), `checklist`, `servingsScaler`
  and `timer` (tools, not study). Older outputs that hold them still draw.
- **`cloze`** `{ "type": "cloze", "text": "... [[hidden part]] ..." }` hides
  each `[[...]]` until the card is turned over. At least one gap.
- **`labelPicture`** `{ "type": "labelPicture", "prompt": "...", "url":
  "/v1/assets/<id>", "caption": "...", "marks": [{ "mark": "A", "answer":
  "..." }], "extra": ["..."], "explanation": "..." }` is a picture from the
  source whose own marks the person names, picking among every mark's answer
  and the extra names, mixed. **`drawLine`** `{ "type": "drawLine", "prompt":
  "...", "axes": { "x": { "min", "max", "step", "label" }, "y": { ... } },
  "line": [[x1, y1], [x2, y2]], "explanation": "..." }` is a grid on which the
  person puts two points; any two different points on the right line are
  right. Both are the quiz's `label` and `graph` kinds on a card
  (`engine/src/cards/asks.ts`): those kinds check them and grade them, on the
  same shared cases as the quiz.
- **At most one main block per side.** Main blocks are the media family
  (`image`, `figure`, `gallery`, `carousel`, `clip`, `video`, `embed`, `map`),
  the chart family (`lineChart`, `barChart`, `areaChart`, `stackedBar`, `pie`,
  `scatter`, `heatmap`, `histogram`, `radar`, `gauge`, `metrics`), `table`,
  `prosCons` and the blocks that ask.
- **`background`** is what the maker adds that is not in the sources; it is
  shown marked as not from the person's source and is never cited.
- A client that meets a block type it does not know skips that block.

### Inline marks

Body text may carry a few inline marks, and every client draws them:
`**bold**`, `*italic*`, `` `code` ``, `[label](https://…)` links and
`$math$`. They are allowed in `text.text`, `quote.text`, `callout.text`,
the items of `bullets`, `numbered`, `checklist` and `prosCons`, and
`definition.definition`, and `cloze.text`; everywhere else text is plain and shown as written.

- Marks do not nest. A marker with no closing partner is shown as typed.
- `$…$` is math only when no space sits just inside the markers, so "$5 and
  $10" stays money.
- A link opens only an `http` or `https` address, and the engine allows only
  URLs from the source or labelled research (evidence-only URLs). Any other
  link shows its label as plain text.
- The engine strips marks from `kicker`, `heading` and `subheading`, which
  are plain.

The phone draws them with `InlineMarkdown` (`ios/OpenSourcebook/Renderer/InlineMarkdown.swift`),
the web with `inlineMarks.ts` (`web/src/player/`); both follow this list.

### Fits one screen: the size of a side

"Fits one screen" is a budget in **units**, not pixels, so the engine can
check it and every client can trust it. Each side of a card may cost at most
**900 units**.

```
cost(side)  = sum of cost(block) over its blocks
cost(block) = max(40, text(block)) + lines(block) + area(block)
```

- `text(block)` is the number of characters in every string the block shows.
  URLs, ids, colours, styles, platforms, languages and numbers are not counted.
- `lines(block)` adds 40 units for every line-like part after the first: list
  items, table rows (with the header), lines of code, options, pairs.
- `area(block)` is 350 for a media or chart block, 120 for `metrics`,
  `linkPreview` and `bigStat`, and 0 for everything else.

A card that does one job is far below this; the budget is a ceiling, not a
target. The engine refuses a side over budget (`side_over_budget`).

## Cite

A citation points at the exact spot the content came from (DECISIONS #39).

```json
{
  "sourceId": "src_…",
  "spot": "passage",
  "chunkId": "chk_…",
  "locator": { "page": 4, "charStart": 1200, "charEnd": 1840 },
  "quote": "a limit exists only when both one-sided limits agree",
  "block": 1
}
```

| Field | Type | Rule |
|---|---|---|
| `sourceId` | string | A source of the item. |
| `spot` | string | What the spot is: `passage`, `paragraph`, `image`, `graph`, `table`, `cell`, `moment`. Open: a client that does not know a value treats it as `passage`. |
| `chunkId` | string | Optional. The stored passage (`source_chunks`) the spot is in. |
| `locator` | object | Optional. Where in the source: `page`, `endPage`, `slide`, `endSlide`, `startMs`, `endMs`, `charStart`, `charEnd`, `cell`, all optional (`engine/docs/api.md`, the same locator sources and ranges use). |
| `assetId` | string | Optional. The harvested asset (`/v1/assets/<assetId>`) for an `image`, `graph` or `moment` spot. |
| `quote` | string | Optional. Words copied exactly from the passage; the validator checks they are there. |
| `block` | number | Optional. Index of the block the cite grounds, counted over the card's front and then its back; absent means the whole card. A cite on the back is shown only once the card is turned over, so it never gives the answer away. |

**What the engine can point at today.** `passage` with `chunkId`, `locator`
and a checked `quote` for text; `image` with `assetId` and `page` for a figure
or picture harvested from the source; `moment` with `startMs` and `endMs` for
a clip of a recording; `cell` when the passage's locator names a sheet cell.
`paragraph`, `graph`, `table` and finer `cell` spots arrive when extraction
records them; the shape above already holds them, so clients can draw every
value now.

## Example

```json
{
  "schemaVersion": 3,
  "id": "6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  "title": "One-sided limits",
  "subtitle": "Week 3 notes",
  "sourceKind": "note",
  "tags": ["calculus"],
  "cards": [
    {
      "id": "c1",
      "kind": "recall",
      "section": "Limits",
      "front": [{ "type": "text", "text": "When does a limit exist at a point?" }],
      "back": [{ "type": "text", "text": "When the **left** and **right** limits both exist and agree." }],
      "cites": [{ "sourceId": "src_1", "spot": "passage", "quote": "a limit exists only when both one-sided limits agree", "block": 1 }]
    },
    {
      "id": "c2",
      "kind": "cloze",
      "section": "Limits",
      "front": [{ "type": "cloze", "text": "The limit from the left uses values of $x$ [[smaller than]] the point." }],
      "cites": [{ "sourceId": "src_1", "spot": "passage", "quote": "values of x smaller than a", "block": 0 }]
    },
    {
      "id": "c3",
      "kind": "ask",
      "section": "Limits",
      "front": [{ "type": "quiz", "question": "The left limit is 2 and the right limit is 3. What is the limit?", "options": ["2", "3", "It does not exist"], "correctIndex": 2, "explanation": "The two sides disagree, so there is no single value." }],
      "cites": [{ "sourceId": "src_1", "spot": "passage", "quote": "a limit exists only when both one-sided limits agree", "block": 0 }]
    }
  ]
}
```

## Progress

What the person did with each card is kept on the plan item, in the item's
progress (`POST /v1/plans/:id/items/:itemId/progress`, at most 16,000
characters), on the person's computer. No account and no other service:

```json
{
  "card": 4,
  "cards": {
    "c1": { "box": 2, "due": 1763712000000, "seen": 3, "missed": 1, "last": 1763452800000 },
    "c2": { "box": 0, "due": 1763453400000, "seen": 1, "missed": 1, "last": 1763452800000 }
  }
}
```

- `card` is where the person stopped (the card's position).
- `cards` holds one memory per card id: its box, when it is next due (ms
  since 1970), how often it was seen and missed, and when it was last marked.
  A card with no memory is new.

**The spacing rule** (`web/src/player/spacing.ts`, one function behind the
`Schedule` interface, so a better schedule can replace it):

- Boxes 0 to 5. "Not yet" puts a card in box 0, due again in 10 minutes;
  in the sitting it comes back after a few more cards.
- "Got it" moves it up one box, due again after the box's gap: 1 day, 3 days,
  7 days, 16 days, 35 days.
- A card is **due** when its due time has passed, and **learned** once it is
  in box 3 or higher (got on three reviews spread over days, in a row).

The feed brings sets with due cards up first, and a set opens on "Review N
due" when it has some. A byte stored before cards kept `{ "bit": n }`; it is
read as where the person stopped.

## Old outputs

Outputs made before this contract are not rewritten in the database. When the
engine reads one, it serves it as a set of cards (`toCardSet` in
`engine/src/cards/upgrade.ts`), a pure function of the stored payload:

- **Version 2, a byte** (`type` `byte`): `{ ..., depth, bits: [{ id, kind,
  section?, blocks, cites }] }`. Each bit becomes one card, in order, with
  ids `c1` to `cn`: a bit holding one `flashcards` card becomes a `recall`
  card (its face on the front, its answer on the back); a bit holding a block
  that asks becomes an `ask` card; any other bit becomes an `explain` card
  holding the bit's blocks as they were. Cites, sections and the size note
  are kept; `depth` is dropped; `upgradedFrom` is `2`.
- **Version 1, a page** (`type` `read` or `bits`): one long page of blocks.
  It is first cut into screens as version 2 cut it (a new screen at each
  heading or when the budget would be passed; long text split at paragraph
  and sentence ends; page layout dropped, `hero` as a `figure`, `audio` as a
  `linkCard`, a deck as one card per screen), then served as above;
  `upgradedFrom` is `1`.

The phone wrapper (`/v1/jobs`) keeps sending `job.result` as a version 1
page made by laying out each card's front and then its back (a cloze's gaps
in bold), so the phone build that only knows pages keeps working.

## Versions

| Version | Shape |
|---|---|
| 1 | One page of blocks (`read`, `bits`; before Nov 12, 2026). Served upgraded, never written. |
| 2 | A byte of bits (`byte`; Nov 12 to 18, 2026). Served upgraded, never written. |
| 3 | This file. |
